import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { createAgentId } from './anonymizer.js';
import type { MoltwireConfig } from './types.js';

const MOLTWIRE_DIR = join(homedir(), '.openclaw', 'moltwire');
const AGENT_ID_FILE = join(MOLTWIRE_DIR, 'agent_id');
const STATE_FILE = join(MOLTWIRE_DIR, 'state.json');
const CONFIG_FILE = join(MOLTWIRE_DIR, 'config.json');
const API_KEY_FILE = join(MOLTWIRE_DIR, 'api_key');
const PENDING_TOKEN_FILE = join(MOLTWIRE_DIR, 'pending_token');

// Default configuration
const DEFAULT_CONFIG: MoltwireConfig = {
  enabled: true,
  apiKey: '',
  apiEndpoint: 'https://api.moltwire.com',
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
 * Load config from file if it exists
 */
function loadConfigFromFile(): Partial<MoltwireConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors reading config file
  }
  return {};
}

/**
 * Load API key from dedicated file if it exists
 */
function loadApiKeyFromFile(): string {
  try {
    if (existsSync(API_KEY_FILE)) {
      return readFileSync(API_KEY_FILE, 'utf-8').trim();
    }
  } catch {
    // Ignore errors reading API key file
  }
  return '';
}

/**
 * Save API key to dedicated file
 */
export function saveApiKey(apiKey: string): void {
  try {
    if (!existsSync(MOLTWIRE_DIR)) {
      mkdirSync(MOLTWIRE_DIR, { recursive: true });
    }
    writeFileSync(API_KEY_FILE, apiKey, 'utf-8');
  } catch (error) {
    console.error('[Moltwire] Failed to save API key:', error);
  }
}

/**
 * Save pending registration token
 */
export function savePendingToken(token: string): void {
  try {
    if (!existsSync(MOLTWIRE_DIR)) {
      mkdirSync(MOLTWIRE_DIR, { recursive: true });
    }
    writeFileSync(PENDING_TOKEN_FILE, token, 'utf-8');
  } catch (error) {
    console.error('[Moltwire] Failed to save pending token:', error);
  }
}

/**
 * Get pending registration token
 */
export function getPendingToken(): string | null {
  try {
    if (existsSync(PENDING_TOKEN_FILE)) {
      return readFileSync(PENDING_TOKEN_FILE, 'utf-8').trim();
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Clear pending registration token
 */
export function clearPendingToken(): void {
  try {
    if (existsSync(PENDING_TOKEN_FILE)) {
      writeFileSync(PENDING_TOKEN_FILE, '', 'utf-8');
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Merge user config with defaults, also checking config file and api-key file
 */
export function loadConfig(userConfig: Partial<MoltwireConfig>): MoltwireConfig {
  // Load from file first, then override with userConfig
  const fileConfig = loadConfigFromFile();
  const fileApiKey = loadApiKeyFromFile();

  // Debug logging
  console.log('[Moltwire] loadConfig debug:', {
    userConfigApiKey: userConfig.apiKey,
    fileApiKey: fileApiKey ? fileApiKey.slice(0, 12) + '...' : 'none',
    fileConfigApiKey: fileConfig.apiKey ? fileConfig.apiKey.slice(0, 12) + '...' : 'none',
  });

  // Determine API key priority: userConfig > api-key file > config.json > default
  const apiKey = userConfig.apiKey || fileApiKey || fileConfig.apiKey || DEFAULT_CONFIG.apiKey;

  console.log('[Moltwire] Final apiKey:', apiKey ? apiKey.slice(0, 12) + '...' : 'none');

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...userConfig,
    apiKey
  };
}

/**
 * Validate the configuration
 * Note: apiKey is optional - plugin loads but doesn't send events without it
 */
export function validateConfig(config: MoltwireConfig): { valid: boolean; errors: string[]; hasApiKey: boolean } {
  const errors: string[] = [];
  const hasApiKey = !!config.apiKey && config.apiKey.startsWith('mw_');

  // Only validate apiKey format if it's provided
  if (config.apiKey && !config.apiKey.startsWith('mw_')) {
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
    errors,
    hasApiKey
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
