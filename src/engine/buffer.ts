import { ParsedAgentEvent } from '../adapters/base.js';

export class EventRingBuffer {
  private events: ParsedAgentEvent[] = [];

  constructor(private maxEvents: number = 512) {}

  push(event: ParsedAgentEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.events.shift(); // discard oldest
    }
    this.events.push(event);
  }

  pushMany(events: ParsedAgentEvent[]): void {
    for (const event of events) {
      this.push(event);
    }
  }

  getEvents(offset: number = 0, limit?: number): ParsedAgentEvent[] {
    const slice = this.events.slice(offset);
    if (limit && limit > 0) {
      return slice.slice(0, limit);
    }
    return slice;
  }

  getAll(): ParsedAgentEvent[] {
    return [...this.events];
  }

  size(): number {
    return this.events.length;
  }
}
