import type { AdapterContext, AdapterEmitResult, ProgressAdapter } from "./progress-adapter";
import type { ProgressEvent } from "./progress-schema";
import type { RunProgressState } from "./progress-state";

export interface FeishuPublisher {
  /**
   * 发送新消息，返回平台消息 ID
   */
  sendMessage(params: {
    conversationId: string;
    content: Record<string, unknown>;
  }): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;

  /**
   * 更新已有消息（飞书支持按 messageId 更新卡片）
   */
  updateMessage(params: {
    messageId: string;
    content: Record<string, unknown>;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

function renderCard(state: RunProgressState, event?: ProgressEvent): Record<string, unknown> {
  const title = `任务进度 · ${state.status}`;
  const progressText =
    state.stepIndex && state.stepTotal
      ? `${state.stepIndex}/${state.stepTotal}`
      : state.percent !== undefined
      ? `${state.percent}%`
      : "--";

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
          content: `**阶段**: ${state.currentPhase}\n**进度**: ${progressText}`,
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
      return updated.ok ? { ok: true, messageId: existingMessageId } : { ok: false, error: updated.error };
    }

    const sent = await this.publisher.sendMessage({
      conversationId: ctx.conversationId,
      content: card,
    });

    if (!sent.ok) return { ok: false, error: sent.error };

    this.messageByRun.set(state.runId, sent.messageId);
    return { ok: true, messageId: sent.messageId };
  }

  async emitCheckpoint(ctx: AdapterContext, state: RunProgressState): Promise<AdapterEmitResult> {
    const existingMessageId = this.messageByRun.get(state.runId);
    const card = renderCard(state);

    if (existingMessageId) {
      const updated = await this.publisher.updateMessage({
        messageId: existingMessageId,
        content: card,
      });
      return updated.ok ? { ok: true, messageId: existingMessageId } : { ok: false, error: updated.error };
    }

    const sent = await this.publisher.sendMessage({
      conversationId: ctx.conversationId,
      content: card,
    });

    if (!sent.ok) return { ok: false, error: sent.error };

    this.messageByRun.set(state.runId, sent.messageId);
    return { ok: true, messageId: sent.messageId };
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
