import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MoltwireConfig } from './types.js';

const MOLTWIRE_DIR = join(homedir(), '.openclaw', 'moltwire');
const SIGNATURES_FILE = join(MOLTWIRE_DIR, 'signatures.json');
const BLOCKED_DOMAINS_FILE = join(MOLTWIRE_DIR, 'blocked_domains.json');
const BLOCKED_SKILLS_FILE = join(MOLTWIRE_DIR, 'blocked_skills.json');

// Poll interval: 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Signature types
export interface ThreatSignature {
  id: string;
  signature_type: string;
  pattern: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string | null;
  source_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ThreatSignaturesResponse {
  signatures: ThreatSignature[];
  total: number;
  last_updated: string | null;
}

interface BlockedListResponse {
  domains?: string[];
  skills?: string[];
  count: number;
}

interface CachedData<T> {
  data: T;
  fetchedAt: string;
}

/**
 * Threat intelligence polling and matching
 */
export class ThreatIntelligence {
  private apiEndpoint: string;
  private apiKey: string;
  private debug: boolean;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private signatures: ThreatSignature[] = [];
  private blockedDomains: Set<string> = new Set();
  private blockedSkills: Set<string> = new Set();
  private lastSignatureCount: number = 0;

  constructor(config: MoltwireConfig) {
    this.apiEndpoint = config.apiEndpoint;
    this.apiKey = config.apiKey;
    this.debug = config.debug;

    // Ensure directory exists
    if (!existsSync(MOLTWIRE_DIR)) {
      mkdirSync(MOLTWIRE_DIR, { recursive: true });
    }

    // Load cached data
    this.loadCachedData();
  }

  /**
   * Start polling for threat intelligence
   */
  start(): void {
    if (this.pollTimer) {
      return;
    }

    // Initial fetch
    this.fetchAll().catch((err) => {
      if (this.debug) {
        console.error('[Moltwire] Initial threat fetch failed:', err);
      }
    });

    // Set up polling
    this.pollTimer = setInterval(() => {
      this.fetchAll().catch((err) => {
        if (this.debug) {
          console.error('[Moltwire] Threat poll failed:', err);
        }
      });
    }, POLL_INTERVAL_MS);

    if (this.debug) {
      console.log('[Moltwire] Threat intelligence polling started');
    }
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Fetch all threat data
   */
  private async fetchAll(): Promise<void> {
    await Promise.all([
      this.fetchSignatures(),
      this.fetchBlockedDomains(),
      this.fetchBlockedSkills()
    ]);
  }

  /**
   * Fetch threat signatures from the API
   */
  private async fetchSignatures(): Promise<void> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/threats/signatures`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'moltwire-plugin/0.1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json() as ThreatSignaturesResponse;
      this.signatures = data.signatures;
      this.lastSignatureCount = data.total;

      // Cache the signatures
      this.cacheData(SIGNATURES_FILE, data.signatures);

      if (this.debug) {
        console.log(`[Moltwire] Fetched ${data.signatures.length} threat signatures`);
      }
    } catch (error) {
      if (this.debug) {
        console.error('[Moltwire] Failed to fetch signatures:', error);
      }
    }
  }

  /**
   * Fetch blocked domains list
   */
  private async fetchBlockedDomains(): Promise<void> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/threats/blocked-domains`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'moltwire-plugin/0.1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json() as BlockedListResponse;
      this.blockedDomains = new Set(data.domains || []);

      // Cache the list
      this.cacheData(BLOCKED_DOMAINS_FILE, data.domains || []);

      if (this.debug) {
        console.log(`[Moltwire] Fetched ${this.blockedDomains.size} blocked domains`);
      }
    } catch (error) {
      if (this.debug) {
        console.error('[Moltwire] Failed to fetch blocked domains:', error);
      }
    }
  }

  /**
   * Fetch blocked skills list
   */
  private async fetchBlockedSkills(): Promise<void> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/threats/blocked-skills`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'moltwire-plugin/0.1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json() as BlockedListResponse;
      this.blockedSkills = new Set(data.skills || []);

      // Cache the list
      this.cacheData(BLOCKED_SKILLS_FILE, data.skills || []);

      if (this.debug) {
        console.log(`[Moltwire] Fetched ${this.blockedSkills.size} blocked skills`);
      }
    } catch (error) {
      if (this.debug) {
        console.error('[Moltwire] Failed to fetch blocked skills:', error);
      }
    }
  }

  /**
   * Load cached data from disk
   */
  private loadCachedData(): void {
    try {
      if (existsSync(SIGNATURES_FILE)) {
        const cached = JSON.parse(readFileSync(SIGNATURES_FILE, 'utf-8')) as CachedData<ThreatSignature[]>;
        this.signatures = cached.data;
        this.lastSignatureCount = cached.data.length;
      }
    } catch {
      // Ignore errors, will fetch fresh data
    }

    try {
      if (existsSync(BLOCKED_DOMAINS_FILE)) {
        const cached = JSON.parse(readFileSync(BLOCKED_DOMAINS_FILE, 'utf-8')) as CachedData<string[]>;
        this.blockedDomains = new Set(cached.data);
      }
    } catch {
      // Ignore errors
    }

    try {
      if (existsSync(BLOCKED_SKILLS_FILE)) {
        const cached = JSON.parse(readFileSync(BLOCKED_SKILLS_FILE, 'utf-8')) as CachedData<string[]>;
        this.blockedSkills = new Set(cached.data);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Cache data to disk
   */
  private cacheData<T>(filepath: string, data: T): void {
    try {
      const cached: CachedData<T> = {
        data,
        fetchedAt: new Date().toISOString()
      };
      writeFileSync(filepath, JSON.stringify(cached, null, 2), 'utf-8');
    } catch (error) {
      if (this.debug) {
        console.error('[Moltwire] Failed to cache data:', error);
      }
    }
  }

  /**
   * Check if a domain is blocked
   */
  isDomainBlocked(domain: string): boolean {
    return this.blockedDomains.has(domain);
  }

  /**
   * Check if a skill is blocked
   */
  isSkillBlocked(skillName: string): boolean {
    return this.blockedSkills.has(skillName);
  }

  /**
   * Check if an action matches any threat signatures
   */
  matchSignatures(context: {
    domain?: string;
    skillName?: string;
    commandPattern?: string;
    toolName?: string;
  }): ThreatSignature[] {
    const matches: ThreatSignature[] = [];

    for (const sig of this.signatures) {
      if (this.matchesPattern(sig, context)) {
        matches.push(sig);
      }
    }

    return matches;
  }

  /**
   * Check if a signature pattern matches the context
   */
  private matchesPattern(
    signature: ThreatSignature,
    context: {
      domain?: string;
      skillName?: string;
      commandPattern?: string;
      toolName?: string;
    }
  ): boolean {
    const pattern = signature.pattern;

    switch (signature.signature_type) {
      case 'malicious_domain':
        return context.domain === pattern.domain;

      case 'malicious_skill':
        return context.skillName === pattern.skill_name;

      case 'coordinated_attack':
        // Check if the command pattern is in the sequence
        if (Array.isArray(pattern.sequence) && context.commandPattern) {
          return pattern.sequence.includes(context.commandPattern);
        }
        return false;

      case 'rapid_execution_network':
        // This is a network-wide indicator, not matched locally
        return false;

      default:
        return false;
    }
  }

  /**
   * Get the current signature count
   */
  getSignatureCount(): number {
    return this.lastSignatureCount;
  }

  /**
   * Get all loaded signatures
   */
  getSignatures(): ThreatSignature[] {
    return [...this.signatures];
  }

  /**
   * Get blocked domains list
   */
  getBlockedDomains(): string[] {
    return [...this.blockedDomains];
  }

  /**
   * Get blocked skills list
   */
  getBlockedSkills(): string[] {
    return [...this.blockedSkills];
  }

  /**
   * Update API key (e.g., after reconfiguration)
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Update API endpoint
   */
  setEndpoint(endpoint: string): void {
    this.apiEndpoint = endpoint;
  }

  /**
   * Force an immediate refresh of threat data
   */
  async refresh(): Promise<void> {
    await this.fetchAll();
  }
}
