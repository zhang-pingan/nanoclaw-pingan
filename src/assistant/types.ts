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

export type AssistantTriggerRuleKey =
  | 'today_plan.missing_today_plan'
  | 'today_plan.unfinished_previous_plan'
  | 'workbench.pending_action_item'
  | 'workbench.task_failed_or_cancelled'
  | 'workbench.task_stale'
  | 'scheduler.task_failed'
  | 'agent_runs.query_failed'
  | 'online.error_logs';

export interface AssistantTriggerRuleSettings {
  enabled: boolean;
  investigationEnabled: boolean;
  autoEnabled: boolean;
  selectedServices: string[];
}

export interface AssistantTriggerRuleCapability {
  key: AssistantTriggerRuleKey;
  label: string;
  sourceLabel: string;
  supportsInvestigation: boolean;
  supportsRepair: boolean;
}

export interface AssistantOnlineLogServiceOption {
  service: string;
  hosts: string[];
  logsErrorPath: string;
  configured: boolean;
  disabledReason: string | null;
}

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

export interface AgentInboxItemView extends Omit<
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
  triggerRuleKey?: AssistantTriggerRuleKey | null;
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
  evolution: {
    enabled: boolean;
    autoImplementEnabled: boolean;
    autoAdoptEnabled: boolean;
    scanIntervalMinutes: number;
    maxConcurrentItems: number;
    maxReviewRounds: number;
    allowedRiskLevel: 'low' | 'medium' | 'high';
  };
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  triggerRules: Record<AssistantTriggerRuleKey, AssistantTriggerRuleSettings>;
  desktopAssistant: {
    autostart: boolean;
    alwaysOnTop: boolean;
    allowMovement: boolean;
  };
  maxInboxItems: number;
}

export const ASSISTANT_TRIGGER_RULE_CAPABILITIES: AssistantTriggerRuleCapability[] =
  [
    {
      key: 'today_plan.missing_today_plan',
      label: '今天还没有计划',
      sourceLabel: '今日计划',
      supportsInvestigation: false,
      supportsRepair: false,
    },
    {
      key: 'today_plan.unfinished_previous_plan',
      label: '有未完成的往日计划',
      sourceLabel: '今日计划',
      supportsInvestigation: false,
      supportsRepair: false,
    },
    {
      key: 'workbench.pending_action_item',
      label: '工作台待处理项',
      sourceLabel: '工作台',
      supportsInvestigation: false,
      supportsRepair: false,
    },
    {
      key: 'workbench.task_failed_or_cancelled',
      label: '工作台任务失败或取消',
      sourceLabel: '工作台',
      supportsInvestigation: true,
      supportsRepair: true,
    },
    {
      key: 'workbench.task_stale',
      label: '工作台任务长时间无进展',
      sourceLabel: '工作台',
      supportsInvestigation: true,
      supportsRepair: true,
    },
    {
      key: 'scheduler.task_failed',
      label: '定时任务执行失败',
      sourceLabel: '定时任务',
      supportsInvestigation: true,
      supportsRepair: true,
    },
    {
      key: 'agent_runs.query_failed',
      label: 'Agent 执行异常',
      sourceLabel: 'Agent Runs',
      supportsInvestigation: true,
      supportsRepair: true,
    },
    {
      key: 'online.error_logs',
      label: '线上 error 日志',
      sourceLabel: '线上异常',
      supportsInvestigation: true,
      supportsRepair: true,
    },
  ];

export const ASSISTANT_TRIGGER_RULE_DEFAULTS: Record<
  AssistantTriggerRuleKey,
  AssistantTriggerRuleSettings
> = Object.fromEntries(
  ASSISTANT_TRIGGER_RULE_CAPABILITIES.map((rule) => [
    rule.key,
    {
      enabled: true,
      investigationEnabled: false,
      autoEnabled: false,
      selectedServices: [],
    },
  ]),
) as unknown as Record<AssistantTriggerRuleKey, AssistantTriggerRuleSettings>;

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  enabled: true,
  proactiveLevel: 'balanced',
  scanIntervalMinutes: 10,
  evolution: {
    enabled: false,
    autoImplementEnabled: false,
    autoAdoptEnabled: false,
    scanIntervalMinutes: 60,
    maxConcurrentItems: 1,
    maxReviewRounds: 2,
    allowedRiskLevel: 'medium',
  },
  quietHours: {
    enabled: false,
    start: '22:30',
    end: '08:30',
  },
  triggerRules: ASSISTANT_TRIGGER_RULE_DEFAULTS,
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

export interface AssistantActionLogView extends Omit<
  AssistantActionLogRecord,
  'payload_json' | 'result_json'
> {
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface AssistantState {
  settings: AssistantSettings;
  triggerRuleCapabilities: AssistantTriggerRuleCapability[];
  onlineLogServiceOptions: AssistantOnlineLogServiceOption[];
  inboxCounts: Record<AgentInboxStatus, number>;
  latestInboxItems: AgentInboxItemView[];
  latestActionLogs: AssistantActionLogView[];
  evolution: unknown;
}
