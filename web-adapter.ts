import type { AdapterContext, AdapterEmitResult, ProgressAdapter } from "./progress-adapter";
import type { ProgressEvent } from "./progress-schema";
import type { RunProgressState } from "./progress-state";

export interface WebPublisher {
  publish(
    channel: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
}

function buildProgressCard(state: RunProgressState) {
  return {
    runId: state.runId,
    status: state.status,
    currentPhase: state.currentPhase,
    lastMessage: state.lastMessage,
    progress: {
      stepIndex: state.stepIndex,
      stepTotal: state.stepTotal,
      percent: state.percent,
      etaSec: state.etaSec,
    },
    updatedAt: state.updatedAt,
  };
}

export class WebAdapter implements ProgressAdapter {
  readonly name = "web";
  readonly capabilities = ["streaming", "edit_message", "rich_card", "markdown"] as const;

  constructor(private readonly publisher: WebPublisher) {}

  async init(): Promise<void> {}

  async emitEvent(
    ctx: AdapterContext,
    ev: ProgressEvent,
    state: RunProgressState
  ): Promise<AdapterEmitResult> {
    const payload = {
      type: "progress.event",
      conversationId: ctx.conversationId,
      channel: ctx.channel,
      event: ev,
      state: buildProgressCard(state),
    };

    const r = await this.publisher.publish(`conv:${ctx.conversationId}`, payload);
    return r.ok ? { ok: true, messageId: r.messageId } : { ok: false, error: r.error };
  }

  async emitCheckpoint(ctx: AdapterContext, state: RunProgressState): Promise<AdapterEmitResult> {
    const payload = {
      type: "progress.checkpoint",
      conversationId: ctx.conversationId,
      channel: ctx.channel,
      state: buildProgressCard(state),
      text: `[${state.currentPhase}] ${state.lastMessage}`,
    };

    const r = await this.publisher.publish(`conv:${ctx.conversationId}`, payload);
    return r.ok ? { ok: true, messageId: r.messageId } : { ok: false, error: r.error };
  }

  async emitFinal(ctx: AdapterContext, state: RunProgressState): Promise<AdapterEmitResult> {
    const payload = {
      type: "progress.final",
      conversationId: ctx.conversationId,
      channel: ctx.channel,
      state: buildProgressCard(state),
      summary: {
        status: state.status,
        lastMessage: state.lastMessage,
        lastError: state.lastError,
      },
    };

    const r = await this.publisher.publish(`conv:${ctx.conversationId}`, payload);
    return r.ok ? { ok: true, messageId: r.messageId } : { ok: false, error: r.error };
  }

  async close(): Promise<void> {}
}
