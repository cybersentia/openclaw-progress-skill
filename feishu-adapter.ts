import type { AdapterContext, AdapterEmitResult, ProgressAdapter } from "./progress-adapter";
import type { ProgressEvent } from "./progress-schema";
import type { RunProgressState } from "./progress-state";

export interface FeishuPublisher {
  sendMessage(params: {
    conversationId: string;
    content: Record<string, unknown>;
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;

  updateMessage(params: {
    messageId: string;
    content: Record<string, unknown>;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

function durationFromTimestamps(startedAt: string, endedAt?: string): number | undefined {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return undefined;
  const endMs = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

function renderCard(state: RunProgressState, event?: ProgressEvent): Record<string, unknown> {
  const title = `任务进度 · ${state.status}`;
  const progressText =
    state.stepIndex !== undefined && state.stepTotal !== undefined && state.stepTotal > 0
      ? `${state.stepIndex}/${state.stepTotal}`
      : state.percent !== undefined
      ? `${state.percent}%`
      : state.status === "completed"
      ? "已完成"
      : state.status === "failed"
      ? "失败"
      : state.status === "cancelled"
      ? "已取消"
      : state.currentPhase === "tool_start" || state.currentPhase === "tool_update" || state.currentPhase === "tool_end"
      ? "已进入执行阶段"
      : "进行中";

  const runningElapsedMs = durationFromTimestamps(state.startedAt);
  const terminalElapsedMs = durationFromTimestamps(state.startedAt, state.updatedAt);
  const displayDurationMs =
    state.status === "running"
      ? runningElapsedMs
      : state.durationMs !== undefined && state.durationMs >= 0
      ? state.durationMs
      : terminalElapsedMs;

  const durationText =
    displayDurationMs !== undefined && displayDurationMs >= 0 ? `${(displayDurationMs / 1000).toFixed(1)}s` : "--";
  const durationLabel = state.status === "running" ? "已耗时" : "总耗时";

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**阶段**: ${state.currentPhase}\n**进度**: ${progressText}\n**${durationLabel}**: ${durationText}`,
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**最新信息**: ${state.lastMessage}`,
        },
      },
      event
        ? {
            tag: "note",
            elements: [
              {
                tag: "plain_text",
                content: `event=${event.stream}/${event.phase} seq=${event.seq}`,
              },
            ],
          }
        : {
            tag: "note",
            elements: [{ tag: "plain_text", content: `runId=${state.runId}` }],
          },
    ],
  };
}

export class FeishuAdapter implements ProgressAdapter {
  readonly name = "feishu";
  readonly capabilities = ["streaming", "edit_message", "rich_card", "markdown"] as const;

  private readonly messageByRun = new Map<string, string>();

  constructor(private readonly publisher: FeishuPublisher) {}

  async init(): Promise<void> {}

  bindRunMessage(runId: string, messageId: string): void {
    this.messageByRun.set(runId, messageId);
  }

  snapshotRunMessages(): Record<string, string> {
    return Object.fromEntries(this.messageByRun.entries());
  }

  private async sendAndBind(
    conversationId: string,
    state: RunProgressState,
    card: Record<string, unknown>,
  ): Promise<AdapterEmitResult> {
    const sent = await this.publisher.sendMessage({
      conversationId,
      content: card,
    });
    if (!sent.ok) return { ok: false, error: sent.error };
    this.messageByRun.set(state.runId, sent.messageId);
    return { ok: true, messageId: sent.messageId };
  }

  async emitEvent(
    ctx: AdapterContext,
    ev: ProgressEvent,
    state: RunProgressState
  ): Promise<AdapterEmitResult> {
    const existingMessageId = this.messageByRun.get(state.runId);
    const card = renderCard(state, ev);

    if (existingMessageId) {
      const updated = await this.publisher.updateMessage({
        messageId: existingMessageId,
        content: card,
      });
      if (updated.ok) return { ok: true, messageId: existingMessageId };

      // update 失败时回退成新发一条，避免 run 卡死在“永远更新失败”状态
      return this.sendAndBind(ctx.conversationId, state, card);
    }

    return this.sendAndBind(ctx.conversationId, state, card);
  }

  async emitCheckpoint(ctx: AdapterContext, state: RunProgressState): Promise<AdapterEmitResult> {
    const existingMessageId = this.messageByRun.get(state.runId);
    const card = renderCard(state);

    if (existingMessageId) {
      const updated = await this.publisher.updateMessage({
        messageId: existingMessageId,
        content: card,
      });
      if (updated.ok) return { ok: true, messageId: existingMessageId };

      return this.sendAndBind(ctx.conversationId, state, card);
    }

    return this.sendAndBind(ctx.conversationId, state, card);
  }

  async emitFinal(ctx: AdapterContext, state: RunProgressState): Promise<AdapterEmitResult> {
    const result = await this.emitCheckpoint(ctx, state);
    if (result.ok) {
      this.messageByRun.delete(state.runId);
    }
    return result;
  }

  async close(): Promise<void> {
    this.messageByRun.clear();
  }
}
