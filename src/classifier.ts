import type { CommandPattern, ToolContext } from './types.js';

// Known credential paths
const CREDENTIAL_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  'auth-profiles.json',
  'credentials',
  '.ssh',
  '.aws',
  '.gcloud',
  '.azure',
  '.kube/config',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  '.gnupg',
  'secrets',
  'tokens',
  'api_keys',
  '.netrc'
];

// Config paths
const CONFIG_PATHS = [
  '.config',
  '.local',
  'Library/Preferences',
  'Library/Application Support',
  'AppData',
  '/etc'
];

// External network indicators
const EXTERNAL_INDICATORS = [
  'http://',
  'https://',
  'ftp://'
];

const LOCALHOST_PATTERNS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1'
];

/**
 * Classify a tool execution into a command pattern
 */
export function classifyCommand(context: ToolContext): CommandPattern {
  const { toolName, command, args } = context;
  const fullCommand = command || args?.join(' ') || '';
  const lowerCommand = fullCommand.toLowerCase();
  const lowerToolName = toolName.toLowerCase();

  // Browser operations
  if (lowerToolName === 'browser' || lowerToolName.includes('browser')) {
    if (lowerCommand.includes('navigate') || lowerCommand.includes('goto') || lowerCommand.includes('url')) {
      return 'browser_navigate';
    }
    if (lowerCommand.includes('fill') || lowerCommand.includes('type') || lowerCommand.includes('input')) {
      return 'browser_form_fill';
    }
    return 'browser_navigate';
  }

  // Network operations
  if (lowerToolName === 'exec' || lowerToolName === 'shell' || lowerToolName === 'bash') {
    // SSH
    if (lowerCommand.startsWith('ssh ') || lowerCommand.startsWith('scp ')) {
      return 'ssh_connection';
    }

    // Docker
    if (lowerCommand.startsWith('docker ')) {
      return 'docker_operation';
    }

    // Git
    if (lowerCommand.startsWith('git ')) {
      return 'git_operation';
    }

    // NPM/package managers
    if (
      lowerCommand.startsWith('npm ') ||
      lowerCommand.startsWith('pnpm ') ||
      lowerCommand.startsWith('yarn ') ||
      lowerCommand.startsWith('bun ')
    ) {
      if (lowerCommand.includes('install') || lowerCommand.includes('add')) {
        return 'npm_install';
      }
    }

    // Curl/wget
    if (lowerCommand.startsWith('curl ') || lowerCommand.startsWith('wget ')) {
      const isLocal = LOCALHOST_PATTERNS.some(p => lowerCommand.includes(p));
      return isLocal ? 'curl_internal' : 'curl_external';
    }

    // Process spawning
    if (lowerCommand.includes('spawn') || lowerCommand.includes('exec') || lowerCommand.includes('&')) {
      return 'process_spawn';
    }
  }

  // File operations
  if (lowerToolName === 'read' || lowerToolName === 'file_read') {
    return classifyFileRead(fullCommand);
  }

  if (lowerToolName === 'write' || lowerToolName === 'file_write') {
    return 'file_write';
  }

  if (lowerToolName === 'delete' || lowerToolName === 'rm' || lowerCommand.includes('rm ')) {
    return 'file_delete';
  }

  return 'unknown';
}

/**
 * Classify a file read operation based on the path
 */
function classifyFileRead(pathOrCommand: string): CommandPattern {
  const path = pathOrCommand.toLowerCase();

  // Check for credential paths
  for (const credPath of CREDENTIAL_PATHS) {
    if (path.includes(credPath.toLowerCase())) {
      return 'file_read_credential';
    }
  }

  // Check for config paths
  for (const configPath of CONFIG_PATHS) {
    if (path.includes(configPath.toLowerCase())) {
      return 'file_read_config';
    }
  }

  // Home directory
  if (path.includes('~') || path.includes('/home/') || path.includes('/users/')) {
    return 'file_read_home';
  }

  return 'file_read_home';
}

/**
 * Extract domain from a command string
 */
export function extractDomain(command: string): string | undefined {
  // Try to find URLs in the command
  const urlMatch = command.match(/https?:\/\/([^\/\s:]+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  // Try to find host patterns like user@host
  const sshMatch = command.match(/@([^:\s\/]+)/);
  if (sshMatch) {
    return sshMatch[1];
  }

  return undefined;
}

/**
 * Check if a file path is a credential path
 */
export function isCredentialPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return CREDENTIAL_PATHS.some(credPath => lowerPath.includes(credPath.toLowerCase()));
}
