import type { ProgressEvent, ProgressPhase } from "./progress-schema";
import type { ProgressReducer, RunProgressState, PhaseState } from "./progress-state";

const TERMINAL_PHASES: ProgressPhase[] = ["completed", "failed", "cancelled"];

function toRunStatus(phase: ProgressPhase): RunProgressState["status"] {
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "cancelled") return "cancelled";
  return "running";
}

function toPhaseStatus(phase: ProgressPhase): PhaseState["status"] {
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "cancelled") return "cancelled";
  return "in_progress";
}

function closeLastTimelineIfNeeded(timeline: PhaseState[], ts: string): void {
  const last = timeline[timeline.length - 1];
  if (!last) return;
  if (last.status === "in_progress") {
    last.status = "completed";
    last.endedAt = ts;
  }
}

export const reducer: ProgressReducer = {
  apply(prev, ev) {
    if (prev && ev.seq <= prev.lastSeq) return prev;

    const next: RunProgressState =
      prev ?? {
        runId: ev.runId,
        sessionId: ev.sessionId,
        currentPhase: ev.phase,
        startedAt: ev.ts,
        updatedAt: ev.ts,
        status: "running",
        lastSeq: ev.seq,
        timeline: [],
        lastMessage: ev.message,
      };

    if (next.currentPhase !== ev.phase) {
      closeLastTimelineIfNeeded(next.timeline, ev.ts);
      next.timeline.push({
        phase: ev.phase,
        startedAt: ev.ts,
        status: toPhaseStatus(ev.phase),
        message: ev.message,
      });
      next.currentPhase = ev.phase;
    } else if (next.timeline.length === 0) {
      next.timeline.push({
        phase: ev.phase,
        startedAt: ev.ts,
        status: toPhaseStatus(ev.phase),
        message: ev.message,
      });
    } else {
      next.timeline[next.timeline.length - 1].message = ev.message;
    }

    next.updatedAt = ev.ts;
    next.lastSeq = ev.seq;
    next.lastMessage = ev.message;
    next.sessionId = ev.sessionId ?? next.sessionId;

    if (ev.metrics) {
      next.stepIndex = ev.metrics.stepIndex ?? next.stepIndex;
      next.stepTotal = ev.metrics.stepTotal ?? next.stepTotal;
      next.percent = ev.metrics.percent ?? next.percent;
      next.etaSec = ev.metrics.etaSec ?? next.etaSec;
    }

    if (ev.level === "error") {
      next.lastError = ev.message;
    }

    if (TERMINAL_PHASES.includes(ev.phase)) {
      next.status = toRunStatus(ev.phase);
      const last = next.timeline[next.timeline.length - 1];
      if (last && !last.endedAt) {
        last.endedAt = ev.ts;
        last.status = toPhaseStatus(ev.phase);
      }
    } else if (next.status === "running") {
      next.status = "running";
    }

    return next;
  },
};
