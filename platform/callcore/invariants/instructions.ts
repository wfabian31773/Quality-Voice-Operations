import type { RuleId } from './types';

/**
 * Fixed corrective lines, one per rule. Model-only: the runtime hands them to
 * the model, never to the caller. They never carry caller data and never pick
 * the next question.
 */
export const INSTRUCTIONS: Readonly<Record<RuleId, string>> = {
  'run.action_not_allowed': 'That action is not available on this call. Do not call it again; use the tools you have.',
  'run.commit_without_token': 'Run the prepare step first and read the details back before committing.',
  'run.commit_token_not_prepared':
    'That confirmation token was not prepared on this call. Run the prepare step again and read the details back.',
  'run.commit_without_yes':
    'Read the details back and wait for the caller to say yes to them before committing.',
  'run.success_run_ceiling': 'You already have this answer. Reuse the last answer instead of calling the tool again.',
  'say.stage_direction': 'Say only the words the caller should hear. No stage directions or narration.',
  'say.ref_not_voiced':
    'Do not read out reference or confirmation numbers on this call. Confirm the date, time and details instead.',
  'say.ref_not_committed': 'Only read out a reference number exactly as a tool returned it.',
  'say.success_before_commit':
    'Nothing has been confirmed yet. Do not say it is done until the tool result says it succeeded.',
  'say.transfer_without_result': 'No transfer has happened. Do not say you are transferring or connecting the caller.',
  'say.text_promise_sms_off':
    'Texting is not on yet. Only say a text will follow once texting is enabled; do not promise a text now.',
  'transfer.no_number': 'There is no transfer number for this business. Do not offer a transfer; offer to take a message.',
  'end.unvoiced_tool_result': 'Tell the caller the result of the last tool before ending the call.',
  'end.floor_not_evaluated': 'Do not end the call yet. The request check must run before the call ends.',
};
