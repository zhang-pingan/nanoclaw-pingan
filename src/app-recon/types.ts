export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type IosEvidenceType =
  | 'SESSION'
  | 'BUILD'
  | 'STATE'
  | 'OBS'
  | 'SCREEN'
  | 'SCREENSHOT'
  | 'UI_TREE'
  | 'ACT'
  | 'FLOW'
  | 'NET'
  | 'APP_LOG'
  | 'CRASH'
  | 'CLIENT_CODE'
  | 'SERVER_CODE'
  | 'CASE'
  | 'ASSERT'
  | 'CLAIM'
  | 'DEBUG';

export type IosClaimType =
  | 'current_behavior'
  | 'api_behavior'
  | 'client_implementation'
  | 'server_implementation'
  | 'impact'
  | 'test_requirement'
  | 'test_result'
  | 'risk'
  | 'open_question';

export type IosConfidence = 'low' | 'medium' | 'high';

export interface IosEvidenceRecord {
  id: string;
  type: IosEvidenceType;
  created_at: string;
  session_id: string;
  source: string;
  summary: string;
  artifact_path?: string;
  payload?: JsonValue;
  redaction: {
    applied: boolean;
    fields: string[];
  };
}

export interface IosClaimRecord {
  id: string;
  type: IosClaimType;
  statement: string;
  supported_by: string[];
  confidence: IosConfidence;
  limitations: string[];
  created_at: string;
  session_id: string;
}

export interface IosClientAutomationConfig {
  driver?: 'appium' | string;
  launch_args?: string[];
  deep_links?: Record<string, string>;
  network_log_path?: string;
  appium_server_url?: string;
}

export interface IosClientConfig {
  repo_path: string;
  git_url?: string;
  workspace?: string;
  project?: string;
  scheme: string;
  bundle_id: string;
  simulator?: string;
  configuration?: string;
  mount_to_container?: boolean;
  automation?: IosClientAutomationConfig;
}

export interface ServiceConfig {
  repo_path?: string;
  git_url?: string;
  default_branch?: string;
  clients?: {
    ios?: IosClientConfig;
  };
  [key: string]: unknown;
}

export interface ResolvedIosServiceConfig {
  service: string;
  service_config: ServiceConfig;
  ios: IosClientConfig;
  ios_repo_host_path: string;
  backend_repo_host_path: string | null;
}

export interface IosAppRequestContext {
  sourceGroup: string;
  isMain: boolean;
}

export interface IosAppRequest {
  action:
    | 'prepare_session'
    | 'observe'
    | 'act'
    | 'run_flow'
    | 'read_trace'
    | 'search_code'
    | 'write_claims'
    | 'write_report'
    | 'run_test_case'
    | 'debug_shell';
  args: unknown;
}

export interface IosAppErrorResult {
  status: 'error' | 'blocked';
  error: {
    code: string;
    message: string;
    details?: JsonValue;
  };
}

export interface IosSessionRecord {
  session_id: string;
  service: string;
  purpose: string;
  created_at: string;
  updated_at: string;
  simulator_name: string;
  simulator_udid?: string;
  bundle_id: string;
  app_version?: string;
  build_id: string;
  state_id: string;
  artifact_dir: string;
  ios_repo_host_path: string;
  backend_repo_host_path: string | null;
  config: JsonObject;
}

export interface IosActionWindow {
  started_at: string;
  ended_at: string;
}

export interface IosObserveElement {
  ref: string;
  type: string;
  label?: string;
  identifier?: string;
  enabled?: boolean;
  visible?: boolean;
  clickable?: boolean;
  frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface IosObservationResult {
  id: string;
  session_id: string;
  screen: JsonObject;
  artifacts: JsonObject;
  elements: IosObserveElement[];
  network_cursor?: string;
  app_state: JsonObject;
  evidence: string[];
}

export interface IosActionResult {
  id: string;
  type: string;
  target?: JsonValue;
  before?: string;
  after?: string;
  wait?: JsonValue;
  time_window: IosActionWindow;
  status: 'success' | 'error' | 'blocked';
  error?: string;
  evidence: string[];
}

export interface IosAppRequestSuccessResult {
  status?: string;
  [key: string]: unknown;
}

export type IosAppRequestResult =
  | IosAppRequestSuccessResult
  | IosAppErrorResult;
