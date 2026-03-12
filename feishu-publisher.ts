import type { FeishuPublisher } from "./feishu-adapter";

type FeishuTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

type FeishuMessageResponse = {
  code: number;
  msg: string;
  data?: {
    message_id?: string;
  };
};

type FeishuHttpResult = {
  status: number;
  text: string;
};

type CardPayloadMode = "raw-card" | "wrapped-card";

export interface FeishuHttpPublisherOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  receiveIdType?: "chat_id" | "open_id" | "union_id" | "email" | "user_id";
  timeoutMs?: number;
}

export class FeishuHttpPublisher implements FeishuPublisher {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly receiveIdType: NonNullable<FeishuHttpPublisherOptions["receiveIdType"]>;
  private readonly timeoutMs: number;

  private token: string | null = null;
  private tokenExpireAt = 0;

  constructor(options: FeishuHttpPublisherOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
    this.receiveIdType = options.receiveIdType ?? "chat_id";
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async sendMessage(params: {
    conversationId: string;
    receiveIdType?: "chat_id" | "open_id";
    content: Record<string, unknown>;
  }) {
    try {
      const token = await this.getTenantAccessToken();

      const firstTry = await this.sendWithMode({
        token,
        conversationId: params.conversationId,
        receiveIdType: params.receiveIdType,
        content: params.content,
        mode: "raw-card",
      });
      if (firstTry.ok) return firstTry;

      if (!this.shouldRetryWithAlternateCardMode(firstTry.error)) {
        return firstTry;
      }

      const retry = await this.sendWithMode({
        token,
        conversationId: params.conversationId,
        receiveIdType: params.receiveIdType,
        content: params.content,
        mode: "wrapped-card",
      });
      if (retry.ok) return retry;

      return {
        ok: false as const,
        error: `feishu send failed after retry: primary=${firstTry.error}; retry=${retry.error}`,
      };
    } catch (error) {
      return { ok: false as const, error: this.toErrorMessage(error) };
    }
  }

  async updateMessage(params: { messageId: string; content: Record<string, unknown> }) {
    try {
      const token = await this.getTenantAccessToken();

      const firstTry = await this.updateWithMode({
        token,
        messageId: params.messageId,
        content: params.content,
        mode: "raw-card",
      });
      if (firstTry.ok) return firstTry;

      if (!this.shouldRetryWithAlternateCardMode(firstTry.error)) {
        return firstTry;
      }

      const retry = await this.updateWithMode({
        token,
        messageId: params.messageId,
        content: params.content,
        mode: "wrapped-card",
      });
      if (retry.ok) return retry;

      return {
        ok: false as const,
        error: `feishu update failed after retry: primary=${firstTry.error}; retry=${retry.error}`,
      };
    } catch (error) {
      return { ok: false as const, error: this.toErrorMessage(error) };
    }
  }

  private async sendWithMode(params: {
    token: string;
    conversationId: string;
    receiveIdType?: "chat_id" | "open_id";
    content: Record<string, unknown>;
    mode: CardPayloadMode;
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
    const body = {
      receive_id: params.conversationId,
      msg_type: "interactive",
      content: JSON.stringify(this.formatCardContent(params.content, params.mode)),
    };

    const receiveIdType = params.receiveIdType ?? this.receiveIdType;
    const raw = await this.requestRaw({
      method: "POST",
      path: `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      token: params.token,
      body,
    });

    const parsed = this.parseMessageResponse(raw.text);
    if (raw.status < 200 || raw.status >= 300) {
      return {
        ok: false,
        error: `mode=${params.mode} http=${raw.status} body=${raw.text}`,
      };
    }
    if (!parsed || parsed.code !== 0 || !parsed.data?.message_id) {
      return {
        ok: false,
        error: `mode=${params.mode} code=${parsed?.code ?? "unknown"} msg=${parsed?.msg ?? raw.text}`,
      };
    }

    return { ok: true, messageId: parsed.data.message_id };
  }

  private async updateWithMode(params: {
    token: string;
    messageId: string;
    content: Record<string, unknown>;
    mode: CardPayloadMode;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const body = {
      content: JSON.stringify(this.formatCardContent(params.content, params.mode)),
    };

    const raw = await this.requestRaw({
      method: "PATCH",
      path: `/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}`,
      token: params.token,
      body,
    });

    const parsed = this.parseMessageResponse(raw.text);
    if (raw.status < 200 || raw.status >= 300) {
      return {
        ok: false,
        error: `mode=${params.mode} http=${raw.status} body=${raw.text}`,
      };
    }
    if (!parsed || parsed.code !== 0) {
      return {
        ok: false,
        error: `mode=${params.mode} code=${parsed?.code ?? "unknown"} msg=${parsed?.msg ?? raw.text}`,
      };
    }

    return { ok: true };
  }

  private formatCardContent(content: Record<string, unknown>, mode: CardPayloadMode): Record<string, unknown> {
    if (mode === "wrapped-card") {
      return { card: content };
    }
    return content;
  }

  private shouldRetryWithAlternateCardMode(errorText: string): boolean {
    const lower = errorText.toLowerCase();
    return (
      lower.includes("230099") ||
      lower.includes("200621") ||
      lower.includes("parse card json err")
    );
  }

  private parseMessageResponse(text: string): FeishuMessageResponse | null {
    try {
      return JSON.parse(text) as FeishuMessageResponse;
    } catch {
      return null;
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpireAt - 60_000) {
      return this.token;
    }

    const raw = await this.requestRaw({
      method: "POST",
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      body: {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
    });

    const response = this.parseTokenResponse(raw.text);
    if (raw.status < 200 || raw.status >= 300 || !response || response.code !== 0 || !response.tenant_access_token) {
      throw new Error(
        `feishu auth failed: http=${raw.status} code=${response?.code ?? "unknown"} msg=${response?.msg ?? raw.text}`,
      );
    }

    this.token = response.tenant_access_token;
    const expireSec = response.expire ?? 7200;
    this.tokenExpireAt = now + expireSec * 1000;

    return this.token;
  }

  private parseTokenResponse(text: string): FeishuTokenResponse | null {
    try {
      return JSON.parse(text) as FeishuTokenResponse;
    } catch {
      return null;
    }
  }

  private async requestRaw(params: {
    method: "POST" | "PATCH";
    path: string;
    body: Record<string, unknown>;
    token?: string;
  }): Promise<FeishuHttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
      };
      if (params.token) {
        headers.Authorization = `Bearer ${params.token}`;
      }

      const response = await fetch(`${this.baseUrl}${params.path}`, {
        method: params.method,
        headers,
        body: JSON.stringify(params.body),
        signal: controller.signal,
      });

      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
