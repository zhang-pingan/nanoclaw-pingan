export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  services?: string[]; // Service names from services.json to mount repos for (use ["*"] for all)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  description?: string; // Human-readable description of this group's capabilities
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  model?: string | null;
  model_reason?: string | null;
  workflow_id?: string | null;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface Delegation {
  id: string;
  source_jid: string;
  source_folder: string;
  target_jid: string;
  target_folder: string;
  task: string;
  status: 'pending' | 'completed' | 'failed';
  result: string | null;
  outcome: 'success' | 'failure' | null;
  requester_jid?: string | null;
  workflow_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionFieldEnumOption {
  value: string;
  label?: string;
}

export interface AskQuestionField {
  id: string;
  label: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  enum?: AskQuestionFieldEnumOption[];
}

export interface AskQuestionItem {
  id: string;
  question: string;
  options?: AskQuestionOption[];
  fields?: AskQuestionField[];
  multi_select?: boolean;
}

export interface AskQuestionRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  status: 'pending' | 'answered' | 'skipped' | 'timeout' | 'rejected';
  payload_json: string;
  answers_json: string | null;
  current_index: number;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
  responder_user_id: string | null;
}

/** Workflow status is now a plain string — valid values are defined in workflows.json per type. */
export type WorkflowStatus = string;

/** Agent status info for the Agent Status panel. */
export interface AgentStatusInfo {
  groupJid: string;
  groupName: string;
  groupFolder: string;
  promptSummary: string;
  lastSender: string;
  lastContent: string;
  lastTime: string;
  startedAt: number;
  isIdle: boolean;
  isTask: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTaskCount: number;
}

export interface Workflow {
  id: string;
  name: string;
  service: string;
  branch: string;
  deliverable: string;
  status: WorkflowStatus;
  current_delegation_id: string;
  round: number;
  source_jid: string;
  paused_from: WorkflowStatus | null;
  workflow_type: string;
  created_at: string;
  updated_at: string;
}

export interface WorkbenchTaskRecord {
  id: string;
  workflow_id: string;
  source_jid: string;
  title: string;
  service: string;
  workflow_type: string;
  status: string;
  current_stage: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

export interface WorkbenchSubtaskRecord {
  id: string;
  task_id: string;
  workflow_id: string;
  delegation_id: string | null;
  stage_key: string;
  title: string;
  role: string | null;
  group_folder: string | null;
  status: string;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface WorkbenchEventRecord {
  id: string;
  task_id: string;
  subtask_id: string | null;
  event_type: string;
  title: string;
  body: string | null;
  raw_ref_type: string | null;
  raw_ref_id: string | null;
  created_at: string;
}

export interface WorkbenchArtifactRecord {
  id: string;
  task_id: string;
  workflow_id: string;
  artifact_type: string;
  title: string;
  path: string;
  source_role: string | null;
  created_at: string;
}

export interface WorkbenchApprovalRecord {
  id: string;
  task_id: string;
  workflow_id: string;
  status: string;
  approval_type: string;
  title: string;
  body: string | null;
  card_key: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface WorkbenchCommentRecord {
  id: string;
  task_id: string;
  workflow_id: string;
  author: string;
  content: string;
  created_at: string;
}

export interface WorkbenchContextAssetRecord {
  id: string;
  task_id: string;
  workflow_id: string;
  asset_type: string;
  title: string;
  path: string | null;
  url: string | null;
  note: string | null;
  created_at: string;
}

export interface MemoryRecord {
  id: string;
  group_folder: string;
  layer: 'working' | 'episodic' | 'canonical';
  memory_type: 'preference' | 'rule' | 'fact' | 'summary';
  status: 'active' | 'conflicted' | 'deprecated';
  content: string;
  source: string;
  metadata?: string;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  id: string;
  layer: MemoryRecord['layer'];
  memory_type: MemoryRecord['memory_type'];
  content: string;
  updated_at: string;
  score: number;
}

// --- Channel abstraction ---

/** @internal Feishu-specific card format — used only inside the Feishu channel. */
export interface FeishuCard {
  header: { title: string; template?: string };
  elements: unknown[];
}

// --- InteractiveCard: channel-agnostic card format ---

export type CardHeaderColor = 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'grey';

export interface CardButton {
  id: string;
  label: string;
  type?: 'primary' | 'danger' | 'default';
  value: Record<string, string>;
}

export interface CardInput {
  name: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'integer' | 'boolean' | 'enum';
  options?: Array<{ value: string; label?: string }>;
  required?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  error?: string;
}

export interface CardForm {
  name: string;
  inputs: CardInput[];
  submitButton: CardButton;
}

export interface CardSection {
  body: string;
  buttons?: CardButton[];
}

export interface InteractiveCard {
  header: { title: string; color?: CardHeaderColor };
  body?: string;
  buttons?: CardButton[];
  form?: CardForm;
  sections?: CardSection[];
}

export type CardActionHandler = (action: {
  action: string;
  user_id: string;
  message_id: string;
  group_folder?: string; // Plan confirmation primary key
  workflow_id?: string; // Workflow operations primary key (approve/pause/resume)
  form_value?: Record<string, string>;
}) => void;

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send interactive card. Returns message_id.
  sendCard?(jid: string, card: InteractiveCard): Promise<string | undefined>;
  // Optional: card action callback handler.
  onCardAction?: CardActionHandler | null;
  // Optional: send file or image. Channels that support it implement it.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
