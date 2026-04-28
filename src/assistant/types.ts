export type AgentInboxKind =
  | 'notification'
  | 'suggestion'
  | 'approval'
  | 'risk';

export type AgentInboxStatus =
  | 'unread'
  | 'read'
  | 'done'
  | 'dismissed'
  | 'snoozed';

export type AgentInboxPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface AgentInboxItemRecord {
  id: string;
  dedupe_key: string;
  kind: AgentInboxKind;
  status: AgentInboxStatus;
  priority: AgentInboxPriority;
  title: string;
  body: string | null;
  source_type: string;
  source_ref_id: string | null;
  action_kind: string | null;
  action_label: string | null;
  action_url: string | null;
  action_payload_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  snoozed_until: string | null;
  read_at: string | null;
  resolved_at: string | null;
  extra_json: string | null;
}

export interface AgentInboxItemView
  extends Omit<
    AgentInboxItemRecord,
    'action_payload_json' | 'extra_json'
  > {
  action_payload: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export interface UpsertAgentInboxItemInput {
  dedupeKey: string;
  kind: AgentInboxKind;
  priority?: AgentInboxPriority;
  title: string;
  body?: string | null;
  sourceType: string;
  sourceRefId?: string | null;
  actionKind?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  actionPayload?: Record<string, unknown>;
  dueAt?: string | null;
  extra?: Record<string, unknown>;
  createdBy?: string;
}

export interface AssistantSettings {
  enabled: boolean;
  proactiveLevel: 'quiet' | 'balanced' | 'active';
  scanIntervalMinutes: number;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  dataSources: {
    todayPlan: boolean;
    workbench: boolean;
    scheduler: boolean;
    agentRuns: boolean;
  };
  desktopAssistant: {
    autostart: boolean;
    alwaysOnTop: boolean;
    allowMovement: boolean;
  };
  maxInboxItems: number;
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  enabled: true,
  proactiveLevel: 'balanced',
  scanIntervalMinutes: 10,
  quietHours: {
    enabled: false,
    start: '22:30',
    end: '08:30',
  },
  dataSources: {
    todayPlan: true,
    workbench: true,
    scheduler: true,
    agentRuns: true,
  },
  desktopAssistant: {
    autostart: false,
    alwaysOnTop: true,
    allowMovement: true,
  },
  maxInboxItems: 200,
};

export interface AssistantActionLogRecord {
  id: string;
  item_id: string | null;
  action: string;
  status: 'success' | 'error' | 'skipped';
  title: string | null;
  body: string | null;
  source_type: string | null;
  source_ref_id: string | null;
  payload_json: string | null;
  result_json: string | null;
  created_at: string;
}

export interface AssistantActionLogView
  extends Omit<AssistantActionLogRecord, 'payload_json' | 'result_json'> {
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface AssistantState {
  settings: AssistantSettings;
  inboxCounts: Record<AgentInboxStatus, number>;
  latestInboxItems: AgentInboxItemView[];
  latestActionLogs: AssistantActionLogView[];
}
