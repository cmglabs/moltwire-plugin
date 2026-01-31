// Plugin configuration
export interface MoltwireConfig {
  enabled: boolean;
  apiKey: string;
  apiEndpoint: string;
  flushIntervalSeconds: number;
  flushBatchSize: number;
  redactPatterns: boolean;
  localAnomalyDetection: boolean;
  captureToolExecution: boolean;
  captureInboundMessages: boolean;
  captureSessionLifecycle: boolean;
  captureConfigChanges: boolean;
  debug: boolean;
}

// Command pattern classification
export type CommandPattern =
  | 'curl_external'
  | 'curl_internal'
  | 'file_read_home'
  | 'file_read_config'
  | 'file_read_credential'
  | 'file_write'
  | 'file_delete'
  | 'npm_install'
  | 'git_operation'
  | 'process_spawn'
  | 'ssh_connection'
  | 'docker_operation'
  | 'browser_navigate'
  | 'browser_form_fill'
  | 'unknown';

// Event types
export type EventType =
  | 'tool_execution'
  | 'inbound_message'
  | 'session_lifecycle'
  | 'config_change'
  | 'anomaly_indicator';

// Anomaly indicator types
export type AnomalyIndicatorType =
  | 'unusual_hour_activity'
  | 'credential_path_access'
  | 'rapid_tool_execution'
  | 'new_external_domain'
  | 'data_exfiltration_pattern'
  | 'system_prompt_request'
  | 'bulk_file_access'
  | 'elevation_attempt'
  | 'skill_installs_untrusted'
  | 'matched_threat_signature';

// Base event structure
export interface BaseEvent {
  event_id: string;
  event_type: EventType;
  timestamp: string;
  agent_id: string;
  session_id?: string;
}

// Tool execution event
export interface ToolExecutionEvent extends BaseEvent {
  event_type: 'tool_execution';
  payload: {
    tool_name: string;
    tool_category?: string;
    command_pattern: CommandPattern;
    target_domain?: string;
    exit_code?: number;
    duration_ms?: number;
    is_elevated?: boolean;
    is_sandboxed?: boolean;
    skill_source?: string;
  };
}

// Inbound message event
export interface InboundMessageEvent extends BaseEvent {
  event_type: 'inbound_message';
  payload: {
    channel_type: string;
    is_dm?: boolean;
    is_from_paired_user?: boolean;
    message_length: number;
    contains_url?: boolean;
    contains_code_block?: boolean;
  };
}

// Session lifecycle event
export interface SessionLifecycleEvent extends BaseEvent {
  event_type: 'session_lifecycle';
  payload: {
    action: 'start' | 'end';
    model_provider?: string;
    model_name?: string;
    skills_loaded_count?: number;
    tools_enabled?: string[];
    channels_active?: string[];
  };
}

// Config change event
export interface ConfigChangeEvent extends BaseEvent {
  event_type: 'config_change';
  payload: {
    change_type:
      | 'skill_installed'
      | 'skill_removed'
      | 'tool_permission_changed'
      | 'channel_added'
      | 'channel_removed'
      | 'model_provider_changed'
      | 'auth_profile_changed';
    detail?: string;
    skill_name?: string;
    skill_source?: string;
  };
}

// Anomaly indicator event
export interface AnomalyIndicatorEvent extends BaseEvent {
  event_type: 'anomaly_indicator';
  payload: {
    indicator_type: AnomalyIndicatorType;
    detail?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
  };
}

// Union type for all events
export type MoltwireEvent =
  | ToolExecutionEvent
  | InboundMessageEvent
  | SessionLifecycleEvent
  | ConfigChangeEvent
  | AnomalyIndicatorEvent;

// API response types
export interface EventBatchResponse {
  accepted: number;
  rejected: number;
  errors?: Array<{ index: number; reason: string }>;
  active_signatures?: number;
}

// OpenClaw hook context types (simplified, actual types come from OpenClaw)
export interface ToolContext {
  toolName: string;
  toolCategory?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  isElevated?: boolean;
  isSandboxed?: boolean;
  skillSource?: string;
}

export interface ToolResult {
  exitCode?: number;
  duration?: number;
  stdout?: string;
  stderr?: string;
}

export interface MessageContext {
  channelType: string;
  content: string;
  isDm?: boolean;
  isFromPairedUser?: boolean;
}

export interface SessionContext {
  sessionId: string;
  modelProvider?: string;
  modelName?: string;
  skillsLoaded?: string[];
  toolsEnabled?: string[];
  channelsActive?: string[];
}

export interface ConfigChangeContext {
  changeType: string;
  skillName?: string;
  skillSource?: string;
  detail?: string;
}
