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
  requester_jid: string | null;
  created_at: string;
  updated_at: string;
}

/** Workflow status is now a plain string — valid values are defined in workflows.json per type. */
export type WorkflowStatus = string;

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

// --- Channel abstraction ---

export interface FeishuCard {
  header: { title: string; template?: string };
  elements: unknown[];
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
  // Optional: send interactive card (Feishu). Returns message_id.
  sendCard?(jid: string, card: FeishuCard): Promise<string | undefined>;
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
