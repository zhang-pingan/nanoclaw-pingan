import type { RuntimeCenterListResponse } from '../runtime-center-api.js';
import type { RuntimeCenterView } from '../workflow-projection.js';
import type { RuntimeCenterCapacityResponse } from '../../capacity/runtime-center-api.js';

export interface RuntimeCenterRendererState {
  readonly view: RuntimeCenterView;
  readonly mode: 'empty' | 'ready' | 'rebuilding' | 'degraded';
  readonly itemCount: number;
  readonly commandHintsEnabled: boolean;
}

export function createRuntimeCenterRendererState(
  view: RuntimeCenterView,
  response: RuntimeCenterListResponse,
): RuntimeCenterRendererState {
  const projectionState = response.projection.state;
  return {
    view,
    mode:
      projectionState === 'ready' && response.items.length === 0
        ? 'empty'
        : projectionState,
    itemCount: response.items.length,
    commandHintsEnabled: projectionState === 'ready',
  };
}

export interface RuntimeCenterCapacityRendererState {
  readonly mode: 'uninitialized' | 'ready' | 'pending' | 'degraded';
  readonly canSubmitReplacement: boolean;
  readonly capacityRevision: number | null;
  readonly hasBackpressure: boolean;
  readonly hasOverCapacity: boolean;
}

export function createRuntimeCenterCapacityRendererState(
  response: RuntimeCenterCapacityResponse,
): RuntimeCenterCapacityRendererState {
  const watcherState = String(response.watcher.state);
  const mode =
    response.current === null
      ? 'uninitialized'
      : watcherState !== 'current'
        ? 'degraded'
        : response.pending !== null
          ? 'pending'
          : 'ready';
  return {
    mode,
    canSubmitReplacement: mode === 'ready',
    capacityRevision: response.current?.capacity_revision ?? null,
    hasBackpressure: Object.values(response.telemetry.backpressure).some(
      (value) => value === true,
    ),
    hasOverCapacity: Object.values(response.telemetry.over_capacity).some(
      (value) => value === true,
    ),
  };
}
