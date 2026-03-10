import {
  DefaultProgressHub,
  type ProgressEvent,
  type AdapterContext,
  reducer,
  WebAdapter,
  type WebPublisher,
} from "./index";

/**
 * 示例 publisher：实际项目里替换成你们的 WS/SSE 广播器
 */
class ConsolePublisher implements WebPublisher {
  async publish(channel: string, payload: Record<string, unknown>) {
    // eslint-disable-next-line no-console
    console.log(`[publish] ${channel}`, JSON.stringify(payload));
    return { ok: true as const, messageId: `${Date.now()}` };
  }
}

const publisher = new ConsolePublisher();
const webAdapter = new WebAdapter(publisher);

const hub = new DefaultProgressHub({
  reducer,
  adapters: [webAdapter],
  throttle: {
    minEmitIntervalMs: 1000,
    checkpointPhases: new Set([
      "planning",
      "tool_end",
      "retrying",
      "finalizing",
    ]),
    heartbeatIntervalMs: 5000,
  },
});

const ctx: AdapterContext = {
  channel: "web",
  conversationId: "conv_demo_001",
  userId: "user_demo",
  locale: "zh-CN",
};

function nowIso(): string {
  return new Date().toISOString();
}

async function feed(ev: ProgressEvent): Promise<void> {
  await hub.onEvent(ctx, ev);
}

export async function runDemo() {
  const runId = "run_demo_001";

  await feed({
    eventId: `${runId}:1`,
    runId,
    sessionId: "sess_demo",
    seq: 1,
    ts: nowIso(),
    stream: "lifecycle",
    phase: "init",
    level: "info",
    message: "开始执行任务",
  });

  await feed({
    eventId: `${runId}:2`,
    runId,
    sessionId: "sess_demo",
    seq: 2,
    ts: nowIso(),
    stream: "lifecycle",
    phase: "planning",
    level: "info",
    message: "正在规划执行步骤",
    metrics: { stepIndex: 1, stepTotal: 4, percent: 25 },
  });

  await feed({
    eventId: `${runId}:3`,
    runId,
    sessionId: "sess_demo",
    seq: 3,
    ts: nowIso(),
    stream: "tool",
    phase: "tool_start",
    level: "info",
    message: "开始调用工具：search_code",
    metrics: { stepIndex: 2, stepTotal: 4, percent: 50 },
    refs: [{ kind: "tool", name: "search_code" }],
  });

  await feed({
    eventId: `${runId}:4`,
    runId,
    sessionId: "sess_demo",
    seq: 4,
    ts: nowIso(),
    stream: "tool",
    phase: "tool_end",
    level: "info",
    message: "工具调用完成：search_code",
    metrics: { stepIndex: 3, stepTotal: 4, percent: 75 },
    refs: [{ kind: "tool", name: "search_code" }],
  });

  await feed({
    eventId: `${runId}:5`,
    runId,
    sessionId: "sess_demo",
    seq: 5,
    ts: nowIso(),
    stream: "lifecycle",
    phase: "completed",
    level: "info",
    message: "任务执行完成",
    metrics: { stepIndex: 4, stepTotal: 4, percent: 100 },
  });

  return hub.getState(runId);
}

// 允许直接运行：ts-node example-bootstrap.ts
if (require.main === module) {
  runDemo()
    .then((state) => {
      // eslint-disable-next-line no-console
      console.log("[final-state]", state);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exitCode = 1;
    });
}
