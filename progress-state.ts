import type { ProgressEvent, ProgressPhase } from "./progress-schema";

export interface PhaseState {
  phase: ProgressPhase;
  startedAt: string;
  endedAt?: string;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  message?: string;
}

export interface RunProgressState {
  runId: string;
  sessionId?: string;
  currentPhase: ProgressPhase;
  startedAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  lastSeq: number;

  timeline: PhaseState[];
  lastMessage: string;

  stepIndex?: number;
  stepTotal?: number;
  percent?: number;
  etaSec?: number;

  lastError?: string;
}

export interface ProgressReducer {
  apply(prev: RunProgressState | undefined, ev: ProgressEvent): RunProgressState;
}
