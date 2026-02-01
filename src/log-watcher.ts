import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';

export interface ToolExecutionEvent {
  eventType: 'tool_execution';
  runId: string;
  toolName: string;
  toolCallId: string;
  timestamp: string;
  duration?: number;
}

export interface InboundMessageEvent {
  eventType: 'inbound_message';
  from: string;
  to: string;
  body: string;
  timestamp: string;
  channel: string;
}

export type LogEvent = ToolExecutionEvent | InboundMessageEvent;
export type LogEventCallback = (event: LogEvent) => void;

/**
 * Watches OpenClaw log file for all events
 * Captures tool executions and inbound messages by parsing the log
 */
export class LogWatcher {
  private tailProcess: ChildProcess | null = null;
  private callback: LogEventCallback | null = null;
  private logPath: string;
  private pendingTools: Map<string, { toolName: string; toolCallId: string; startTime: string }> = new Map();
  private seenMessageTimestamps: Set<number> = new Set(); // Dedupe messages

  constructor() {
    // OpenClaw logs to /tmp/openclaw/openclaw-YYYY-MM-DD.log
    const today = new Date().toISOString().split('T')[0];
    this.logPath = `/tmp/openclaw/openclaw-${today}.log`;
  }

  /**
   * Start watching the log file
   */
  start(callback: LogEventCallback): void {
    this.callback = callback;

    if (!existsSync(this.logPath)) {
      console.log(`[Moltwire] Log file not found: ${this.logPath}, will retry...`);
      setTimeout(() => this.start(callback), 10000);
      return;
    }

    console.log(`[Moltwire] Starting log watcher on ${this.logPath}`);

    // Use tail -F to follow the log file (handles rotation)
    this.tailProcess = spawn('tail', ['-F', '-n', '0', this.logPath]);

    this.tailProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        this.parseLine(line);
      }
    });

    this.tailProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (!msg.includes('truncated')) {
        console.error('[Moltwire] Log watcher error:', msg);
      }
    });

    this.tailProcess.on('close', (code) => {
      console.log(`[Moltwire] Log watcher closed with code ${code}`);
      if (code !== null && this.callback) {
        setTimeout(() => this.start(this.callback!), 5000);
      }
    });
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.tailProcess) {
      this.tailProcess.kill();
      this.tailProcess = null;
    }
    this.callback = null;
  }

  /**
   * Parse a log line for events
   */
  private parseLine(line: string): void {
    try {
      const json = JSON.parse(line);

      // Check for inbound message
      if (json['2'] === 'inbound message' && json['1']?.body) {
        this.handleInboundMessage(json);
        return;
      }

      // Check for tool execution
      const message = json['1'] as string;
      if (typeof message === 'string' && message.includes('embedded run tool')) {
        this.handleToolExecution(json, message);
        return;
      }
    } catch {
      // Ignore parse errors - not all lines are JSON
    }
  }

  /**
   * Handle inbound message log entry
   */
  private handleInboundMessage(json: any): void {
    const msg = json['1'];
    const timestamp = json['time'] || json['_meta']?.date;
    const msgTimestamp = msg.timestamp as number;

    // Dedupe by message timestamp
    if (this.seenMessageTimestamps.has(msgTimestamp)) {
      return;
    }
    this.seenMessageTimestamps.add(msgTimestamp);

    // Keep set from growing too large
    if (this.seenMessageTimestamps.size > 1000) {
      const arr = Array.from(this.seenMessageTimestamps);
      this.seenMessageTimestamps = new Set(arr.slice(-500));
    }

    // Determine channel from module name
    const moduleName = json['0'] || '';
    let channel = 'unknown';
    if (moduleName.includes('whatsapp') || moduleName.includes('web-inbound')) {
      channel = 'whatsapp';
    } else if (moduleName.includes('telegram')) {
      channel = 'telegram';
    } else if (moduleName.includes('discord')) {
      channel = 'discord';
    }

    console.log('[Moltwire] Inbound message from log:', channel, msg.body?.slice(0, 30) + '...');

    this.callback?.({
      eventType: 'inbound_message',
      from: msg.from || '',
      to: msg.to || '',
      body: msg.body || '',
      timestamp: timestamp || new Date(msgTimestamp).toISOString(),
      channel
    });
  }

  /**
   * Handle tool execution log entry
   */
  private handleToolExecution(json: any, message: string): void {
    const timestamp = json['time'] || json['_meta']?.date;

    // Parse "embedded run tool start: runId=xxx tool=yyy toolCallId=zzz"
    const startMatch = message.match(/embedded run tool start: runId=(\S+) tool=(\S+) toolCallId=(\S+)/);
    const endMatch = message.match(/embedded run tool end: runId=(\S+) tool=(\S+) toolCallId=(\S+)/);

    if (startMatch) {
      const [, runId, toolName, toolCallId] = startMatch;
      this.pendingTools.set(runId, { toolName, toolCallId, startTime: timestamp });
    } else if (endMatch) {
      const [, runId, toolName, toolCallId] = endMatch;
      const pending = this.pendingTools.get(runId);
      this.pendingTools.delete(runId);

      const duration = pending
        ? new Date(timestamp).getTime() - new Date(pending.startTime).getTime()
        : 0;

      console.log('[Moltwire] Tool execution from log:', toolName, 'duration:', duration, 'ms');

      this.callback?.({
        eventType: 'tool_execution',
        runId,
        toolName,
        toolCallId,
        timestamp,
        duration
      });
    }
  }
}
