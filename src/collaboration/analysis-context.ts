import type { CollaborationAnalysisScope } from './analysis-contracts.js';
import type { ValidatedProjectSpaceHistory } from './project-space-service.js';
import { workflowDefinitionVersionKey } from './protocol/v3-reducer.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';

export type CollaborationAnalysisResourceCatalog = Record<string, unknown>;

export function buildCollaborationAnalysisResourceCatalog(
  projection: CollaborationProjectionV3,
): CollaborationAnalysisResourceCatalog {
  const catalog: CollaborationAnalysisResourceCatalog = {
    [`group:${projection.groupId}`]: projection.group,
  };
  for (const [id, member] of Object.entries(projection.members))
    catalog[`principal:${id}`] = {
      member,
      clients: projection.clients[id] ?? {},
      executors: projection.executors[id] ?? {},
      permission_grant: projection.permissionGrants[id] ?? null,
      progress_updates: Object.values(projection.progressUpdates).filter(
        (update) => update.principal_id === id,
      ),
    };
  for (const [id, request] of Object.entries(projection.recoveryRequests))
    catalog[`recovery:${id}`] = request;
  for (const [id, item] of Object.entries(projection.workItems))
    catalog[`work_item:${id}`] = {
      item,
      updates: projection.workItemUpdates[id] ?? [],
      artifacts: Object.values(projection.artifacts).filter(
        (artifact) =>
          artifact.scope.type === 'work_item' &&
          artifact.scope.work_item_id === id,
      ),
    };
  for (const entry of Object.values(projection.discussions)) {
    catalog[`discussion:${entry.discussion.thread_id}`] = entry;
    for (const [id, message] of Object.entries(entry.messages))
      catalog[`message:${id}`] = message;
  }
  for (const [id, notification] of Object.entries(projection.notifications))
    catalog[`notification:${id}`] = notification;
  for (const [id, instance] of Object.entries(projection.workflowInstances)) {
    const definition =
      projection.workflowDefinitions[
        workflowDefinitionVersionKey(
          instance.definition_id,
          instance.definition_version,
        )
      ] ?? null;
    catalog[`workflow_instance:${id}`] = {
      ...instance,
      definition,
      execution: projection.stateExecutions[id] ?? {},
      artifacts: Object.values(projection.artifacts).filter(
        (artifact) =>
          artifact.scope.type === 'workflow_turn' &&
          artifact.scope.workflow_instance_id === id,
      ),
    };
  }
  for (const [id, turn] of Object.entries(projection.turns))
    catalog[`turn:${id}`] = turn;
  for (const [id, metadata] of Object.entries(projection.files)) {
    const location = projection.fileLocations[id];
    catalog[`file:${id}`] = {
      metadata,
      location: location ?? null,
      repository_path:
        location && metadata.content_ref
          ? `${location.repositoryDirectory}/${metadata.content_ref}`
          : null,
    };
  }
  for (const event of projection.activity)
    catalog[`event:${event.eventId}`] = event;
  return catalog;
}

export function collaborationAnalysisScopeRefs(input: {
  readonly scope: CollaborationAnalysisScope;
  readonly projection: CollaborationProjectionV3;
  readonly myItemRefs: readonly string[];
  readonly currentPrincipalId?: string | null;
}): Set<string> | null {
  const { scope, projection } = input;
  if (scope.type === 'project' || scope.type === 'delta') return null;
  const refs = new Set<string>([`group:${projection.groupId}`]);
  const addPrincipal = (id: string | null | undefined): void => {
    if (id && projection.members[id]) refs.add(`principal:${id}`);
  };
  const addFile = (id: string): void => {
    if (projection.files[id]) refs.add(`file:${id}`);
  };
  const addDiscussion = (id: string): void => {
    const entry = projection.discussions[id];
    if (!entry) return;
    refs.add(`discussion:${id}`);
    addPrincipal(entry.discussion.created_by);
    for (const [messageId, message] of Object.entries(entry.messages)) {
      refs.add(`message:${messageId}`);
      addPrincipal(message.author_principal_id);
      for (const principalId of message.mentions) addPrincipal(principalId);
    }
  };
  const addWorkItem = (id: string): void => {
    const item = projection.workItems[id];
    if (!item) return;
    refs.add(`work_item:${id}`);
    for (const principalId of [
      item.creator_principal_id,
      item.owner_principal_id,
      ...item.contributors,
      ...item.watchers,
    ])
      addPrincipal(principalId);
    for (const [fileId, file] of Object.entries(projection.files))
      if (file.refs.work_item_refs.includes(id)) addFile(fileId);
    for (const [discussionId, discussion] of Object.entries(
      projection.discussions,
    ))
      if (
        discussion.discussion.scope.type === 'work_item' &&
        discussion.discussion.scope.ref === id
      )
        addDiscussion(discussionId);
  };
  const addWorkflow = (id: string): void => {
    const instance = projection.workflowInstances[id];
    if (!instance) return;
    refs.add(`workflow_instance:${id}`);
    addPrincipal(instance.created_by_principal_id);
    if (instance.scope.type === 'work_item')
      addWorkItem(instance.scope.work_item_id);
    for (const related of instance.related_work_item_refs) addWorkItem(related);
    for (const turn of Object.values(projection.turns)) {
      if (turn.workflow_instance_id !== id) continue;
      refs.add(`turn:${turn.turn_id}`);
      addPrincipal(turn.assignee_principal_id);
      addPrincipal(turn.claimant_principal_id);
    }
    for (const [fileId, file] of Object.entries(projection.files))
      if (file.refs.workflow_instance_refs.includes(id)) addFile(fileId);
    for (const [discussionId, discussion] of Object.entries(
      projection.discussions,
    ))
      if (
        (discussion.discussion.scope.type === 'workflow_instance' &&
          discussion.discussion.scope.ref === id) ||
        (discussion.discussion.scope.type === 'turn' &&
          projection.turns[discussion.discussion.scope.ref]
            ?.workflow_instance_id === id)
      )
        addDiscussion(discussionId);
  };
  const addRef = (ref: string): void => {
    const separator = ref.indexOf(':');
    const type = separator < 0 ? '' : ref.slice(0, separator);
    const id = separator < 0 ? '' : ref.slice(separator + 1);
    if (type === 'work_item') addWorkItem(id);
    else if (type === 'workflow_instance') addWorkflow(id);
    else if (type === 'turn') {
      const turn = projection.turns[id];
      if (turn) addWorkflow(turn.workflow_instance_id);
    } else if (type === 'discussion') addDiscussion(id);
    else if (type === 'file') addFile(id);
    else if (type === 'recovery') {
      const request = projection.recoveryRequests[id];
      if (request) {
        refs.add(ref);
        addPrincipal(request.target_principal_id);
      }
    } else if (type === 'membership' || type === 'credential') addPrincipal(id);
    else if (type === 'protocol') refs.add(`group:${projection.groupId}`);
    else refs.add(ref);
  };
  if (scope.type === 'mine') {
    addPrincipal(input.currentPrincipalId);
    for (const ref of input.myItemRefs) addRef(ref);
    return refs;
  }
  if (scope.type === 'work_item') {
    const item = projection.workItems[scope.work_item_id];
    if (!item) throw new Error(`Work Item not found: ${scope.work_item_id}`);
    addWorkItem(scope.work_item_id);
    for (const id of [
      ...item.blocked_by,
      ...item.related_items,
      ...(item.parent_id ? [item.parent_id] : []),
    ])
      addWorkItem(id);
    if (item.primary_workflow_instance_id)
      addWorkflow(item.primary_workflow_instance_id);
    return refs;
  }
  const instance = projection.workflowInstances[scope.workflow_instance_id];
  if (!instance)
    throw new Error(
      `Workflow Instance not found: ${scope.workflow_instance_id}`,
    );
  addWorkflow(scope.workflow_instance_id);
  return refs;
}

export function scopeCollaborationAnalysisResourceCatalog(input: {
  readonly catalog: CollaborationAnalysisResourceCatalog;
  readonly scope: CollaborationAnalysisScope;
  readonly projection: CollaborationProjectionV3;
  readonly myItemRefs: readonly string[];
  readonly currentPrincipalId?: string | null;
}): CollaborationAnalysisResourceCatalog {
  const selected = collaborationAnalysisScopeRefs(input);
  if (!selected) return input.catalog;
  return Object.fromEntries(
    Object.entries(input.catalog).filter(([ref]) => selected.has(ref)),
  );
}

export interface CollaborationAnalysisDeltaSelection {
  readonly catalog: CollaborationAnalysisResourceCatalog;
  readonly activity: CollaborationProjectionV3['activity'];
  readonly changedRefs: readonly string[];
  readonly eventCount: number;
}

function analysisContextStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(analysisContextStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(
    analysisContextStrings,
  );
}

function aggregateResourceRef(
  aggregateType: string,
  aggregateId: string,
  projection: CollaborationProjectionV3,
): string | null {
  switch (aggregateType) {
    case 'group':
      return `group:${projection.groupId}`;
    case 'membership':
      return projection.members[aggregateId]
        ? `principal:${aggregateId}`
        : null;
    case 'recovery':
      return projection.recoveryRequests[aggregateId]
        ? `recovery:${aggregateId}`
        : null;
    case 'workspace':
      return projection.members[aggregateId]
        ? `principal:${aggregateId}`
        : null;
    case 'work_item':
      return projection.workItems[aggregateId]
        ? `work_item:${aggregateId}`
        : null;
    case 'discussion':
      return projection.discussions[aggregateId]
        ? `discussion:${aggregateId}`
        : null;
    case 'notification':
      return projection.notifications[aggregateId]
        ? `notification:${aggregateId}`
        : null;
    case 'workflow_instance':
      return projection.workflowInstances[aggregateId]
        ? `workflow_instance:${aggregateId}`
        : null;
    default:
      return null;
  }
}

export function buildCollaborationAnalysisDeltaSelection(input: {
  readonly scope: Extract<CollaborationAnalysisScope, { type: 'delta' }>;
  readonly history: ValidatedProjectSpaceHistory;
  readonly fullCatalog: CollaborationAnalysisResourceCatalog;
}): CollaborationAnalysisDeltaSelection | null {
  const { history, fullCatalog } = input;
  const baseline = history.eventRecords.find(
    (record) => record.commitHash === input.scope.since_snapshot_head,
  );
  if (!baseline) return null;
  const records = history.eventRecords.filter(
    (record) => record.commitOrder > baseline.commitOrder,
  );
  const refsById = new Map<string, Set<string>>();
  for (const ref of Object.keys(fullCatalog)) {
    const id = ref.slice(ref.indexOf(':') + 1);
    const values = refsById.get(id) ?? new Set<string>();
    values.add(ref);
    refsById.set(id, values);
  }
  const changedRefs = new Set<string>();
  const selectedRefs = new Set<string>([`group:${history.projection.groupId}`]);
  const addSelected = (ref: string | null): void => {
    if (ref && ref in fullCatalog) selectedRefs.add(ref);
  };
  for (const record of records) {
    const eventRef = `event:${record.event.event_id}`;
    addSelected(eventRef);
    if (eventRef in fullCatalog) changedRefs.add(eventRef);
    const aggregateRef = aggregateResourceRef(
      record.event.aggregate_type,
      record.event.aggregate_id,
      history.projection,
    );
    addSelected(aggregateRef);
    if (aggregateRef && aggregateRef in fullCatalog)
      changedRefs.add(aggregateRef);
    addSelected(`principal:${record.event.actor.principal_id}`);
    for (const value of analysisContextStrings(record.event.payload))
      for (const ref of refsById.get(value) ?? []) {
        selectedRefs.add(ref);
        changedRefs.add(ref);
      }
  }
  for (const ref of [...selectedRefs]) {
    const [type, id] = ref.split(':', 2) as [string, string];
    if (type === 'work_item') {
      const expanded = collaborationAnalysisScopeRefs({
        scope: { type: 'work_item', work_item_id: id },
        projection: history.projection,
        myItemRefs: [],
      });
      for (const related of expanded ?? []) addSelected(related);
    } else if (type === 'workflow_instance') {
      const expanded = collaborationAnalysisScopeRefs({
        scope: { type: 'workflow_instance', workflow_instance_id: id },
        projection: history.projection,
        myItemRefs: [],
      });
      for (const related of expanded ?? []) addSelected(related);
    } else if (type === 'discussion') {
      const discussion = history.projection.discussions[id];
      if (!discussion) continue;
      for (const [messageId, message] of Object.entries(discussion.messages)) {
        addSelected(`message:${messageId}`);
        addSelected(`principal:${message.author_principal_id}`);
        for (const principalId of message.mentions)
          addSelected(`principal:${principalId}`);
      }
    }
  }
  const activityById = new Map(
    history.projection.activity.map((entry) => [entry.eventId, entry]),
  );
  return {
    catalog: Object.fromEntries(
      Object.entries(fullCatalog).filter(([ref]) => selectedRefs.has(ref)),
    ),
    activity: records.flatMap((record) => {
      const value = activityById.get(record.event.event_id);
      return value ? [value] : [];
    }),
    changedRefs: [...changedRefs].sort(),
    eventCount: records.length,
  };
}
