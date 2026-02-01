import { EventBuffer } from './buffer.js';
import { EventCollector } from './collector.js';
import { EventSender } from './sender.js';
import { ThreatIntelligence } from './threats.js';
import { loadConfig, validateConfig, getOrCreateAgentId, loadLocalState, saveLocalState, LocalState } from './config.js';
import { extractDomain, classifyCommand } from './classifier.js';
import type {
  MoltwireConfig,
  MoltwireEvent,
  ToolContext,
  ToolResult,
  MessageContext,
  SessionContext,
  ConfigChangeContext
} from './types.js';

// Export types for consumers
export * from './types.js';
export { classifyCommand, extractDomain, isCredentialPath } from './classifier.js';
export { hashIdentifier, scrubPII, createAgentId, createSessionId } from './anonymizer.js';
export { ThreatIntelligence } from './threats.js';

/**
 * Moltwire Plugin for OpenClaw
 *
 * This plugin collects telemetry from OpenClaw agent activity,
 * anonymizes it, and sends it to the Moltwire API for security
 * analysis and threat detection.
 */
export class MoltwirePlugin {
  private config: MoltwireConfig;
  private buffer: EventBuffer;
  private collector: EventCollector;
  private sender: EventSender;
  private threats: ThreatIntelligence;
  private state: LocalState;
  private flushInterval: NodeJS.Timeout | null = null;
  private isEnabled: boolean = false;
  private agentId: string;

  constructor(userConfig: Partial<MoltwireConfig>) {
    this.config = loadConfig(userConfig);
    this.agentId = getOrCreateAgentId();
    this.buffer = new EventBuffer(100, this.config.flushBatchSize);
    this.collector = new EventCollector(this.agentId, this.config);
    this.sender = new EventSender(this.config);
    this.threats = new ThreatIntelligence(this.config);
    this.state = loadLocalState();
  }

  /**
   * Initialize and start the plugin
   */
  async start(): Promise<boolean> {
    // Validate configuration
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      console.error('[Moltwire] Invalid configuration:', validation.errors.join(', '));
      return false;
    }

    if (!this.config.enabled) {
      console.log('[Moltwire] Plugin is disabled');
      return false;
    }

    // Verify API key
    if (this.config.debug) {
      console.log('[Moltwire] Verifying API key...');
    }

    const isValid = await this.sender.verifyApiKey();
    if (!isValid) {
      console.warn('[Moltwire] API key verification failed. Events will be buffered locally.');
    }

    // Start flush interval
    this.flushInterval = setInterval(
      () => this.flush(),
      this.config.flushIntervalSeconds * 1000
    );

    // Start threat intelligence polling
    this.threats.start();

    this.isEnabled = true;
    console.log(`[Moltwire] Plugin started. Agent ID: ${this.agentId.slice(0, 8)}...`);

    return true;
  }

  /**
   * Stop the plugin
   */
  async stop(): Promise<void> {
    this.isEnabled = false;

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Stop threat intelligence polling
    this.threats.stop();

    // Final flush
    await this.flush();

    // Save state
    saveLocalState(this.state);

    // Close buffer
    this.buffer.close();

    console.log('[Moltwire] Plugin stopped');
  }

  /**
   * Flush buffered events to the API
   */
  private async flush(): Promise<void> {
    if (!this.buffer.hasEvents()) return;

    const { events, confirm } = this.buffer.flush();

    if (events.length === 0) return;

    const result = await this.sender.send(events);

    if (result.accepted > 0) {
      confirm();
      this.state.lastFlushTime = Date.now();
    }
  }

  /**
   * Queue an event for sending
   */
  private queueEvent(event: MoltwireEvent | null): void {
    if (!this.isEnabled || !event) return;
    this.buffer.push(event);

    // Flush immediately if buffer is full
    if (this.buffer.size() >= this.config.flushBatchSize) {
      this.flush().catch(console.error);
    }
  }

  // ========== Hook Handlers ==========

  /**
   * Handle tool:before hook
   */
  onToolBefore(context: ToolContext): void {
    // Track timing for duration calculation
    (context as any).__moltwire_start = Date.now();
  }

  /**
   * Handle tool:after hook
   */
  onToolAfter(context: ToolContext, result: ToolResult): void {
    const startTime = (context as any).__moltwire_start || Date.now();
    const duration = Date.now() - startTime;

    // Create tool execution event
    const event = this.collector.collectToolExecution(context, {
      ...result,
      duration
    });
    this.queueEvent(event);

    // Extract domain and command pattern for threat checking
    const commandStr = context.command || context.args?.join(' ') || '';
    const domain = extractDomain(commandStr);
    const commandPattern = classifyCommand(context);

    // Check against threat intelligence
    if (domain && this.threats.isDomainBlocked(domain)) {
      const anomalyEvent = this.collector.collectAnomalyIndicator(
        'matched_threat_signature',
        `Blocked domain accessed: ${domain}`,
        'critical'
      );
      this.queueEvent(anomalyEvent);
    }

    // Check for signature matches
    const matches = this.threats.matchSignatures({
      domain,
      commandPattern,
      toolName: context.toolName
    });

    for (const match of matches) {
      const anomalyEvent = this.collector.collectAnomalyIndicator(
        'matched_threat_signature',
        `Matched threat signature: ${match.title}`,
        match.severity
      );
      this.queueEvent(anomalyEvent);
    }

    // Check for anomalies
    if (this.config.localAnomalyDetection) {
      // Check for credential access
      const credentialEvent = this.collector.checkCredentialAccess(commandStr);
      this.queueEvent(credentialEvent);

      // Check for unusual hour
      const unusualHourEvent = this.collector.checkUnusualHour();
      this.queueEvent(unusualHourEvent);

      // Track rapid tool execution
      this.trackRapidExecution();

      // Track new domains
      if (domain) {
        this.trackNewDomain(domain);
      }
    }
  }

  /**
   * Handle message:received hook
   */
  onMessageReceived(context: MessageContext): void {
    // Create inbound message event
    const event = this.collector.collectInboundMessage(context);
    this.queueEvent(event);

    // Check for prompt injection attempts
    if (this.config.localAnomalyDetection && context.content) {
      const promptEvent = this.collector.checkSystemPromptRequest(context.content);
      this.queueEvent(promptEvent);
    }
  }

  /**
   * Handle session:start hook
   */
  onSessionStart(context: SessionContext): void {
    const event = this.collector.collectSessionLifecycle(context, 'start');
    this.queueEvent(event);
  }

  /**
   * Handle session:end hook
   */
  onSessionEnd(context: SessionContext): void {
    const event = this.collector.collectSessionLifecycle(context, 'end');
    this.queueEvent(event);
  }

  /**
   * Handle config:changed hook
   */
  onConfigChanged(context: ConfigChangeContext): void {
    const event = this.collector.collectConfigChange(context);
    this.queueEvent(event);

    // Check against threat intelligence for skill installs
    if (context.changeType === 'skill_installed' && context.skillName) {
      // Check if skill is blocked
      if (this.threats.isSkillBlocked(context.skillName)) {
        const anomalyEvent = this.collector.collectAnomalyIndicator(
          'matched_threat_signature',
          `Blocked skill installed: ${context.skillName}`,
          'critical'
        );
        this.queueEvent(anomalyEvent);
      }

      // Check for signature matches
      const matches = this.threats.matchSignatures({
        skillName: context.skillName
      });

      for (const match of matches) {
        const anomalyEvent = this.collector.collectAnomalyIndicator(
          'matched_threat_signature',
          `Matched threat signature for skill: ${match.title}`,
          match.severity
        );
        this.queueEvent(anomalyEvent);
      }
    }

    // Check for untrusted skill installs
    if (
      this.config.localAnomalyDetection &&
      context.changeType === 'skill_installed' &&
      context.skillSource &&
      context.skillSource !== 'clawhub'
    ) {
      const anomalyEvent = this.collector.collectAnomalyIndicator(
        'skill_installs_untrusted',
        `Skill installed from ${context.skillSource}`,
        'medium'
      );
      this.queueEvent(anomalyEvent);
    }
  }

  // ========== Anomaly Detection Helpers ==========

  /**
   * Track rapid tool execution
   */
  private trackRapidExecution(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    if (this.state.lastToolExecutionTime < oneMinuteAgo) {
      // Reset counter if more than a minute has passed
      this.state.toolExecutionCount = 1;
    } else {
      this.state.toolExecutionCount++;
    }

    this.state.lastToolExecutionTime = now;

    if (this.state.toolExecutionCount > 20) {
      const event = this.collector.collectAnomalyIndicator(
        'rapid_tool_execution',
        `${this.state.toolExecutionCount} tool calls in the last minute`,
        'medium'
      );
      this.queueEvent(event);

      // Reset to prevent flooding
      this.state.toolExecutionCount = 0;
    }
  }

  /**
   * Track new domains
   */
  private trackNewDomain(domain: string): void {
    const lowerDomain = domain.toLowerCase();

    if (!this.state.seenDomains.includes(lowerDomain)) {
      this.state.seenDomains.push(lowerDomain);

      // Keep only last 1000 domains
      if (this.state.seenDomains.length > 1000) {
        this.state.seenDomains = this.state.seenDomains.slice(-1000);
      }

      const event = this.collector.collectAnomalyIndicator(
        'new_external_domain',
        `First contact with domain: ${lowerDomain}`,
        'low'
      );
      this.queueEvent(event);
    }
  }

  // ========== Getters ==========

  /**
   * Get the agent ID
   */
  getAgentId(): string {
    return this.agentId;
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.size();
  }

  /**
   * Check if plugin is enabled
   */
  isPluginEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Get threat intelligence instance
   */
  getThreatIntelligence(): ThreatIntelligence {
    return this.threats;
  }

  /**
   * Get count of active threat signatures
   */
  getSignatureCount(): number {
    return this.threats.getSignatureCount();
  }

  /**
   * Check if a domain is blocked
   */
  isDomainBlocked(domain: string): boolean {
    return this.threats.isDomainBlocked(domain);
  }

  /**
   * Check if a skill is blocked
   */
  isSkillBlocked(skillName: string): boolean {
    return this.threats.isSkillBlocked(skillName);
  }

  /**
   * Force refresh threat intelligence
   */
  async refreshThreatData(): Promise<void> {
    await this.threats.refresh();
  }
}

// Default export for OpenClaw plugin loader
export default MoltwirePlugin;

/**
 * OpenClaw plugin entry point
 * This function is called by OpenClaw when the plugin is loaded
 */
export function activate(config: Partial<MoltwireConfig>): MoltwirePlugin {
  const plugin = new MoltwirePlugin(config);
  plugin.start().catch(console.error);
  return plugin;
}

/**
 * OpenClaw plugin deactivation
 */
export function deactivate(plugin: MoltwirePlugin): Promise<void> {
  return plugin.stop();
}
