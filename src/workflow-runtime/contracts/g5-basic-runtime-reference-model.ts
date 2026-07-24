export type ReferenceNodeKind =
  | 'static'
  | 'delegation'
  | 'system'
  | 'wait'
  | 'join'
  | 'terminal';

export type ReferenceNodePhase =
  | 'pending'
  | 'ready'
  | 'active'
  | 'waiting'
  | 'retry_wait'
  | 'terminal';

export interface ReferenceNode {
  readonly id: string;
  readonly kind: ReferenceNodeKind;
  phase: ReferenceNodePhase;
  terminalStatus: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | null;
  attemptNo: number;
  waitWinner: string | null;
}

export interface ReferenceEdge {
  readonly from: string;
  readonly to: string;
  readonly statuses: readonly ReferenceNode['terminalStatus'][];
  resolution: 'unresolved' | 'taken' | 'not_taken';
}

export interface ReferenceFactEvent {
  readonly sequence: number;
  readonly key: string;
  readonly kind: string;
}

export type ReferenceTruth = 'true' | 'false' | 'unknown';

export type ReferenceTrigger =
  | { readonly type: 'root' }
  | {
      readonly type: 'all';
      readonly edgeIds: readonly string[];
    }
  | {
      readonly type: 'any';
      readonly edgeIds: readonly string[];
    }
  | {
      readonly type: 'quorum';
      readonly edgeIds: readonly string[];
      readonly minimum: number;
    }
  | {
      readonly type: 'expression';
      readonly expression: ReferenceTriggerExpression;
    };

export type ReferenceTriggerExpression =
  | {
      readonly op: 'edge_is';
      readonly edgeId: string;
      readonly state: 'taken' | 'not_taken';
    }
  | {
      readonly op: 'and' | 'or';
      readonly args: readonly ReferenceTriggerExpression[];
    }
  | { readonly op: 'not'; readonly arg: ReferenceTriggerExpression };

function referenceExpressionTruth(
  expression: ReferenceTriggerExpression,
  edges: ReadonlyMap<string, 'unresolved' | 'taken' | 'not_taken'>,
): ReferenceTruth {
  if (expression.op === 'edge_is') {
    const state = edges.get(expression.edgeId);
    if (state === undefined) throw new Error('reference_trigger_edge_missing');
    return state === 'unresolved'
      ? 'unknown'
      : state === expression.state
        ? 'true'
        : 'false';
  }
  if (expression.op === 'not') {
    const value = referenceExpressionTruth(expression.arg, edges);
    return value === 'unknown' ? value : value === 'true' ? 'false' : 'true';
  }
  const values = expression.args.map((arg) =>
    referenceExpressionTruth(arg, edges),
  );
  if (expression.op === 'and') {
    if (values.includes('false')) return 'false';
    return values.includes('unknown') ? 'unknown' : 'true';
  }
  if (values.includes('true')) return 'true';
  return values.includes('unknown') ? 'unknown' : 'false';
}

export function evaluateReferenceTrigger(
  trigger: ReferenceTrigger,
  resolutions: Readonly<Record<string, 'unresolved' | 'taken' | 'not_taken'>>,
): ReferenceTruth {
  const edges = new Map(Object.entries(resolutions));
  if (trigger.type === 'root') return edges.size === 0 ? 'true' : 'false';
  if (trigger.type === 'expression')
    return referenceExpressionTruth(trigger.expression, edges);
  const states = trigger.edgeIds.map((edgeId) => {
    const state = edges.get(edgeId);
    if (state === undefined) throw new Error('reference_trigger_edge_missing');
    return state;
  });
  const taken = states.filter((state) => state === 'taken').length;
  const unresolved = states.filter((state) => state === 'unresolved').length;
  if (trigger.type === 'all')
    return states.includes('not_taken')
      ? 'false'
      : unresolved > 0
        ? 'unknown'
        : 'true';
  if (trigger.type === 'any')
    return taken > 0 ? 'true' : unresolved > 0 ? 'unknown' : 'false';
  return taken >= trigger.minimum
    ? 'true'
    : taken + unresolved < trigger.minimum
      ? 'false'
      : 'unknown';
}

export class G5BasicRuntimeReferenceModel {
  readonly nodes: Map<string, ReferenceNode>;
  readonly edges: ReferenceEdge[];
  readonly facts = new Map<string, ReferenceFactEvent>();
  readonly events: ReferenceFactEvent[] = [];
  readonly retrySchedules = new Map<
    string,
    {
      readonly nodeId: string;
      readonly nextAttemptNo: number;
      consumed: boolean;
    }
  >();
  readonly blockers = new Map<
    string,
    { readonly severity: 'action_required' | 'quarantine' }
  >();
  operationalState: 'healthy' | 'action_required' | 'quarantined' = 'healthy';
  #sequence = 0;

  constructor(
    nodes: readonly Omit<
      ReferenceNode,
      'phase' | 'terminalStatus' | 'attemptNo' | 'waitWinner'
    >[],
    edges: readonly Omit<ReferenceEdge, 'resolution'>[],
  ) {
    this.nodes = new Map(
      nodes.map((node) => [
        node.id,
        {
          ...node,
          phase: 'pending',
          terminalStatus: null,
          attemptNo: 0,
          waitWinner: null,
        },
      ]),
    );
    this.edges = edges.map((edge) => ({ ...edge, resolution: 'unresolved' }));
    for (const node of this.nodes.values()) {
      if (!this.edges.some((edge) => edge.to === node.id)) this.ready(node.id);
    }
  }

  private append(key: string, kind: string): ReferenceFactEvent {
    const prior = this.facts.get(key);
    if (prior) return prior;
    const record = { sequence: ++this.#sequence, key, kind };
    this.facts.set(key, record);
    this.events.push(record);
    return record;
  }

  ready(nodeId: string): void {
    const node = this.requiredNode(nodeId);
    if (node.phase !== 'pending') return;
    node.phase = node.kind === 'wait' ? 'waiting' : 'ready';
    this.append(`node-ready:${nodeId}`, 'node_ready');
  }

  activate(nodeId: string): void {
    const node = this.requiredNode(nodeId);
    if (node.phase !== 'ready') throw new Error('node_not_ready');
    if (
      node.kind === 'terminal' ||
      node.kind === 'join' ||
      node.kind === 'static'
    )
      return;
    node.phase = node.kind === 'wait' ? 'waiting' : 'active';
    if (node.kind !== 'wait') node.attemptNo += 1;
  }

  complete(
    nodeId: string,
    status: NonNullable<ReferenceNode['terminalStatus']>,
  ): 'accepted' | 'duplicate' {
    const node = this.requiredNode(nodeId);
    if (node.phase === 'terminal') {
      if (node.terminalStatus !== status)
        throw new Error('terminal_result_conflict');
      return 'duplicate';
    }
    node.phase = 'terminal';
    node.terminalStatus = status;
    this.append(`node-terminal:${nodeId}`, 'node_terminal');
    for (const edge of this.edges.filter(
      (candidate) => candidate.from === nodeId,
    )) {
      edge.resolution = edge.statuses.includes(status) ? 'taken' : 'not_taken';
      this.append(`edge:${edge.from}:${edge.to}`, 'control_edge_resolved');
    }
    this.fixedPoint();
    return 'accepted';
  }

  resolveWait(
    nodeId: string,
    providerEventId: string,
  ): 'accepted' | 'duplicate' | 'late' {
    const node = this.requiredNode(nodeId);
    if (node.kind !== 'wait') throw new Error('not_wait_node');
    if (node.waitWinner === providerEventId) return 'duplicate';
    if (node.waitWinner !== null || node.phase === 'terminal') return 'late';
    node.waitWinner = providerEventId;
    this.append(`wait:${nodeId}:${providerEventId}`, 'wait_resolved');
    this.complete(nodeId, 'succeeded');
    return 'accepted';
  }

  qualityDecision(
    nodeId: string,
    decision: 'pass' | 'needs_revision' | 'fail',
    maxAttempts: number,
  ): 'terminal' | 'retry_scheduled' | 'exhausted' {
    const node = this.requiredNode(nodeId);
    if (node.attemptNo === 0) node.attemptNo = 1;
    if (decision === 'pass') {
      this.complete(nodeId, 'succeeded');
      return 'terminal';
    }
    if (decision === 'fail') {
      this.complete(nodeId, 'failed');
      return 'terminal';
    }
    if (node.attemptNo >= maxAttempts) {
      this.complete(nodeId, 'failed');
      return 'exhausted';
    }
    const id = `retry:${nodeId}:${node.attemptNo + 1}`;
    this.retrySchedules.set(id, {
      nodeId,
      nextAttemptNo: node.attemptNo + 1,
      consumed: false,
    });
    node.phase = 'retry_wait';
    this.append(id, 'retry_schedule_created');
    return 'retry_scheduled';
  }

  consumeRetry(scheduleId: string): 'consumed' | 'duplicate_timer' {
    const schedule = this.retrySchedules.get(scheduleId);
    if (!schedule) throw new Error('retry_schedule_missing');
    if (schedule.consumed) return 'duplicate_timer';
    schedule.consumed = true;
    const node = this.requiredNode(schedule.nodeId);
    node.attemptNo = schedule.nextAttemptNo;
    node.phase = 'active';
    this.append(`consumed:${scheduleId}`, 'retry_schedule_consumed');
    return 'consumed';
  }

  openBlocker(id: string, severity: 'action_required' | 'quarantine'): void {
    const prior = this.blockers.get(id);
    if (prior && prior.severity !== severity)
      throw new Error('blocker_conflict');
    this.blockers.set(id, { severity });
    this.operationalState = [...this.blockers.values()].some(
      (blocker) => blocker.severity === 'quarantine',
    )
      ? 'quarantined'
      : 'action_required';
    this.append(`blocker:${id}`, 'operational_blocker_changed');
  }

  snapshot(): object {
    return {
      nodes: [...this.nodes.values()]
        .map((node) => ({ ...node }))
        .sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
      edges: this.edges
        .map((edge) => ({ ...edge }))
        .sort((left, right) =>
          `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`),
        ),
      factKeys: [...this.facts.keys()].sort(),
      eventCount: this.events.length,
      operationalState: this.operationalState,
    };
  }

  private fixedPoint(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes.values()) {
        if (node.phase !== 'pending') continue;
        const incoming = this.edges.filter((edge) => edge.to === node.id);
        if (incoming.some((edge) => edge.resolution === 'unresolved')) continue;
        if (incoming.every((edge) => edge.resolution === 'taken'))
          this.ready(node.id);
        else this.complete(node.id, 'skipped');
        changed = true;
      }
    }
  }

  private requiredNode(nodeId: string): ReferenceNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error('node_missing');
    return node;
  }
}
