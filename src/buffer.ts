import type { MoltwireEvent } from './types.js';

const MAX_BUFFER_SIZE = 10000;

/**
 * Simple in-memory event buffer with FIFO eviction
 */
export class EventBuffer {
  private buffer: MoltwireEvent[] = [];
  private maxSize: number;
  private flushBatchSize: number;

  constructor(maxMemorySize = 100, flushBatchSize = 50) {
    this.maxSize = Math.min(maxMemorySize, MAX_BUFFER_SIZE);
    this.flushBatchSize = flushBatchSize;
  }

  /**
   * Add an event to the buffer
   */
  push(event: MoltwireEvent): void {
    this.buffer.push(event);

    // Enforce max size with FIFO eviction
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /**
   * Get events ready to flush (up to batchSize)
   * Returns events and a callback to confirm they were sent
   */
  flush(): { events: MoltwireEvent[]; confirm: () => void } {
    const events = this.buffer.splice(0, this.flushBatchSize);

    return {
      events,
      confirm: () => {
        // Events already removed from buffer
      }
    };
  }

  /**
   * Get the total number of buffered events
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Check if buffer has events
   */
  hasEvents(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Close the buffer (no-op for in-memory)
   */
  close(): void {
    // Nothing to close
  }
}
