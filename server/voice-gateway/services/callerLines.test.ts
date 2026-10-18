import { describe, expect, it } from 'vitest';
import { FLOOR_MAX_LINE_LENGTH, FLOOR_MAX_LINES } from '../../../platform/actions/tickets/floor';
import { CallerLineBuffer } from './callerLines';

describe('CallerLineBuffer', () => {
  it('keeps non-blank caller lines in order, one transcript line per line', () => {
    const buffer = new CallerLineBuffer();
    buffer.push('  Hi, this is Dana ');
    buffer.push('   ');
    buffer.push('I need a fade\nFriday at nine');
    expect(buffer.lines()).toEqual(['Hi, this is Dana', 'I need a fade Friday at nine']);
    expect(buffer.size).toBe(2);
  });

  it('is bounded to what tickets.file_floor accepts, keeping the latest lines', () => {
    const buffer = new CallerLineBuffer();
    for (let i = 1; i <= FLOOR_MAX_LINES + 5; i += 1) buffer.push(`line ${i}`);
    buffer.push('x'.repeat(FLOOR_MAX_LINE_LENGTH + 50));
    const lines = buffer.lines();
    expect(lines).toHaveLength(FLOOR_MAX_LINES);
    expect(lines[0]).toBe('line 7');
    expect(lines.at(-1)).toHaveLength(FLOOR_MAX_LINE_LENGTH);
  });

  it('returns a copy', () => {
    const buffer = new CallerLineBuffer(2, 10);
    buffer.push('a');
    buffer.lines().push('b');
    expect(buffer.lines()).toEqual(['a']);
  });
});
