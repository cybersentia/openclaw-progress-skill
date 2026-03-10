import type { ProgressEvent } from "./progress-schema";
import type { RunProgressState } from "./progress-state";

export type AdapterCapability =
  | "streaming"
  | "edit_message"
  | "rich_card"
  | "thread"
  | "markdown";

export interface AdapterContext {
  channel: string;
  conversationId: string;
  userId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterEmitResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ProgressAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapability[];

  init?(): Promise<void>;

  emitEvent(
    ctx: AdapterContext,
    ev: ProgressEvent,
    state: RunProgressState
  ): Promise<AdapterEmitResult>;

  emitCheckpoint(
    ctx: AdapterContext,
    state: RunProgressState
  ): Promise<AdapterEmitResult>;

  emitFinal(
    ctx: AdapterContext,
    state: RunProgressState
  ): Promise<AdapterEmitResult>;

  close?(): Promise<void>;
}
