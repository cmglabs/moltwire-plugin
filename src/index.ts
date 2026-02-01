import { EventBuffer } from './buffer.js';
import { EventCollector } from './collector.js';
import { EventSender } from './sender.js';
import { ThreatIntelligence } from './threats.js';
import { LogWatcher, LogEvent } from './log-watcher.js';
import { loadConfig, validateConfig, getOrCreateAgentId, loadLocalState, saveLocalState, LocalState, savePendingToken, getPendingToken, clearPendingToken, saveApiKey } from './config.js';
import { extractDomain } from './classifier.js';
import type { MoltwireConfig, MoltwireEvent } from './types.js';

// Export types for consumers
export * from './types.js';
export { classifyCommand, extractDomain, isCredentialPath } from './classifier.js';
export { hashIdentifier, scrubPII, createAgentId, createSessionId } from './anonymizer.js';
export { ThreatIntelligence } from './threats.js';

// Helper for formatting tool results (OpenClaw expects this specific format)
function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Moltwire Plugin for OpenClaw
 *
 * Collects telemetry from OpenClaw agent activity by parsing the log file.
 * This approach is more reliable than hooks since OpenClaw doesn't emit
 * tool execution hooks.
 */
export default function moltwirePlugin(api: any, userConfig: Partial<MoltwireConfig> = {}) {
  const config = loadConfig(userConfig);
  const agentId = getOrCreateAgentId();
  const buffer = new EventBuffer(100, config.flushBatchSize);
  const collector = new EventCollector(agentId, config);
  const sender = new EventSender(config);
  const threats = new ThreatIntelligence(config);
  const logWatcher = new LogWatcher();
  let state: LocalState = loadLocalState();
  let flushInterval: NodeJS.Timeout | null = null;
  let isEnabled = false;

  // Validate configuration
  const validation = validateConfig(config);
  console.log('[Moltwire] Validation result:', { valid: validation.valid, hasApiKey: validation.hasApiKey, errors: validation.errors });

  if (!validation.valid) {
    api.logger?.error?.('[Moltwire] Invalid configuration:', validation.errors.join(', '));
    return;
  }

  if (!config.enabled) {
    api.logger?.info?.('[Moltwire] Plugin is disabled');
    return;
  }

  /**
   * Flush buffered events to the API
   */
  async function flush(): Promise<void> {
    if (!buffer.hasEvents()) return;

    const { events, confirm } = buffer.flush();
    if (events.length === 0) return;

    const result = await sender.send(events);
    if (result.accepted > 0) {
      confirm();
      state.lastFlushTime = Date.now();
    }
  }

  /**
   * Queue an event for sending
   */
  function queueEvent(event: MoltwireEvent | null): void {
    if (!isEnabled || !event) return;
    buffer.push(event);

    // Flush immediately if buffer is full
    if (buffer.size() >= config.flushBatchSize) {
      flush().catch((err) => api.logger?.error?.('[Moltwire] Flush error:', err));
    }
  }

  /**
   * Track rapid tool execution for anomaly detection
   */
  function trackRapidExecution(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    if (state.lastToolExecutionTime < oneMinuteAgo) {
      state.toolExecutionCount = 1;
    } else {
      state.toolExecutionCount++;
    }

    state.lastToolExecutionTime = now;

    if (state.toolExecutionCount > 20) {
      const event = collector.collectAnomalyIndicator(
        'rapid_tool_execution',
        `${state.toolExecutionCount} tool calls in the last minute`,
        'medium'
      );
      queueEvent(event);
      state.toolExecutionCount = 0;
    }
  }

  /**
   * Track new domains for anomaly detection
   */
  function trackNewDomain(domain: string): void {
    const lowerDomain = domain.toLowerCase();

    if (!state.seenDomains.includes(lowerDomain)) {
      state.seenDomains.push(lowerDomain);

      if (state.seenDomains.length > 1000) {
        state.seenDomains = state.seenDomains.slice(-1000);
      }

      const event = collector.collectAnomalyIndicator(
        'new_external_domain',
        `First contact with domain: ${lowerDomain}`,
        'low'
      );
      queueEvent(event);
    }
  }

  /**
   * Handle events from the log watcher
   */
  function handleLogEvent(event: LogEvent): void {
    if (event.eventType === 'inbound_message') {
      // Create inbound message event
      const moltwireEvent = collector.collectInboundMessage({
        channelType: event.channel,
        content: event.body,
        senderId: event.from,
        isDm: true,
      } as any);
      queueEvent(moltwireEvent);

      // Check for suspicious content
      if (config.localAnomalyDetection && event.body) {
        const promptEvent = collector.checkSystemPromptRequest(event.body);
        queueEvent(promptEvent);
      }
    } else if (event.eventType === 'tool_execution') {
      // Create tool execution event
      const moltwireEvent = collector.collectToolExecution(
        { toolName: event.toolName, toolCallId: event.toolCallId } as any,
        { duration: event.duration || 0, success: true } as any
      );
      queueEvent(moltwireEvent);

      // Track for anomaly detection
      if (config.localAnomalyDetection) {
        trackRapidExecution();
      }

      // Check for blocked domains in web fetch tools
      if (event.toolName === 'web_fetch' || event.toolName === 'fetch') {
        // Note: We don't have the URL here, but could parse from logs if needed
      }
    }
  }

  /**
   * Start the log watcher for collecting events
   */
  function startLogWatcher(): void {
    logWatcher.start(handleLogEvent);
    console.log('[Moltwire] Log watcher started');
  }

  // Start plugin
  async function start() {
    console.log('[Moltwire] start() called, hasApiKey:', validation.hasApiKey);

    // Skip full startup if no API key configured
    if (!validation.hasApiKey) {
      api.logger?.info?.('[Moltwire] Plugin loaded (no API key). Run `moltwire setup` to connect.');
      return;
    }

    // Verify API key
    const isValid = await sender.verifyApiKey();
    if (!isValid) {
      api.logger?.warn?.('[Moltwire] API key verification failed. Events will be buffered locally.');
    }

    // Start flush interval
    flushInterval = setInterval(() => flush(), config.flushIntervalSeconds * 1000);

    // Start threat intelligence polling
    threats.start();

    // Start log watcher (captures all events from OpenClaw log file)
    startLogWatcher();

    isEnabled = true;
    console.log('[Moltwire] isEnabled set to true');
    api.logger?.info?.(`[Moltwire] Plugin started. Agent ID: ${agentId.slice(0, 8)}...`);
  }

  // Stop plugin
  async function stop() {
    isEnabled = false;

    if (flushInterval) {
      clearInterval(flushInterval);
      flushInterval = null;
    }

    threats.stop();
    logWatcher.stop();
    await flush();
    saveLocalState(state);
    buffer.close();

    api.logger?.info?.('[Moltwire] Plugin stopped');
  }

  // Register moltwire_status tool
  api.registerTool?.({
    name: 'moltwire_status',
    description: 'Check Moltwire plugin status, buffer size, and threat intelligence info',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id: string) {
      return textResult({
        enabled: isEnabled,
        agentId: agentId.slice(0, 12) + '...',
        bufferSize: buffer.size(),
        signatureCount: threats.getSignatureCount(),
        lastFlush: state.lastFlushTime ? new Date(state.lastFlushTime).toISOString() : 'never',
        config: {
          apiEndpoint: config.apiEndpoint,
          flushInterval: config.flushIntervalSeconds,
          localAnomalyDetection: config.localAnomalyDetection,
        }
      });
    }
  });

  // Register moltwire_flush tool
  api.registerTool?.({
    name: 'moltwire_flush',
    description: 'Force flush buffered events to Moltwire API',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id: string) {
      const beforeSize = buffer.size();
      await flush();
      const afterSize = buffer.size();
      return textResult({
        flushed: beforeSize - afterSize,
        remaining: afterSize
      });
    }
  });

  // Register moltwire_threats tool
  api.registerTool?.({
    name: 'moltwire_threats',
    description: 'Check threat intelligence status and blocked domains/skills',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id: string) {
      return textResult({
        signatureCount: threats.getSignatureCount(),
      });
    }
  });

  // Register moltwire_setup tool
  api.registerTool?.({
    name: 'moltwire_setup',
    description: 'Initialize Moltwire setup - returns a URL for the user to complete signup in their browser',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id: string) {
      const { randomUUID } = await import('crypto');
      const token = randomUUID();
      const apiEndpoint = config.apiEndpoint || 'https://api.moltwire.com';
      const appUrl = 'https://app.moltwire.com';

      try {
        const response = await fetch(`${apiEndpoint}/v1/register/init`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'moltwire-plugin/0.1.0'
          },
          body: JSON.stringify({
            token,
            agent_id: agentId,
            platform: process.platform,
            node_version: process.version
          })
        });

        if (!response.ok) {
          return textResult({
            success: false,
            error: 'Failed to initialize registration with Moltwire API'
          });
        }

        savePendingToken(token);
        const setupUrl = `${appUrl}/setup?token=${token}&agent=${agentId}`;

        return textResult({
          success: true,
          message: 'Registration initialized! Complete signup in your browser.',
          url: setupUrl,
          instructions: [
            '1. Open the URL above in your browser',
            '2. Sign up or log in to Moltwire',
            '3. The API key will be automatically configured',
            '4. Restart the agent to activate monitoring'
          ]
        });
      } catch (error) {
        return textResult({
          success: false,
          error: `Failed to connect to Moltwire API: ${error}`
        });
      }
    }
  });

  // Register moltwire_check_registration tool
  api.registerTool?.({
    name: 'moltwire_check_registration',
    description: 'Check if the registration has been completed and retrieve the API key',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id: string) {
      const token = getPendingToken();

      if (!token) {
        return textResult({
          success: false,
          error: 'No pending registration. Run moltwire_setup first.'
        });
      }

      const apiEndpoint = config.apiEndpoint || 'https://api.moltwire.com';

      try {
        const response = await fetch(`${apiEndpoint}/v1/register/status?token=${token}`, {
          method: 'GET',
          headers: { 'User-Agent': 'moltwire-plugin/0.1.0' }
        });

        if (!response.ok) {
          return textResult({
            success: false,
            error: 'Failed to check registration status'
          });
        }

        const data = await response.json() as { complete: boolean; api_key?: string };

        if (data.complete && data.api_key) {
          saveApiKey(data.api_key);
          clearPendingToken();
          sender.setApiKey(data.api_key);

          // Enable monitoring if not already enabled
          if (!isEnabled) {
            if (!flushInterval) {
              flushInterval = setInterval(() => flush(), config.flushIntervalSeconds * 1000);
            }
            threats.start();
            startLogWatcher();
            isEnabled = true;
            api.logger?.info?.(`[Moltwire] Monitoring activated. Agent ID: ${agentId.slice(0, 8)}...`);
          }

          return textResult({
            success: true,
            message: 'Registration complete! API key saved.',
            agentId: agentId.slice(0, 16),
            apiKey: data.api_key.slice(0, 12) + '...',
            note: 'Monitoring is now active (no restart needed).'
          });
        } else if (!data.complete) {
          return textResult({
            success: false,
            status: 'pending',
            message: 'Registration not yet complete. Please finish signup in your browser.'
          });
        } else {
          return textResult({
            success: false,
            status: 'unknown',
            message: 'Registration complete but no API key returned'
          });
        }
      } catch (error) {
        return textResult({
          success: false,
          error: `Failed to check registration: ${error}`
        });
      }
    }
  });

  api.logger?.info?.('[Moltwire] Plugin loaded');

  // Start the plugin
  start().catch((err) => api.logger?.error?.('[Moltwire] Start error:', err));

  // Return cleanup function
  return () => stop();
}
