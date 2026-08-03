import { ParsedAgentEvent } from '../adapters/base.js';

export interface BufferedEventPage {
  events: ParsedAgentEvent[];
  /** Cursor to pass back next poll to receive only events after this page. */
  nextCursor: number;
  /** Cursor of the oldest event still retained; anything below it has been evicted. */
  oldestCursor: number;
  /** Total events ever pushed, including evicted ones. Monotonic. */
  totalEvents: number;
  /** How many events were evicted before this page's start (gap indicator). */
  droppedCount: number;
}

export interface EventRingBufferOptions {
  maxEvents?: number;
  /**
   * Byte budget across retained event content. An event count alone does not bound memory —
   * a single `tool_result` can carry megabytes of command output.
   */
  maxBytes?: number;
}

/**
 * A bounded tail of a session's events, addressed by *monotonic cursors* rather than array
 * offsets.
 *
 * Offsets were unusable for polling: once the buffer filled, `events.length` pinned at its cap
 * forever, so a watcher comparing counts between polls saw a constant value and concluded
 * nothing was happening — precisely when the agent was at its most productive. Cursors keep
 * counting regardless of eviction, so change detection and "give me what's new" both work for
 * the whole life of a session.
 */
/**
 * Cheap size estimate for an arbitrary event payload. Returns 0 for absent values, and falls
 * back to a nominal cost if the value cannot be serialized (a circular structure would
 * otherwise throw from inside `push`, killing the stream over mere accounting).
 */
function approximateJsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 256;
  }
}

export class EventRingBuffer {
  private events: ParsedAgentEvent[] = [];
  /** Per-event retained size, parallel to `events`, so eviction is O(1) and drift-free. */
  private sizes: number[] = [];
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  /** Monotonic count of every event ever pushed; also the cursor of the next event. */
  private total = 0;
  /** Cursor of `events[0]`; equals `total - events.length`. */
  private oldest = 0;
  private bytes = 0;

  constructor(maxEventsOrOptions: number | EventRingBufferOptions = 512) {
    const options =
      typeof maxEventsOrOptions === 'number'
        ? { maxEvents: maxEventsOrOptions }
        : maxEventsOrOptions;
    this.maxEvents = options.maxEvents ?? 512;
    this.maxBytes = options.maxBytes ?? 5_000_000;
  }

  /**
   * Approximate retained size of one event.
   *
   * `content` is NOT the only thing that matters, which an earlier version assumed: Claude Code's
   * final `result` message carries a `metadata` object with per-model token counts, costs and
   * timings that routinely runs to several KB against a few hundred characters of content, and
   * `input`/`output` on tool events hold whole command payloads. Counting content alone let a
   * session's real footprint exceed `maxSessionOutputBytes` by an order of magnitude — the cap
   * held, but it was measuring the wrong thing.
   */
  private static sizeOf(event: ParsedAgentEvent): number {
    return (
      event.content.length +
      approximateJsonSize(event.metadata) +
      approximateJsonSize(event.input) +
      approximateJsonSize(event.output) +
      (event.toolName?.length ?? 0) +
      // Object header, type/timestamp fields, and per-event array slot.
      128
    );
  }

  push(event: ParsedAgentEvent): void {
    this.events.push(event);
    // Sized once here and remembered, so eviction never re-serializes a large payload and the
    // running total cannot drift from what was added.
    const size = EventRingBuffer.sizeOf(event);
    this.sizes.push(size);
    this.bytes += size;
    this.total += 1;

    while (
      this.events.length > 0 &&
      (this.events.length > this.maxEvents || this.bytes > this.maxBytes)
    ) {
      // Never evict the only event: a single oversized event still has to be readable.
      if (this.events.length === 1) break;
      this.events.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.oldest += 1;
    }
  }

  pushMany(events: ParsedAgentEvent[]): void {
    for (const event of events) {
      this.push(event);
    }
  }

  /**
   * Events at or after `cursor`. A cursor below the retained window silently starts at the
   * oldest retained event; `droppedCount` on the returned page reports the gap.
   */
  getSince(cursor = 0, limit?: number): BufferedEventPage {
    const from = Math.max(cursor, this.oldest);
    const startIndex = Math.max(from - this.oldest, 0);
    let slice = this.events.slice(startIndex);
    if (limit && limit > 0) slice = slice.slice(0, limit);

    return {
      events: slice,
      nextCursor: from + slice.length,
      oldestCursor: this.oldest,
      totalEvents: this.total,
      droppedCount: Math.max(this.oldest - cursor, 0),
    };
  }

  /** The most recent `count` events, for a tail view that does not track cursors. */
  getTail(count: number): BufferedEventPage {
    const from = Math.max(this.total - Math.max(count, 0), this.oldest);
    return this.getSince(from);
  }

  getAll(): ParsedAgentEvent[] {
    return [...this.events];
  }

  /** Retained event count. Use `totalEvents()` for change detection. */
  size(): number {
    return this.events.length;
  }

  /** Monotonic count of every event ever pushed. Never decreases, never plateaus. */
  totalEvents(): number {
    return this.total;
  }

  /** Events evicted so far. */
  droppedEvents(): number {
    return this.oldest;
  }

  retainedBytes(): number {
    return this.bytes;
  }
}
