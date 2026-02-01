#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { createAgentId } from './anonymizer.js';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const MOLTWIRE_DIR = join(OPENCLAW_DIR, 'moltwire');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');
const AGENT_ID_FILE = join(MOLTWIRE_DIR, 'agent_id');

const DEFAULT_API_ENDPOINT = 'https://api.moltwire.com';
const DEFAULT_APP_URL = 'https://app.moltwire.com';

interface MoltwirePluginConfig {
  apiKey: string;
  apiEndpoint?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

interface OpenClawConfig {
  plugins?: Array<[string, MoltwirePluginConfig | Record<string, unknown>]>;
  [key: string]: unknown;
}

/**
 * Simple readline prompt
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Print colored output
 */
function log(message: string, color?: 'green' | 'red' | 'yellow' | 'cyan') {
  const colors: Record<string, string> = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
  };

  if (color) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

/**
 * Load existing OpenClaw config
 */
function loadConfig(): OpenClawConfig {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save OpenClaw config
 */
function saveConfig(config: OpenClawConfig): void {
  if (!existsSync(OPENCLAW_DIR)) {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get existing Moltwire config from OpenClaw config
 */
function getMoltwireConfig(config: OpenClawConfig): MoltwirePluginConfig | null {
  if (!config.plugins) return null;

  for (const plugin of config.plugins) {
    if (plugin[0] === '@moltwire/openclaw-plugin') {
      return plugin[1] as MoltwirePluginConfig;
    }
  }

  return null;
}

/**
 * Update Moltwire plugin config in OpenClaw config
 */
function setMoltwireConfig(config: OpenClawConfig, moltwireConfig: MoltwirePluginConfig): OpenClawConfig {
  if (!config.plugins) {
    config.plugins = [];
  }

  // Find and update existing, or add new
  let found = false;
  for (let i = 0; i < config.plugins.length; i++) {
    if (config.plugins[i][0] === '@moltwire/openclaw-plugin') {
      config.plugins[i][1] = moltwireConfig;
      found = true;
      break;
    }
  }

  if (!found) {
    config.plugins.push(['@moltwire/openclaw-plugin', moltwireConfig]);
  }

  return config;
}

/**
 * Validate API key format
 */
function isValidApiKeyFormat(key: string): boolean {
  return /^mw_(live|test)_[a-zA-Z0-9]{32,}$/.test(key);
}

/**
 * Open URL in default browser
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\nCouldn't open browser automatically. Please visit:\n${url}\n`);
    }
  });
}

/**
 * Initialize registration with the API
 */
async function initRegistration(
  token: string,
  agentId: string,
  apiEndpoint: string
): Promise<boolean> {
  try {
    const response = await fetch(`${apiEndpoint}/v1/register/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'moltwire-cli/0.1.0'
      },
      body: JSON.stringify({
        token,
        agent_id: agentId,
        platform: process.platform,
        node_version: process.version
      })
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Poll registration status
 */
async function pollRegistrationStatus(
  token: string,
  apiEndpoint: string,
  timeoutMs: number = 300000, // 5 minutes
  intervalMs: number = 2000
): Promise<{ complete: boolean; apiKey?: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(
        `${apiEndpoint}/v1/register/status?token=${encodeURIComponent(token)}`,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'moltwire-cli/0.1.0'
          }
        }
      );

      if (response.ok) {
        const data = await response.json() as { complete: boolean; api_key?: string };
        if (data.complete && data.api_key) {
          return { complete: true, apiKey: data.api_key };
        }
      } else if (response.status === 404) {
        // Token expired or not found
        return { complete: false };
      }
    } catch {
      // Network error, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { complete: false };
}

/**
 * Validate API key against the API
 */
async function validateApiKey(apiKey: string, apiEndpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiEndpoint}/v1/auth/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'moltwire-cli/0.1.0'
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get or create agent ID
 */
function getOrCreateAgentId(): string {
  if (!existsSync(MOLTWIRE_DIR)) {
    mkdirSync(MOLTWIRE_DIR, { recursive: true });
  }

  if (existsSync(AGENT_ID_FILE)) {
    const rawId = readFileSync(AGENT_ID_FILE, 'utf-8').trim();
    return createAgentId(rawId);
  }

  const rawId = randomUUID();
  writeFileSync(AGENT_ID_FILE, rawId, 'utf-8');
  return createAgentId(rawId);
}

/**
 * Send a test event to verify connection
 */
async function sendTestEvent(apiKey: string, apiEndpoint: string, agentId: string): Promise<boolean> {
  try {
    const testEvent = {
      events: [{
        event_id: randomUUID(),
        event_type: 'session_lifecycle',
        timestamp: new Date().toISOString(),
        agent_id: agentId,
        payload: {
          action: 'start',
          source: 'moltwire-cli-setup'
        }
      }]
    };

    const response = await fetch(`${apiEndpoint}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'moltwire-cli/0.1.0'
      },
      body: JSON.stringify(testEvent)
    });

    if (!response.ok) {
      return false;
    }

    const result = await response.json() as { accepted: number };
    return result.accepted > 0;
  } catch {
    return false;
  }
}

/**
 * Show current status
 */
async function showStatus(): Promise<void> {
  const config = loadConfig();
  const moltwireConfig = getMoltwireConfig(config);

  console.log('\n📊 Moltwire Status\n');

  if (!moltwireConfig) {
    log('❌ Not configured', 'red');
    console.log('\nRun `moltwire setup` to configure the plugin.');
    return;
  }

  console.log(`API Endpoint: ${moltwireConfig.apiEndpoint || DEFAULT_API_ENDPOINT}`);
  console.log(`API Key: ${moltwireConfig.apiKey.slice(0, 12)}...`);
  console.log(`Enabled: ${moltwireConfig.enabled !== false ? 'Yes' : 'No'}`);

  // Check agent ID
  if (existsSync(AGENT_ID_FILE)) {
    const rawId = readFileSync(AGENT_ID_FILE, 'utf-8').trim();
    const agentId = createAgentId(rawId);
    console.log(`Agent ID: ${agentId.slice(0, 8)}...`);
  }

  // Validate API key
  console.log('\nValidating API key...');
  const isValid = await validateApiKey(
    moltwireConfig.apiKey,
    moltwireConfig.apiEndpoint || DEFAULT_API_ENDPOINT
  );

  if (isValid) {
    log('✓ API key is valid', 'green');
  } else {
    log('✗ API key is invalid or expired', 'red');
  }

  console.log(`\nDashboard: https://app.moltwire.com`);
}

/**
 * Run the setup wizard (browser-based flow)
 */
async function runSetup(): Promise<void> {
  console.log('\n🦀 Moltwire Setup\n');
  console.log('This will connect your agent to Moltwire for security monitoring.\n');

  // Check for existing config
  const config = loadConfig();
  const existingConfig = getMoltwireConfig(config);

  if (existingConfig) {
    log('⚠ Moltwire is already configured.', 'yellow');
    console.log(`  API Key: ${existingConfig.apiKey.slice(0, 12)}...`);
    console.log('');

    const reconfigure = await prompt('Do you want to reconfigure? (y/N): ');
    if (reconfigure.toLowerCase() !== 'y') {
      console.log('\nSetup cancelled. Use `moltwire status` to view current configuration.');
      return;
    }
    console.log('');
  }

  const apiEndpoint = DEFAULT_API_ENDPOINT;
  const appUrl = DEFAULT_APP_URL;

  // Step 1: Generate agent ID and registration token
  console.log('Step 1: Preparing registration...');
  const agentId = getOrCreateAgentId();
  const token = randomUUID();

  log(`✓ Agent ID: ${agentId.slice(0, 8)}...`, 'green');

  // Step 2: Initialize registration with API
  console.log('\nStep 2: Initializing registration...');

  const initSuccess = await initRegistration(token, agentId, apiEndpoint);

  if (!initSuccess) {
    log('✗ Failed to initialize registration.', 'red');
    console.log('  Please check your network connection and try again.');
    console.log('  Or use manual setup with: moltwire setup --manual\n');
    return;
  }

  log('✓ Registration initialized', 'green');

  // Step 3: Open browser for signup/login
  console.log('\nStep 3: Opening browser for signup...');
  const setupUrl = `${appUrl}/dashboard/setup?token=${token}`;

  openBrowser(setupUrl);

  console.log('\n' + '─'.repeat(50));
  log('\n📱 Complete signup in your browser\n', 'cyan');
  console.log(`If the browser didn't open, visit:\n${setupUrl}\n`);
  console.log('─'.repeat(50));
  console.log('\nWaiting for you to complete signup...');
  console.log('(Press Ctrl+C to cancel)\n');

  // Step 4: Poll for completion
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${spinner[spinnerIndex]} Waiting for browser signup...`);
    spinnerIndex = (spinnerIndex + 1) % spinner.length;
  }, 100);

  const result = await pollRegistrationStatus(token, apiEndpoint);

  clearInterval(spinnerInterval);
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (!result.complete || !result.apiKey) {
    log('✗ Registration timed out or was cancelled.', 'red');
    console.log('  Please try again with: moltwire setup\n');
    return;
  }

  log('✓ Registration complete!', 'green');

  // Step 5: Validate the received API key
  console.log('\nStep 4: Validating API key...');

  const isValid = await validateApiKey(result.apiKey, apiEndpoint);

  if (!isValid) {
    log('✗ API key validation failed.', 'red');
    console.log('  Please try again or contact support.\n');
    return;
  }

  log('✓ API key is valid', 'green');

  // Step 6: Save configuration
  console.log('\nStep 5: Saving configuration...');

  const newMoltwireConfig: MoltwirePluginConfig = {
    apiKey: result.apiKey,
    apiEndpoint,
    enabled: true
  };

  const updatedConfig = setMoltwireConfig(config, newMoltwireConfig);
  saveConfig(updatedConfig);

  log('✓ Configuration saved', 'green');

  // Step 7: Send test event
  console.log('\nStep 6: Sending test event...');

  const testSuccess = await sendTestEvent(result.apiKey, apiEndpoint, agentId);

  if (testSuccess) {
    log('✓ Test event sent successfully', 'green');
  } else {
    log('⚠ Test event failed to send (will retry on next agent start)', 'yellow');
  }

  // Done!
  console.log('\n' + '═'.repeat(50));
  log('\n🎉 Setup complete!\n', 'green');
  console.log('Your agent is now connected to Moltwire.');
  console.log('Security events will be monitored and analyzed in real-time.\n');
  console.log('Next steps:');
  console.log('  1. Restart your OpenClaw agent to activate the plugin');
  console.log('  2. View your dashboard at https://app.moltwire.com/dashboard');
  console.log('');
}

/**
 * Run manual setup (paste API key)
 */
async function runManualSetup(): Promise<void> {
  console.log('\n🔧 Moltwire Manual Setup\n');
  console.log('This wizard will help you configure the Moltwire security plugin.\n');

  // Check for existing config
  const config = loadConfig();
  const existingConfig = getMoltwireConfig(config);

  if (existingConfig) {
    log('⚠ Moltwire is already configured.', 'yellow');
    console.log(`  API Key: ${existingConfig.apiKey.slice(0, 12)}...`);
    console.log('');

    const reconfigure = await prompt('Do you want to reconfigure? (y/N): ');
    if (reconfigure.toLowerCase() !== 'y') {
      console.log('\nSetup cancelled. Use `moltwire status` to view current configuration.');
      return;
    }
    console.log('');
  }

  // Step 1: Get API key
  console.log('Step 1: Enter your API key');
  console.log('  Get your API key from: https://app.moltwire.com/dashboard/setup\n');

  let apiKey = '';
  while (!apiKey) {
    apiKey = await prompt('API Key: ');

    if (!apiKey) {
      log('  API key is required.', 'red');
      continue;
    }

    if (!isValidApiKeyFormat(apiKey)) {
      log('  Invalid API key format. Keys should start with mw_live_ or mw_test_', 'red');
      apiKey = '';
      continue;
    }
  }

  // Step 2: Validate API key
  console.log('\nStep 2: Validating API key...');

  const apiEndpoint = DEFAULT_API_ENDPOINT;
  const isValid = await validateApiKey(apiKey, apiEndpoint);

  if (!isValid) {
    log('✗ API key validation failed.', 'red');
    console.log('  Please check your API key and try again.');
    console.log('  If the problem persists, visit https://app.moltwire.com/dashboard/setup\n');
    return;
  }

  log('✓ API key is valid', 'green');

  // Step 3: Save configuration
  console.log('\nStep 3: Saving configuration...');

  const newMoltwireConfig: MoltwirePluginConfig = {
    apiKey,
    apiEndpoint,
    enabled: true
  };

  const updatedConfig = setMoltwireConfig(config, newMoltwireConfig);
  saveConfig(updatedConfig);

  log('✓ Configuration saved', 'green');

  // Step 4: Generate agent ID
  console.log('\nStep 4: Generating agent ID...');
  const agentId = getOrCreateAgentId();
  log(`✓ Agent ID: ${agentId.slice(0, 8)}...`, 'green');

  // Step 5: Send test event
  console.log('\nStep 5: Sending test event...');

  const testSuccess = await sendTestEvent(apiKey, apiEndpoint, agentId);

  if (testSuccess) {
    log('✓ Test event sent successfully', 'green');
  } else {
    log('⚠ Test event failed to send (this is okay, will retry on next agent start)', 'yellow');
  }

  // Done!
  console.log('\n' + '═'.repeat(50));
  log('\n🎉 Setup complete!\n', 'green');
  console.log('Your agent is now connected to Moltwire.');
  console.log('Security events will be monitored and analyzed in real-time.\n');
  console.log('Next steps:');
  console.log('  1. Restart your OpenClaw agent to activate the plugin');
  console.log('  2. View your dashboard at https://app.moltwire.com/dashboard');
  console.log('');
}

/**
 * Show help
 */
function showHelp(): void {
  console.log(`
Moltwire CLI - Security & Observability for AI Agents

Usage:
  moltwire <command> [options]

Commands:
  setup            Connect your agent to Moltwire (opens browser)
  setup --manual   Configure with an existing API key
  status           Show current configuration and connection status
  help             Show this help message

Examples:
  moltwire setup          # Browser-based signup flow
  moltwire setup --manual # Paste an existing API key
  moltwire status         # Check if properly configured

Documentation:
  https://docs.moltwire.com

Dashboard:
  https://app.moltwire.com
`);
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const flags = args.slice(1);

  switch (command) {
    case 'setup':
      if (flags.includes('--manual') || flags.includes('-m')) {
        await runManualSetup();
      } else {
        await runSetup();
      }
      break;
    case 'status':
      await showStatus();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    case undefined:
      showHelp();
      break;
    default:
      log(`Unknown command: ${command}`, 'red');
      console.log('Run `moltwire help` for usage information.');
      process.exit(1);
  }
}

// Run CLI
main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
