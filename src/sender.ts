import type { MoltwireEvent, EventBatchResponse, MoltwireConfig } from './types.js';

/**
 * HTTP sender for transmitting events to the Moltwire API
 */
export class EventSender {
  private apiEndpoint: string;
  private apiKey: string;
  private debug: boolean;

  constructor(config: MoltwireConfig) {
    this.apiEndpoint = config.apiEndpoint;
    this.apiKey = config.apiKey;
    this.debug = config.debug;
  }

  /**
   * Send a batch of events to the API
   */
  async send(events: MoltwireEvent[]): Promise<EventBatchResponse> {
    if (events.length === 0) {
      return { accepted: 0, rejected: 0 };
    }

    const url = `${this.apiEndpoint}/v1/events`;

    if (this.debug) {
      console.log(`[Moltwire] Sending ${events.length} events to ${url}`);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'moltwire-plugin/0.1.0'
        },
        body: JSON.stringify({ events })
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          console.warn(`[Moltwire] Rate limited. Retry after ${retryAfter}s`);
          return {
            accepted: 0,
            rejected: events.length,
            errors: [{ index: -1, reason: `Rate limited. Retry after ${retryAfter}s` }]
          };
        }

        if (response.status === 401) {
          console.error('[Moltwire] Invalid API key');
          return {
            accepted: 0,
            rejected: events.length,
            errors: [{ index: -1, reason: 'Invalid API key' }]
          };
        }

        console.error(`[Moltwire] API error: ${response.status} ${errorText}`);
        return {
          accepted: 0,
          rejected: events.length,
          errors: [{ index: -1, reason: `API error: ${response.status}` }]
        };
      }

      const result = await response.json() as EventBatchResponse;

      if (this.debug) {
        console.log(`[Moltwire] Sent: accepted=${result.accepted}, rejected=${result.rejected}`);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Moltwire] Failed to send events: ${message}`);

      return {
        accepted: 0,
        rejected: events.length,
        errors: [{ index: -1, reason: `Network error: ${message}` }]
      };
    }
  }

  /**
   * Verify the API key is valid
   */
  async verifyApiKey(): Promise<boolean> {
    const url = `${this.apiEndpoint}/v1/auth/verify`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'moltwire-plugin/0.1.0'
        }
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Update the API key
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Update the API endpoint
   */
  setEndpoint(endpoint: string): void {
    this.apiEndpoint = endpoint;
  }
}
