import type { ProgressEvent } from "./progress-schema";
import type { ProgressReducer, RunProgressState } from "./progress-state";
import type { AdapterContext, ProgressAdapter } from "./progress-adapter";

export interface ThrottlePolicy {
  minEmitIntervalMs: number;
  checkpointPhases: Set<string>;
  heartbeatIntervalMs: number;
}

export interface ProgressHubOptions {
  reducer: ProgressReducer;
  adapters: ProgressAdapter[];
  throttle: ThrottlePolicy;
}

export interface ProgressHub {
  onEvent(ctx: AdapterContext, ev: ProgressEvent): Promise<void>;
  getState(runId: string): RunProgressState | undefined;
}

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);

interface RunEmitMeta {
  lastEventAt?: number;
  lastCheckpointAt?: number;
  lastHeartbeatAt?: number;
}

interface RouteKey {
  runId: string;
  conversationId: string;
  channel: string;
}

function buildRouteKey(route: RouteKey): string {
  return `${route.runId}::${route.conversationId}::${route.channel}`;
}

function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

export class DefaultProgressHub implements ProgressHub {
  private readonly states = new Map<string, RunProgressState>();
  private readonly emitMeta = new Map<string, RunEmitMeta>();

  constructor(private readonly options: ProgressHubOptions) {}

  getState(runId: string): RunProgressState | undefined {
    return this.states.get(runId);
  }

  async onEvent(ctx: AdapterContext, ev: ProgressEvent): Promise<void> {
    const prev = this.states.get(ev.runId);
    const next = this.options.reducer.apply(prev, ev);
    this.states.set(ev.runId, next);

    const routeKey = buildRouteKey({
      runId: ev.runId,
      conversationId: ctx.conversationId,
      channel: ctx.channel,
    });

    const meta = this.emitMeta.get(routeKey) ?? {};
    const now = Date.now();
    const adapters = this.options.adapters;

    const terminal = isTerminalPhase(ev.phase);
    const checkpoint = this.options.throttle.checkpointPhases.has(ev.phase);

    if (terminal) {
      await Promise.all(adapters.map((a) => a.emitFinal(ctx, next)));
      meta.lastEventAt = now;
      meta.lastCheckpointAt = now;
      meta.lastHeartbeatAt = now;
      this.emitMeta.set(routeKey, meta);
      return;
    }

    const canEmitEvent =
      meta.lastEventAt === undefined ||
      now - meta.lastEventAt >= this.options.throttle.minEmitIntervalMs;

    if (canEmitEvent) {
      await Promise.all(adapters.map((a) => a.emitEvent(ctx, ev, next)));
      meta.lastEventAt = now;
    }

    const canEmitCheckpoint =
      checkpoint &&
      (meta.lastCheckpointAt === undefined ||
        now - meta.lastCheckpointAt >= this.options.throttle.minEmitIntervalMs);

    if (canEmitCheckpoint) {
      await Promise.all(adapters.map((a) => a.emitCheckpoint(ctx, next)));
      meta.lastCheckpointAt = now;
    }

    const canEmitHeartbeat =
      meta.lastHeartbeatAt === undefined ||
      now - meta.lastHeartbeatAt >= this.options.throttle.heartbeatIntervalMs;

    if (canEmitHeartbeat) {
      // 心跳沿用 checkpoint 渠道，避免新增 adapter 接口
      await Promise.all(adapters.map((a) => a.emitCheckpoint(ctx, next)));
      meta.lastHeartbeatAt = now;
    }

    this.emitMeta.set(routeKey, meta);
  }
}
