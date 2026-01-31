import { createHash } from 'crypto';

// PII patterns to scrub
const PII_PATTERNS = [
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,

  // Phone numbers (various formats)
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,

  // IP addresses
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,

  // Credit card numbers (basic pattern)
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,

  // SSN
  /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g,

  // API keys and tokens (common patterns)
  /\b(sk|pk|api|key|token|secret|password|auth)[-_]?[a-zA-Z0-9]{20,}\b/gi,

  // File paths with usernames (macOS/Linux)
  /\/Users\/[^\/\s]+/g,
  /\/home\/[^\/\s]+/g,

  // Windows user paths
  /C:\\Users\\[^\\\/\s]+/gi
];

// Replacement token for scrubbed data
const REDACTED = '[REDACTED]';

/**
 * Generate a consistent hash for an identifier
 * Uses SHA-256 and returns first 16 characters
 */
export function hashIdentifier(value: string, salt?: string): string {
  const input = salt ? `${salt}:${value}` : value;
  return createHash('sha256').update(input).digest('hex').slice(0, 64);
}

/**
 * Scrub potential PII from a string
 */
export function scrubPII(text: string): string {
  let scrubbed = text;

  for (const pattern of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, REDACTED);
  }

  return scrubbed;
}

/**
 * Anonymize an object by scrubbing string values
 */
export function anonymizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = scrubPII(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = anonymizeObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Create a deterministic agent ID from a UUID
 * This ensures the same local UUID always produces the same hashed ID
 */
export function createAgentId(instanceId: string): string {
  return hashIdentifier(instanceId, 'moltwire-agent');
}

/**
 * Create a deterministic session ID
 */
export function createSessionId(sessionId: string, agentId: string): string {
  return hashIdentifier(`${agentId}:${sessionId}`, 'moltwire-session');
}
