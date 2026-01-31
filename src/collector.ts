import { randomUUID } from 'crypto';
import { classifyCommand, extractDomain, isCredentialPath } from './classifier.js';
import { createSessionId, scrubPII } from './anonymizer.js';
import type {
  MoltwireConfig,
  MoltwireEvent,
  ToolExecutionEvent,
  InboundMessageEvent,
  SessionLifecycleEvent,
  ConfigChangeEvent,
  AnomalyIndicatorEvent,
  ToolContext,
  ToolResult,
  MessageContext,
  SessionContext,
  ConfigChangeContext,
  AnomalyIndicatorType
} from './types.js';

/**
 * Event collector - creates events from OpenClaw hook data
 */
export class EventCollector {
  private agentId: string;
  private config: MoltwireConfig;
  private currentSessionId: string | null = null;

  constructor(agentId: string, config: MoltwireConfig) {
    this.agentId = agentId;
    this.config = config;
  }

  /**
   * Create base event fields
   */
  private createBaseEvent(eventType: MoltwireEvent['event_type']): Omit<MoltwireEvent, 'payload'> {
    return {
      event_id: randomUUID(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      agent_id: this.agentId,
      session_id: this.currentSessionId || undefined
    };
  }

  /**
   * Set the current session ID
   */
  setSession(sessionId: string): void {
    this.currentSessionId = createSessionId(sessionId, this.agentId);
  }

  /**
   * Clear the current session
   */
  clearSession(): void {
    this.currentSessionId = null;
  }

  /**
   * Collect a tool execution event
   */
  collectToolExecution(context: ToolContext, result?: ToolResult): ToolExecutionEvent | null {
    if (!this.config.captureToolExecution) return null;

    const commandPattern = classifyCommand(context);
    const targetDomain = extractDomain(context.command || context.args?.join(' ') || '');

    const event: ToolExecutionEvent = {
      ...this.createBaseEvent('tool_execution'),
      event_type: 'tool_execution',
      payload: {
        tool_name: context.toolName,
        tool_category: context.toolCategory,
        command_pattern: commandPattern,
        target_domain: targetDomain,
        exit_code: result?.exitCode,
        duration_ms: result?.duration,
        is_elevated: context.isElevated,
        is_sandboxed: context.isSandboxed,
        skill_source: context.skillSource
      }
    };

    return event;
  }

  /**
   * Collect an inbound message event
   */
  collectInboundMessage(context: MessageContext): InboundMessageEvent | null {
    if (!this.config.captureInboundMessages) return null;

    const content = context.content || '';

    const event: InboundMessageEvent = {
      ...this.createBaseEvent('inbound_message'),
      event_type: 'inbound_message',
      payload: {
        channel_type: context.channelType,
        is_dm: context.isDm,
        is_from_paired_user: context.isFromPairedUser,
        message_length: content.length,
        contains_url: /https?:\/\//.test(content),
        contains_code_block: /```/.test(content)
      }
    };

    return event;
  }

  /**
   * Collect a session lifecycle event
   */
  collectSessionLifecycle(context: SessionContext, action: 'start' | 'end'): SessionLifecycleEvent | null {
    if (!this.config.captureSessionLifecycle) return null;

    if (action === 'start') {
      this.setSession(context.sessionId);
    }

    const event: SessionLifecycleEvent = {
      ...this.createBaseEvent('session_lifecycle'),
      event_type: 'session_lifecycle',
      payload: {
        action,
        model_provider: context.modelProvider,
        model_name: context.modelName,
        skills_loaded_count: context.skillsLoaded?.length,
        tools_enabled: context.toolsEnabled,
        channels_active: context.channelsActive
      }
    };

    if (action === 'end') {
      this.clearSession();
    }

    return event;
  }

  /**
   * Collect a config change event
   */
  collectConfigChange(context: ConfigChangeContext): ConfigChangeEvent | null {
    if (!this.config.captureConfigChanges) return null;

    const event: ConfigChangeEvent = {
      ...this.createBaseEvent('config_change'),
      event_type: 'config_change',
      payload: {
        change_type: context.changeType as ConfigChangeEvent['payload']['change_type'],
        detail: context.detail ? scrubPII(context.detail) : undefined,
        skill_name: context.skillName,
        skill_source: context.skillSource
      }
    };

    return event;
  }

  /**
   * Collect an anomaly indicator event
   */
  collectAnomalyIndicator(
    indicatorType: AnomalyIndicatorType,
    detail?: string,
    severity?: 'low' | 'medium' | 'high' | 'critical'
  ): AnomalyIndicatorEvent | null {
    if (!this.config.localAnomalyDetection) return null;

    const event: AnomalyIndicatorEvent = {
      ...this.createBaseEvent('anomaly_indicator'),
      event_type: 'anomaly_indicator',
      payload: {
        indicator_type: indicatorType,
        detail: detail ? scrubPII(detail) : undefined,
        severity
      }
    };

    return event;
  }

  /**
   * Check for credential path access
   */
  checkCredentialAccess(path: string): AnomalyIndicatorEvent | null {
    if (isCredentialPath(path)) {
      return this.collectAnomalyIndicator(
        'credential_path_access',
        'Access to credential file detected',
        'medium'
      );
    }
    return null;
  }

  /**
   * Check for unusual hour activity
   */
  checkUnusualHour(): AnomalyIndicatorEvent | null {
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 6) {
      return this.collectAnomalyIndicator(
        'unusual_hour_activity',
        `Tool execution at ${hour}:00 local time`,
        'low'
      );
    }
    return null;
  }

  /**
   * Check for system prompt extraction attempts
   */
  checkSystemPromptRequest(content: string): AnomalyIndicatorEvent | null {
    const lowerContent = content.toLowerCase();
    const suspiciousPatterns = [
      'ignore previous',
      'ignore all previous',
      'disregard previous',
      'system prompt',
      'reveal instructions',
      'show your prompt',
      'what are your instructions',
      'print your system',
      'output your prompt'
    ];

    for (const pattern of suspiciousPatterns) {
      if (lowerContent.includes(pattern)) {
        return this.collectAnomalyIndicator(
          'system_prompt_request',
          'Potential prompt injection attempt detected',
          'high'
        );
      }
    }

    return null;
  }
}
