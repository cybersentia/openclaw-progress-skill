import fs from "node:fs";
import path from "node:path";
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
  on: (hookName: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => void;
  resolvePath?: (input: string) => string;
};

type Route = {
  conversationId: string;
  channel: string;
  updatedAt: number;
};

type SkillConfig = {
  feishu?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    baseUrl?: string;
    defaultConversationId?: string;
    timeoutMs?: number;
    stateFile?: string;
    runMessageTtlMs?: number;
  };
  throttle?: {
    minEmitIntervalMs?: number;
    heartbeatIntervalMs?: number;
  };
};

type PersistedState = {
  version: 1;
  updatedAt: number;
  runMessages: Array<{ runId: string; messageId: string; updatedAt: number }>;
  routes: Array<{ sessionKey: string; conversationId: string; channel: string; updatedAt: number }>;
  runs: Array<{ sessionKey: string; runId: string; updatedAt: number }>;
};

const FEISHU_CHANNEL = "feishu";
const FEISHU_RECEIVE_ID_TYPE = "chat_id" as const;
const DEFAULT_STATE_FILE = ".openclaw-progress-plugin-state.json";
const DEFAULT_RUN_MESSAGE_TTL_MS = 30 * 60 * 1000;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function normalizeProgressMetrics(raw: unknown): ProgressEvent["metrics"] | undefined {
  const obj = asObject(raw);
  const stepIndex = firstNumber(obj.stepIndex, obj.step_index, obj.currentStep, obj.current_step);
  const stepTotal = firstNumber(obj.stepTotal, obj.step_total, obj.totalSteps, obj.total_steps);
  const percent = firstNumber(obj.percent, obj.progressPercent, obj.progress_percent);
  const etaSec = firstNumber(obj.etaSec, obj.eta_sec);

  if (stepIndex === undefined && stepTotal === undefined && percent === undefined && etaSec === undefined) {
    return undefined;
  }

  return {
    stepIndex,
    stepTotal,
    percent:
      percent !== undefined
        ? Math.max(0, Math.min(100, Math.round(percent)))
        : stepIndex !== undefined && stepTotal !== undefined && stepTotal > 0
        ? Math.max(0, Math.min(100, Math.round((stepIndex / stepTotal) * 100)))
        : undefined,
    etaSec,
  };
}

function extractProgressMetrics(event: unknown, ctx: unknown): ProgressEvent["metrics"] | undefined {
  const e = asObject(event);
  const c = asObject(ctx);
  const eData = asObject(e.data);
  const cData = asObject(c.data);

  return (
    normalizeProgressMetrics(e.metrics) ??
    normalizeProgressMetrics(e.progress) ??
    normalizeProgressMetrics(eData.metrics) ??
    normalizeProgressMetrics(eData.progress) ??
    normalizeProgressMetrics(c.metrics) ??
    normalizeProgressMetrics(c.progress) ??
    normalizeProgressMetrics(cData.metrics) ??
    normalizeProgressMetrics(cData.progress) ??
    normalizeProgressMetrics(e) ??
    normalizeProgressMetrics(c)
  );
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
      defaultConversationId: asString(feishuRaw.defaultConversationId),
      timeoutMs: asNumber(feishuRaw.timeoutMs),
      stateFile: asString(feishuRaw.stateFile),
      runMessageTtlMs: asNumber(feishuRaw.runMessageTtlMs),
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

function extractFeishuConversationId(event: unknown, ctx: unknown): string | undefined {
  const e = asObject(event);
  const c = asObject(ctx);
  const eData = asObject(e.data);
  const cData = asObject(c.data);
  const eMessage = asObject(e.message);
  const cMessage = asObject(c.message);

  return (
    asString(e.chatId) ??
    asString(e.chat_id) ??
    asString(eData.chatId) ??
    asString(eData.chat_id) ??
    asString(eMessage.chatId) ??
    asString(eMessage.chat_id) ??
    asString(c.chatId) ??
    asString(c.chat_id) ??
    asString(cData.chatId) ??
    asString(cData.chat_id) ??
    asString(cMessage.chatId) ??
    asString(cMessage.chat_id) ??
    asString(c.conversationId)
  );
}

function ensureSessionKeys(sessionKeys: string[], conversationId?: string): { keys: string[]; fallbackUsed: boolean } {
  if (sessionKeys.length > 0) return { keys: sessionKeys, fallbackUsed: false };
  if (!conversationId) return { keys: [], fallbackUsed: false };
  return { keys: [`conv:${conversationId}`], fallbackUsed: true };
}

function routeBridgeKey(conversationId?: string): string | undefined {
  return conversationId ? `conv:${conversationId}` : undefined;
}

function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys)];
}

function withRouteBridgeKeys(sessionKeys: string[], conversationId?: string): string[] {
  const bridge = routeBridgeKey(conversationId);
  return bridge ? uniqueKeys([...sessionKeys, bridge]) : sessionKeys;
}

function resolveStateFilePath(api: PluginApi, configuredPath?: string): string {
  const raw = configuredPath ?? DEFAULT_STATE_FILE;
  if (path.isAbsolute(raw)) return raw;
  if (api.resolvePath) return api.resolvePath(raw);
  return path.resolve(process.cwd(), raw);
}

function loadPersistedState(filePath: string): PersistedState | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedState(filePath: string, state: PersistedState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), "utf-8");
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

    const stateFilePath = resolveStateFilePath(api, feishu.stateFile);
    const runMessageTtlMs = feishu.runMessageTtlMs ?? DEFAULT_RUN_MESSAGE_TTL_MS;

    const publisher = new FeishuHttpPublisher({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      baseUrl: feishu.baseUrl,
      receiveIdType: FEISHU_RECEIVE_ID_TYPE,
      timeoutMs: feishu.timeoutMs,
    });

    const feishuAdapter = new FeishuAdapter(publisher);
    const hub = new DefaultProgressHub({
      reducer,
      adapters: [feishuAdapter],
      throttle: {
        minEmitIntervalMs: config.throttle?.minEmitIntervalMs ?? 1000,
        checkpointPhases: new Set(["planning", "tool_end", "retrying", "finalizing"]),
        heartbeatIntervalMs: config.throttle?.heartbeatIntervalMs ?? 5000,
      },
    });

    const routeBySessionKey = new Map<string, Route>();
    const runBySessionKey = new Map<string, string>();
    const seqByRun = new Map<string, number>();

    const restore = loadPersistedState(stateFilePath);
    if (restore) {
      const now = Date.now();
      for (const entry of restore.runMessages) {
        if (now - entry.updatedAt <= runMessageTtlMs) {
          feishuAdapter.bindRunMessage(entry.runId, entry.messageId);
        }
      }
      for (const entry of restore.routes) {
        routeBySessionKey.set(entry.sessionKey, {
          conversationId: entry.conversationId,
          channel: entry.channel,
          updatedAt: entry.updatedAt,
        });
      }
      for (const entry of restore.runs) {
        runBySessionKey.set(entry.sessionKey, entry.runId);
      }
      api.logger.info(`[progress-plugin] restored persisted state from ${stateFilePath}`);
    }

    const persist = () => {
      const now = Date.now();
      const runMessages = Object.entries(feishuAdapter.snapshotRunMessages())
        .map(([runId, messageId]) => ({ runId, messageId, updatedAt: now }))
        .filter((entry) => now - entry.updatedAt <= runMessageTtlMs);
      const routes = [...routeBySessionKey.entries()].map(([sessionKey, route]) => ({
        sessionKey,
        conversationId: route.conversationId,
        channel: route.channel,
        updatedAt: route.updatedAt,
      }));
      const runs = [...runBySessionKey.entries()].map(([sessionKey, runId]) => ({
        sessionKey,
        runId,
        updatedAt: now,
      }));
      writePersistedState(stateFilePath, {
        version: 1,
        updatedAt: now,
        runMessages,
        routes,
        runs,
      });
    };

    const resolveRoute = (sessionKeys: string[], conversationId?: string): Route | undefined => {
      const lookupKeys = withRouteBridgeKeys(sessionKeys, conversationId);
      for (const key of lookupKeys) {
        const route = routeBySessionKey.get(key);
        if (route) return route;
      }
      if (feishu.defaultConversationId) {
        return {
          channel: FEISHU_CHANNEL,
          conversationId: feishu.defaultConversationId,
          updatedAt: Date.now(),
        };
      }
      return undefined;
    };

    const bindRoute = (sessionKeys: string[], conversationId: string): void => {
      const route: Route = { channel: FEISHU_CHANNEL, conversationId, updatedAt: Date.now() };
      for (const key of withRouteBridgeKeys(sessionKeys, conversationId)) {
        routeBySessionKey.set(key, route);
      }
    };

    const resolveRun = (sessionKeys: string[], conversationId: string | undefined, candidateRunId?: string): string => {
      const bindKeys = withRouteBridgeKeys(sessionKeys, conversationId);
      if (candidateRunId) {
        for (const key of bindKeys) {
          runBySessionKey.set(key, candidateRunId);
        }
        return candidateRunId;
      }
      for (const key of bindKeys) {
        const runId = runBySessionKey.get(key);
        if (runId) {
          for (const bindKey of bindKeys) {
            runBySessionKey.set(bindKey, runId);
          }
          return runId;
        }
      }
      const generated = resolveRunId(undefined);
      for (const key of bindKeys) {
        runBySessionKey.set(key, generated);
      }
      return generated;
    };

    const emit = async (ctx: AdapterContext, event: ProgressEvent) => {
      try {
        await hub.onEvent(ctx, event);
        persist();
      } catch (error) {
        api.logger.error(
          `[progress-plugin] hub emit failed: runId=${event.runId} seq=${event.seq} phase=${event.phase} err=${String(error)}`,
        );
      }
    };

    api.on("message_received", async (event, ctx) => {
      const channelId = asString(asObject(ctx).channelId);
      if (channelId !== FEISHU_CHANNEL) {
        return;
      }
      const conversationId = extractFeishuConversationId(event, ctx);
      if (!conversationId) {
        api.logger.warn("[progress-plugin] skip route bind: missing conversationId in message_received");
        return;
      }

      const sessionKeysInfo = ensureSessionKeys(extractSessionKeys(event, ctx), conversationId);
      if (sessionKeysInfo.keys.length === 0) {
        api.logger.warn(`[progress-plugin] skip route bind: no session keys for conversationId=${conversationId}`);
        return;
      }

      bindRoute(sessionKeysInfo.keys, conversationId);

      api.logger.info(
        `[progress-plugin] route bound: conversationId=${conversationId} sessionKeys=${withRouteBridgeKeys(sessionKeysInfo.keys, conversationId).length} fallback=${sessionKeysInfo.fallbackUsed}`,
      );
      persist();
    });

    api.on("before_tool_call", async (event, ctx) => {
      const eventRunId = asString(asObject(event).runId);
      const eventConversationId = extractFeishuConversationId(event, ctx);
      const sessionKeysInfo = ensureSessionKeys(extractSessionKeys(event, ctx), eventConversationId);
      const route = resolveRoute(sessionKeysInfo.keys, eventConversationId);
      if (!route) {
        api.logger.warn(
          `[progress-plugin] skip before_tool_call: route not found runId=${eventRunId ?? "unknown"} sessionKeys=${sessionKeysInfo.keys.length} fallback=${sessionKeysInfo.fallbackUsed}`,
        );
        return;
      }

      bindRoute(sessionKeysInfo.keys, route.conversationId);
      const runId = resolveRun(sessionKeysInfo.keys, route.conversationId, eventRunId);
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
          metrics: extractProgressMetrics(event, ctx),
        }),
      );
    });

    api.on("after_tool_call", async (event, ctx) => {
      const eventRunId = asString(asObject(event).runId);
      const eventConversationId = extractFeishuConversationId(event, ctx);
      const sessionKeysInfo = ensureSessionKeys(extractSessionKeys(event, ctx), eventConversationId);
      const route = resolveRoute(sessionKeysInfo.keys, eventConversationId);
      if (!route) {
        api.logger.warn(
          `[progress-plugin] skip after_tool_call: route not found runId=${eventRunId ?? "unknown"} sessionKeys=${sessionKeysInfo.keys.length} fallback=${sessionKeysInfo.fallbackUsed}`,
        );
        return;
      }

      bindRoute(sessionKeysInfo.keys, route.conversationId);
      const runId = resolveRun(sessionKeysInfo.keys, route.conversationId, eventRunId);
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
          phase: "tool_end",
          level: error ? "error" : "info",
          message: error ? `工具执行失败：${toolName}` : `工具执行完成：${toolName}`,
          sessionId: asString(asObject(ctx).sessionId),
          data: {
            toolName,
            toolCallId: asString(asObject(event).toolCallId),
            error,
          },
          metrics: {
            ...extractProgressMetrics(event, ctx),
            durationMs: asNumber(asObject(event).durationMs),
          },
        }),
      );
    });

    api.on("agent_end", async (event, ctx) => {
      const eventConversationId = extractFeishuConversationId(event, ctx);
      const sessionKeysInfo = ensureSessionKeys(extractSessionKeys(event, ctx), eventConversationId);
      const route = resolveRoute(sessionKeysInfo.keys, eventConversationId);
      if (!route) {
        api.logger.warn(
          `[progress-plugin] skip agent_end: route not found sessionKeys=${sessionKeysInfo.keys.length} fallback=${sessionKeysInfo.fallbackUsed}`,
        );
        return;
      }

      bindRoute(sessionKeysInfo.keys, route.conversationId);
      const runId = resolveRun(sessionKeysInfo.keys, route.conversationId);
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
            ...extractProgressMetrics(event, ctx),
            durationMs: asNumber(asObject(event).durationMs),
          },
        }),
      );

      for (const key of sessionKeysInfo.keys) {
        runBySessionKey.delete(key);
      }
      seqByRun.delete(runId);
      persist();
    });

    api.logger.info("[progress-plugin] plugin registered");
  },
};
