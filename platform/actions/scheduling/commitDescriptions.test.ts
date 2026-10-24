// Pins what the commit tool descriptions tell the model counts as the caller's
// yes to a readback (the voice gateway's isExplicitYes is the runtime gate).
import { describe, expect, it } from 'vitest';
import { bookCommitAction } from './book';
import { cancelCommitAction } from './cancel';
import { rescheduleCommitAction } from './reschedule';

describe('commit descriptions: a clear go-ahead is a yes', () => {
  it.each([bookCommitAction, rescheduleCommitAction, cancelCommitAction])('$name', (action) => {
    expect(action.agentDescription).toContain(
      'A clear go-ahead such as "book it", "go ahead", "do it", "sounds good", "dale" or "adelante" is a yes; '
      + 'a question, a hedge ("wait", "maybe") or a change ("but at 2") is not. ',
    );
    expect(action.agentDescription).toMatch(/after the caller explicitly said yes to the readback/);
  });
});
