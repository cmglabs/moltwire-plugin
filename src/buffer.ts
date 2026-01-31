import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { MoltwireEvent } from './types.js';

const MAX_BUFFER_SIZE = 10000;
const MOLTWIRE_DIR = join(homedir(), '.openclaw', 'moltwire');
const DB_PATH = join(MOLTWIRE_DIR, 'buffer.db');

/**
 * Event buffer with in-memory primary storage and SQLite overflow
 */
export class EventBuffer {
  private inMemoryBuffer: MoltwireEvent[] = [];
  private db: Database.Database | null = null;
  private maxMemorySize: number;
  private flushBatchSize: number;

  constructor(maxMemorySize = 100, flushBatchSize = 50) {
    this.maxMemorySize = maxMemorySize;
    this.flushBatchSize = flushBatchSize;
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    try {
      // Ensure directory exists
      if (!existsSync(MOLTWIRE_DIR)) {
        mkdirSync(MOLTWIRE_DIR, { recursive: true });
      }

      this.db = new Database(DB_PATH);

      // Create tables if they don't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_data TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      `);

      // Clean up old events beyond max buffer size
      this.enforceBufferLimit();
    } catch (error) {
      console.error('[Moltwire] Failed to initialize SQLite buffer:', error);
      this.db = null;
    }
  }

  /**
   * Add an event to the buffer
   */
  push(event: MoltwireEvent): void {
    // Add to in-memory buffer first
    this.inMemoryBuffer.push(event);

    // If in-memory buffer is full, spill to SQLite
    if (this.inMemoryBuffer.length > this.maxMemorySize) {
      this.spillToSqlite();
    }
  }

  /**
   * Move excess events from memory to SQLite
   */
  private spillToSqlite(): void {
    if (!this.db) return;

    const eventsToSpill = this.inMemoryBuffer.splice(0, this.inMemoryBuffer.length - this.maxMemorySize / 2);

    const insert = this.db.prepare('INSERT INTO events (event_data) VALUES (?)');
    const insertMany = this.db.transaction((events: MoltwireEvent[]) => {
      for (const event of events) {
        insert.run(JSON.stringify(event));
      }
    });

    try {
      insertMany(eventsToSpill);
      this.enforceBufferLimit();
    } catch (error) {
      console.error('[Moltwire] Failed to spill events to SQLite:', error);
      // Put events back if spill failed
      this.inMemoryBuffer.unshift(...eventsToSpill);
    }
  }

  /**
   * Enforce the maximum buffer size (FIFO eviction)
   */
  private enforceBufferLimit(): void {
    if (!this.db) return;

    try {
      const countResult = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
      const totalCount = countResult.count + this.inMemoryBuffer.length;

      if (totalCount > MAX_BUFFER_SIZE) {
        const toDelete = totalCount - MAX_BUFFER_SIZE;
        this.db.prepare(`
          DELETE FROM events
          WHERE id IN (
            SELECT id FROM events ORDER BY created_at ASC LIMIT ?
          )
        `).run(toDelete);
      }
    } catch (error) {
      console.error('[Moltwire] Failed to enforce buffer limit:', error);
    }
  }

  /**
   * Get events ready to flush (up to batchSize)
   * Returns events and a callback to confirm they were sent
   */
  flush(): { events: MoltwireEvent[]; confirm: () => void } {
    const events: MoltwireEvent[] = [];

    // First, try to get events from SQLite (oldest first)
    if (this.db) {
      try {
        const sqliteEvents = this.db.prepare(`
          SELECT id, event_data FROM events
          ORDER BY created_at ASC
          LIMIT ?
        `).all(this.flushBatchSize) as Array<{ id: number; event_data: string }>;

        for (const row of sqliteEvents) {
          try {
            events.push(JSON.parse(row.event_data));
          } catch {
            // Skip malformed events
          }
        }

        // If we have SQLite events, return those
        if (events.length > 0) {
          const ids = sqliteEvents.map(r => r.id);
          return {
            events,
            confirm: () => {
              if (this.db) {
                this.db.prepare(`DELETE FROM events WHERE id IN (${ids.join(',')})`).run();
              }
            }
          };
        }
      } catch (error) {
        console.error('[Moltwire] Failed to read from SQLite buffer:', error);
      }
    }

    // If no SQLite events, get from in-memory buffer
    const memoryEvents = this.inMemoryBuffer.splice(0, this.flushBatchSize);

    return {
      events: memoryEvents,
      confirm: () => {
        // Already removed from in-memory buffer
      }
    };
  }

  /**
   * Get the total number of buffered events
   */
  size(): number {
    let total = this.inMemoryBuffer.length;

    if (this.db) {
      try {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
        total += result.count;
      } catch {
        // Ignore errors
      }
    }

    return total;
  }

  /**
   * Check if buffer has events
   */
  hasEvents(): boolean {
    if (this.inMemoryBuffer.length > 0) return true;

    if (this.db) {
      try {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
        return result.count > 0;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
