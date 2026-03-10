import { DefaultProgressHub } from "./progress-hub";
import { FeishuAdapter } from "./feishu-adapter";
import { FeishuHttpPublisher } from "./feishu-publisher";
import { reducer } from "./reducer";
import type { AdapterContext } from "./progress-adapter";
import type { ProgressEvent } from "./progress-schema";

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  on: (hookName: string, handler: (event: any, ctx: any) => void | Promise<void>) => void;
};

type Route = {
  conversationId: string;
  channel: string;
};

type SkillConfig = {
  feishu?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    baseUrl?: string;
    receiveIdType?: "chat_id" | "open_id" | "union_id" | "email" | "user_id";
    defaultConversationId?: string;
    timeoutMs?: number;
  };
  throttle?: {
    minEmitIntervalMs?: number;
    heartbeatIntervalMs?: number;
  };
};

const FEISHU_CHANNEL = "feishu";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseConfig(raw: unknown): SkillConfig {
  const root = asObject(raw);
  const feishuRaw = asObject(root.feishu);
  const throttleRaw = asObject(root.throttle);

  return {
    feishu: {
      enabled: feishuRaw.enabled === undefined ? true : Boolean(feishuRaw.enabled),
      appId: asString(feishuRaw.appId),
      appSecret: asString(feishuRaw.appSecret),
      baseUrl: asString(feishuRaw.baseUrl),
      receiveIdType: (asString(feishuRaw.receiveIdType) as
        | "chat_id"
        | "open_id"
        | "union_id"
        | "email"
        | "user_id"
        | undefined) ?? "chat_id",
      defaultConversationId: asString(feishuRaw.defaultConversationId),
      timeoutMs: asNumber(feishuRaw.timeoutMs),
    },
    throttle: {
      minEmitIntervalMs: asNumber(throttleRaw.minEmitIntervalMs),
      heartbeatIntervalMs: asNumber(throttleRaw.heartbeatIntervalMs),
    },
  };
}

function nextSeq(seqByRun: Map<string, number>, runId: string): number {
  const next = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, next);
  return next;
}

function buildEvent(params: {
  runId: string;
  seq: number;
  stream: ProgressEvent["stream"];
  phase: ProgressEvent["phase"];
  level: ProgressEvent["level"];
  message: string;
  sessionId?: string;
  data?: Record<string, unknown>;
  metrics?: ProgressEvent["metrics"];
}): ProgressEvent {
  return {
    eventId: `${params.runId}:${params.seq}`,
    runId: params.runId,
    sessionId: params.sessionId,
    seq: params.seq,
    ts: new Date().toISOString(),
    stream: params.stream,
    phase: params.phase,
    level: params.level,
    message: params.message,
    data: params.data,
    metrics: params.metrics,
  };
}

function resolveRunId(value?: string, fallbackPrefix = "run"): string {
  return value && value.length > 0
    ? value
    : `${fallbackPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractSessionKeys(event: unknown, ctx: unknown): string[] {
  const result = new Set<string>();
  const e = asObject(event);
  const c = asObject(ctx);
  const m = asObject(e.metadata);

  for (const candidate of [
    asString(c.sessionKey),
    asString(c.sessionId),
    asString(e.sessionKey),
    asString(e.sessionId),
    asString(m.sessionKey),
    asString(m.sessionId),
  ]) {
    if (candidate) result.add(candidate);
  }

  return [...result];
}

export default {
  id: "openclaw-progress-plugin",
  name: "OpenClaw Progress Plugin",
  register(api: PluginApi) {
    const config = parseConfig(api.pluginConfig);
    const feishu = config.feishu;

    if (!feishu?.enabled) {
      api.logger.info("[progress-plugin] disabled by config");
      return;
    }

    if (!feishu.appId || !feishu.appSecret) {
      api.logger.warn("[progress-plugin] missing feishu.appId/appSecret, plugin disabled");
      return;
    }

    const publisher = new FeishuHttpPublisher({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      baseUrl: feishu.baseUrl,
      receiveIdType: feishu.receiveIdType,
      timeoutMs: feishu.timeoutMs,
    });

    const hub = new DefaultProgressHub({
      reducer,
      adapters: [new FeishuAdapter(publisher)],
      throttle: {
        minEmitIntervalMs: config.throttle?.minEmitIntervalMs ?? 1000,
        checkpointPhases: new Set(["planning", "tool_end", "retrying", "finalizing"]),
        heartbeatIntervalMs: config.throttle?.heartbeatIntervalMs ?? 5000,
      },
    });

    const routeBySessionKey = new Map<string, Route>();
    const runBySessionKey = new Map<string, string>();
    const seqByRun = new Map<string, number>();

    const resolveRoute = (sessionKeys: string[]): Route | undefined => {
      for (const key of sessionKeys) {
        const route = routeBySessionKey.get(key);
        if (route) return route;
      }
      if (feishu.defaultConversationId) {
        return {
          channel: FEISHU_CHANNEL,
          conversationId: feishu.defaultConversationId,
        };
      }
      return undefined;
    };

    const resolveRun = (sessionKeys: string[], candidateRunId?: string): string => {
      if (candidateRunId) {
        for (const key of sessionKeys) {
          runBySessionKey.set(key, candidateRunId);
        }
        return candidateRunId;
      }
      for (const key of sessionKeys) {
        const runId = runBySessionKey.get(key);
        if (runId) return runId;
      }
      const generated = resolveRunId(undefined);
      for (const key of sessionKeys) {
        runBySessionKey.set(key, generated);
      }
      return generated;
    };

    const emit = async (ctx: AdapterContext, event: ProgressEvent) => {
      try {
        await hub.onEvent(ctx, event);
      } catch (error) {
        api.logger.error(`[progress-plugin] hub emit failed: ${String(error)}`);
      }
    };

    api.on("message_received", async (event, ctx) => {
      const channelId = asString(asObject(ctx).channelId);
      if (channelId !== FEISHU_CHANNEL) {
        return;
      }
      const conversationId = asString(asObject(ctx).conversationId);
      if (!conversationId) {
        return;
      }
      const route: Route = { channel: FEISHU_CHANNEL, conversationId };
      for (const key of extractSessionKeys(event, ctx)) {
        routeBySessionKey.set(key, route);
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      const sessionKeys = extractSessionKeys(event, ctx);
      const route = resolveRoute(sessionKeys);
      if (!route) return;

      const runId = resolveRun(sessionKeys, asString(asObject(event).runId));
      const seq = nextSeq(seqByRun, runId);
      const toolName = asString(asObject(event).toolName) ?? asString(asObject(ctx).toolName) ?? "unknown_tool";

      await emit(
        {
          channel: route.channel,
          conversationId: route.conversationId,
        },
        buildEvent({
          runId,
          seq,
          stream: "tool",
          phase: "tool_start",
          level: "info",
          message: `正在调用工具：${toolName}`,
          sessionId: asString(asObject(ctx).sessionId),
          data: {
            toolName,
            toolCallId: asString(asObject(event).toolCallId),
          },
        }),
      );
    });

    api.on("after_tool_call", async (event, ctx) => {
      const sessionKeys = extractSessionKeys(event, ctx);
      const route = resolveRoute(sessionKeys);
      if (!route) return;

      const runId = resolveRun(sessionKeys, asString(asObject(event).runId));
      const seq = nextSeq(seqByRun, runId);
      const toolName = asString(asObject(event).toolName) ?? asString(asObject(ctx).toolName) ?? "unknown_tool";
      const error = asString(asObject(event).error);

      await emit(
        {
          channel: route.channel,
          conversationId: route.conversationId,
        },
        buildEvent({
          runId,
          seq,
          stream: "tool",
          phase: error ? "failed" : "tool_end",
          level: error ? "error" : "info",
          message: error ? `工具执行失败：${toolName}` : `工具执行完成：${toolName}`,
          sessionId: asString(asObject(ctx).sessionId),
          data: {
            toolName,
            toolCallId: asString(asObject(event).toolCallId),
            error,
          },
          metrics: {
            durationMs: asNumber(asObject(event).durationMs),
          },
        }),
      );
    });

    api.on("agent_end", async (event, ctx) => {
      const sessionKeys = extractSessionKeys(event, ctx);
      const route = resolveRoute(sessionKeys);
      if (!route) return;

      const runId = resolveRun(sessionKeys);
      const seq = nextSeq(seqByRun, runId);
      const success = Boolean(asObject(event).success);

      await emit(
        {
          channel: route.channel,
          conversationId: route.conversationId,
        },
        buildEvent({
          runId,
          seq,
          stream: "lifecycle",
          phase: success ? "completed" : "failed",
          level: success ? "info" : "error",
          message: success ? "任务执行完成" : "任务执行失败",
          sessionId: asString(asObject(ctx).sessionId),
          data: {
            error: asString(asObject(event).error),
          },
          metrics: {
            durationMs: asNumber(asObject(event).durationMs),
          },
        }),
      );

      for (const key of sessionKeys) {
        runBySessionKey.delete(key);
      }
      seqByRun.delete(runId);
    });

    api.logger.info("[progress-plugin] plugin registered");
  },
};
