/**
 * Tools every composed agent gets besides its contract actions. Both are
 * owned and answered by the voice runtime itself (openaiSession's tool
 * handler), not by the tool library: the tenant clock for relative dates, and
 * the language note the core prompt asks for when the caller switches.
 * Ending and transferring a call stay with the runtime (silence ladder,
 * hangup, escalation paths) and are not model tools here.
 */
import type { ComposedTool } from './types';

export const RUNTIME_TOOL_NAMES = ['get_current_tenant_time', 'record_language_change'] as const;

export const RUNTIME_TOOLS: readonly ComposedTool[] = [
  {
    name: 'get_current_tenant_time',
    description: 'Return the current date, weekday, local time, IANA timezone, and UTC offset for the tenant. Use when relative dates matter or a long call may have crossed a boundary.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'record_language_change',
    description: 'Record a change in the caller\'s primary spoken language (English or Spanish). Call only when the language changes; do not announce this action.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['en', 'es'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['language', 'confidence'],
    },
  },
];
