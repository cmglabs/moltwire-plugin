import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { createAgentId } from './anonymizer.js';
import type { MoltwireConfig } from './types.js';

const MOLTWIRE_DIR = join(homedir(), '.openclaw', 'moltwire');
const AGENT_ID_FILE = join(MOLTWIRE_DIR, 'agent_id');
const STATE_FILE = join(MOLTWIRE_DIR, 'state.json');

// Default configuration
const DEFAULT_CONFIG: MoltwireConfig = {
  enabled: true,
  apiKey: '',
  apiEndpoint: 'https://api.moltwire.dev',
  flushIntervalSeconds: 30,
  flushBatchSize: 50,
  redactPatterns: true,
  localAnomalyDetection: true,
  captureToolExecution: true,
  captureInboundMessages: true,
  captureSessionLifecycle: true,
  captureConfigChanges: true,
  debug: false
};

/**
 * Merge user config with defaults
 */
export function loadConfig(userConfig: Partial<MoltwireConfig>): MoltwireConfig {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig
  };
}

/**
 * Validate the configuration
 */
export function validateConfig(config: MoltwireConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.apiKey) {
    errors.push('apiKey is required');
  } else if (!config.apiKey.startsWith('mw_')) {
    errors.push('apiKey must start with "mw_"');
  }

  if (config.flushIntervalSeconds < 5) {
    errors.push('flushIntervalSeconds must be at least 5');
  }

  if (config.flushBatchSize < 1 || config.flushBatchSize > 100) {
    errors.push('flushBatchSize must be between 1 and 100');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Get or create the agent ID
 * The raw UUID is stored locally and never sent to the server
 * Only the hashed version is used as the agent_id
 */
export function getOrCreateAgentId(): string {
  // Ensure directory exists
  if (!existsSync(MOLTWIRE_DIR)) {
    mkdirSync(MOLTWIRE_DIR, { recursive: true });
  }

  // Check if we already have an agent ID
  if (existsSync(AGENT_ID_FILE)) {
    const rawId = readFileSync(AGENT_ID_FILE, 'utf-8').trim();
    return createAgentId(rawId);
  }

  // Generate a new UUID and hash it
  const rawId = randomUUID();
  writeFileSync(AGENT_ID_FILE, rawId, 'utf-8');
  return createAgentId(rawId);
}

/**
 * Local state management (for anomaly detection)
 */
export interface LocalState {
  seenDomains: string[];
  lastToolExecutionTime: number;
  toolExecutionCount: number;
  lastFileReadTime: number;
  fileReadCount: number;
  lastFlushTime: number;
}

const DEFAULT_STATE: LocalState = {
  seenDomains: [],
  lastToolExecutionTime: 0,
  toolExecutionCount: 0,
  lastFileReadTime: 0,
  fileReadCount: 0,
  lastFlushTime: 0
};

/**
 * Load local state
 */
export function loadLocalState(): LocalState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = readFileSync(STATE_FILE, 'utf-8');
      return { ...DEFAULT_STATE, ...JSON.parse(data) };
    }
  } catch {
    // Return default state on error
  }
  return { ...DEFAULT_STATE };
}

/**
 * Save local state
 */
export function saveLocalState(state: LocalState): void {
  try {
    if (!existsSync(MOLTWIRE_DIR)) {
      mkdirSync(MOLTWIRE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[Moltwire] Failed to save local state:', error);
  }
}
