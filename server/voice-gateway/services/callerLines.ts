/**
 * The caller's own transcribed lines for one call, for the hangup floor
 * (tickets.file_floor). Agent lines never go in here.
 *
 * Bounded to what the floor action accepts: at most FLOOR_MAX_LINES lines of
 * at most FLOOR_MAX_LINE_LENGTH characters. When a call runs past the cap the
 * oldest lines are dropped, so the ticket keeps the caller's latest words, in
 * order. Raw text stays in memory only; the floor action redacts it before
 * anything is stored or audited.
 */
import { FLOOR_MAX_LINE_LENGTH, FLOOR_MAX_LINES } from '../../../platform/actions/tickets/floor';

export class CallerLineBuffer {
  private readonly buffer: string[] = [];

  constructor(
    private readonly maxLines: number = FLOOR_MAX_LINES,
    private readonly maxLineLength: number = FLOOR_MAX_LINE_LENGTH,
  ) {}

  /** Adds one transcribed caller line. Blank lines are ignored. */
  push(text: string): void {
    // The floor action splits on line breaks after redaction, so one
    // transcript line must stay one line.
    const line = text.replace(/\s+/g, ' ').trim().slice(0, this.maxLineLength);
    if (!line) return;
    this.buffer.push(line);
    if (this.buffer.length > this.maxLines) this.buffer.splice(0, this.buffer.length - this.maxLines);
  }

  lines(): string[] {
    return this.buffer.slice();
  }

  get size(): number {
    return this.buffer.length;
  }
}
