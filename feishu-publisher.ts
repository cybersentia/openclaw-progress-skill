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

  async sendMessage(params: { conversationId: string; content: Record<string, unknown> }) {
    try {
      const token = await this.getTenantAccessToken();
      const body = {
        receive_id: params.conversationId,
        msg_type: "interactive",
        content: JSON.stringify(params.content),
      };

      const result = await this.request<FeishuMessageResponse>({
        method: "POST",
        path: `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(this.receiveIdType)}`,
        token,
        body,
      });

      if (result.code !== 0 || !result.data?.message_id) {
        return { ok: false as const, error: `feishu send failed: code=${result.code} msg=${result.msg}` };
      }

      return { ok: true as const, messageId: result.data.message_id };
    } catch (error) {
      return { ok: false as const, error: this.toErrorMessage(error) };
    }
  }

  async updateMessage(params: { messageId: string; content: Record<string, unknown> }) {
    try {
      const token = await this.getTenantAccessToken();
      const body = {
        content: JSON.stringify(params.content),
      };

      const result = await this.request<FeishuMessageResponse>({
        method: "PATCH",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}`,
        token,
        body,
      });

      if (result.code !== 0) {
        return { ok: false as const, error: `feishu update failed: code=${result.code} msg=${result.msg}` };
      }

      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: this.toErrorMessage(error) };
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpireAt - 60_000) {
      return this.token;
    }

    const response = await this.request<FeishuTokenResponse>({
      method: "POST",
      path: "/open-apis/auth/v3/tenant_access_token/internal",
      body: {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
    });

    if (response.code !== 0 || !response.tenant_access_token) {
      throw new Error(`feishu auth failed: code=${response.code} msg=${response.msg}`);
    }

    this.token = response.tenant_access_token;
    const expireSec = response.expire ?? 7200;
    this.tokenExpireAt = now + expireSec * 1000;

    return this.token;
  }

  private async request<T>(params: {
    method: "POST" | "PATCH";
    path: string;
    body: Record<string, unknown>;
    token?: string;
  }): Promise<T> {
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
      if (!response.ok) {
        throw new Error(`http ${response.status}: ${text}`);
      }

      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
