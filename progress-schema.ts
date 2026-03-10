export type ProgressStream = "lifecycle" | "tool" | "assistant" | "system";

export type ProgressPhase =
  | "init"
  | "context_load"
  | "planning"
  | "model_resolve"
  | "prompt_build"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "retrying"
  | "compacting"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type ProgressLevel = "debug" | "info" | "warn" | "error";

export interface ProgressRef {
  kind: "file" | "url" | "tool" | "message" | "run";
  id?: string;
  name?: string;
  path?: string;
  url?: string;
}

export interface ProgressMetrics {
  stepIndex?: number;
  stepTotal?: number;
  percent?: number;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  etaSec?: number;
  retryCount?: number;
}

export interface ProgressEvent {
  eventId: string;
  runId: string;
  sessionId?: string;
  seq: number;
  ts: string;

  stream: ProgressStream;
  phase: ProgressPhase;
  level: ProgressLevel;
  message: string;

  metrics?: ProgressMetrics;
  refs?: ProgressRef[];
  tags?: string[];
  data?: Record<string, unknown>;
}
