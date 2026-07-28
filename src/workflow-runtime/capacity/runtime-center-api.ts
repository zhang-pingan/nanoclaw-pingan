import {
  parseCapacityAdminCommand,
  prepareCapacityChangeCAP0CAP1,
  type CapacityAuthenticatedInvocation,
  type CapacityCommandPersistence,
  type PreparedCapacityChange,
} from './admin-gateway.js';
import {
  CapacitySnapshotPublisher,
  CapacitySnapshotWatcher,
} from './publication.js';
import type {
  DeploymentRuntimeCapacityPublication,
  DeploymentRuntimeCapacitySnapshot,
  ReplaceDeploymentCapacityCommand,
} from '../contracts/capacity-control-plane-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import { G5RuntimeError } from '../runtime/graph-store.js';

export const RUNTIME_CENTER_CAPACITY_ROUTES = {
  current: 'GET /api/runtime-admin/capacity',
  changes: 'GET /api/runtime-admin/capacity/changes',
  replace: 'POST /api/runtime-admin/capacity/changes',
} as const;

export interface RuntimeCenterCapacityTelemetry {
  readonly usage: JsonObject;
  readonly backpressure: JsonObject;
  readonly over_capacity: JsonObject;
}

export interface RuntimeCenterCapacityCurrent extends JsonObject {
  readonly capacity_revision: number;
  readonly capacity_change_id: string;
  readonly config_hash: Sha256Hash;
  readonly publication_hash: Sha256Hash;
  readonly snapshot: DeploymentRuntimeCapacitySnapshot;
}

export interface RuntimeCenterCapacityResponse {
  readonly route: typeof RUNTIME_CENTER_CAPACITY_ROUTES.current;
  readonly current: RuntimeCenterCapacityCurrent | null;
  readonly pending: JsonObject | null;
  readonly watcher: JsonObject;
  readonly telemetry: RuntimeCenterCapacityTelemetry;
}

export interface RuntimeCenterCapacityChangesResponse {
  readonly route: typeof RUNTIME_CENTER_CAPACITY_ROUTES.changes;
  readonly changes: readonly JsonObject[];
  readonly events: readonly JsonObject[];
}

export interface RuntimeCenterCapacityChangeResponse {
  readonly route: typeof RUNTIME_CENTER_CAPACITY_ROUTES.replace;
  readonly result: PreparedCapacityChange;
  readonly current: RuntimeCenterCapacityResponse;
}

interface CapacityHeadRow extends Record<string, unknown> {
  current_capacity_revision: number | null;
  current_change_id: string | null;
  current_config_hash: Sha256Hash | null;
  current_publication_hash: Sha256Hash | null;
  pending_change_id: string | null;
}

interface CurrentCommandRow extends Record<string, unknown> {
  command_id: string;
  assigned_capacity_revision: number;
  assigned_change_id: string;
  proposed_capacity_json: string;
  proposed_config_hash: Sha256Hash;
}

function readHead(store: WorkflowRuntimeStore): CapacityHeadRow | undefined {
  return store.queryOne<CapacityHeadRow>(
    `SELECT current_capacity_revision, current_change_id, current_config_hash,
            current_publication_hash, pending_change_id
       FROM runtime_capacity_head WHERE singleton_key = 1`,
    [],
  );
}

function readCurrent(
  store: WorkflowRuntimeStore,
  head: CapacityHeadRow | undefined,
): RuntimeCenterCapacityCurrent | null {
  if (
    !head ||
    head.current_capacity_revision === null ||
    head.current_change_id === null ||
    head.current_config_hash === null ||
    head.current_publication_hash === null
  )
    return null;
  const command = store.queryOne<CurrentCommandRow>(
    `SELECT command_id, assigned_capacity_revision, assigned_change_id,
            proposed_capacity_json, proposed_config_hash
       FROM runtime_capacity_admin_commands
      WHERE assigned_capacity_revision = ? AND assigned_change_id = ?`,
    [head.current_capacity_revision, head.current_change_id],
  );
  if (
    !command ||
    command.assigned_capacity_revision !== head.current_capacity_revision ||
    command.assigned_change_id !== head.current_change_id ||
    command.proposed_config_hash !== head.current_config_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Runtime Center Capacity head has no exact Command lineage',
    );
  const snapshot = JSON.parse(
    command.proposed_capacity_json,
  ) as DeploymentRuntimeCapacitySnapshot;
  if (snapshot.config_hash !== head.current_config_hash)
    throw new G5RuntimeError(
      'integrity_violation',
      'Runtime Center Capacity snapshot differs from the committed head',
    );
  return {
    capacity_revision: head.current_capacity_revision,
    capacity_change_id: head.current_change_id,
    config_hash: head.current_config_hash,
    publication_hash: head.current_publication_hash,
    snapshot: structuredClone(snapshot),
  };
}

function watcherState(
  publication: Readonly<DeploymentRuntimeCapacityPublication> | null,
  current: RuntimeCenterCapacityCurrent | null,
): JsonObject {
  if (!publication)
    return {
      state: current ? 'unpublished' : 'uninitialized',
      capacity_revision: null,
      capacity_change_id: null,
      publication_hash: null,
    };
  const matches =
    current !== null &&
    publication.capacity_revision === current.capacity_revision &&
    publication.capacity_change_id === current.capacity_change_id &&
    publication.capacity.config_hash === current.config_hash &&
    publication.publication_hash === current.publication_hash;
  return {
    state: matches ? 'current' : 'mismatch',
    capacity_revision: publication.capacity_revision,
    capacity_change_id: publication.capacity_change_id,
    publication_hash: publication.publication_hash,
  };
}

export class RuntimeCenterCapacityApi {
  constructor(
    private readonly store: WorkflowRuntimeStore,
    private readonly publisher: CapacitySnapshotPublisher,
    private readonly watcher: CapacitySnapshotWatcher,
    private readonly readTelemetry: () => RuntimeCenterCapacityTelemetry,
  ) {}

  getCapacity(): RuntimeCenterCapacityResponse {
    const head = readHead(this.store);
    const current = readCurrent(this.store, head);
    const pending = head?.pending_change_id
      ? (this.store.queryOne<JsonObject>(
          `SELECT command_id, assigned_capacity_revision AS capacity_revision,
                  assigned_change_id AS capacity_change_id,
                  proposed_config_hash AS config_hash
             FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?`,
          [head.pending_change_id],
        ) ?? null)
      : null;
    return {
      route: RUNTIME_CENTER_CAPACITY_ROUTES.current,
      current,
      pending,
      watcher: watcherState(this.watcher.current(), current),
      telemetry: structuredClone(this.readTelemetry()),
    };
  }

  getChanges(): RuntimeCenterCapacityChangesResponse {
    const changes = this.store.queryAll<JsonObject>(
      `SELECT command_id, command_type, assigned_capacity_revision,
              assigned_change_id, proposed_config_hash, request_hash,
              reason_code, canonical_result_value_id, canonical_result_hash,
              created_at_ms, finalized_at_ms
         FROM runtime_capacity_admin_commands
        ORDER BY assigned_capacity_revision ASC, command_id COLLATE BINARY`,
      [],
    );
    const events = this.store.queryAll<JsonObject>(
      `SELECT event_seq, change_id, command_id, capacity_revision, event_type,
              config_hash, publication_hash, previous_event_hash, event_hash,
              created_at_ms
         FROM runtime_capacity_change_events ORDER BY event_seq ASC`,
      [],
    );
    return {
      route: RUNTIME_CENTER_CAPACITY_ROUTES.changes,
      changes: structuredClone(changes),
      events: structuredClone(events),
    };
  }

  postChange(
    candidateCommand: unknown,
    invocation: CapacityAuthenticatedInvocation,
    persistence: CapacityCommandPersistence,
    nowMs: number,
  ): RuntimeCenterCapacityChangeResponse {
    const command = parseCapacityAdminCommand(candidateCommand);
    if (command.command_type !== 'replace_deployment_capacity')
      throw new G5RuntimeError(
        'forbidden_surface',
        'Runtime Center Capacity POST accepts only full replacement Commands',
      );
    const result = prepareCapacityChangeCAP0CAP1(
      this.store,
      command as ReplaceDeploymentCapacityCommand,
      invocation,
      persistence,
      nowMs,
    );
    if (result.disposition === 'authentication_rejected')
      throw new G5RuntimeError(
        'forbidden_surface',
        'Runtime Center Capacity POST requires an authenticated Human session',
      );
    if (result.publication) {
      this.publisher.installCAP2(this.store, result.publication, nowMs);
      this.publisher.commitHeadCAP3(this.store, result.publication, nowMs);
      this.watcher.publishCAP4(
        this.store,
        this.publisher,
        persistence.resultSchema,
        nowMs,
      );
    }
    return {
      route: RUNTIME_CENTER_CAPACITY_ROUTES.replace,
      result,
      current: this.getCapacity(),
    };
  }
}
