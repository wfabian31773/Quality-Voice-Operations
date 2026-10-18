/**
 * A composer agent's contract tools as the ReasoningEngine knows them
 * (Codex 4307582062). The engine's workflow steps, decisions and SafetyGate
 * speak the legacy library vocabulary (create_booking, update_booking,
 * create_ticket, its exempt reads), so a contract name like
 * scheduling_book_prepare never matches a step and enforce mode blocks it.
 *
 * Used ONLY for the reasoning authorize call and the engine's success/failure
 * notifications. Dispatch, tool_invocations rows and CallInvariants keep the
 * real contract name.
 *
 * Goes away with the ReasoningEngine (RT-15).
 */

type Args = Record<string, unknown>;

interface ContractActions {
  actions: Readonly<Record<string, string>>;
}

export interface EngineToolCall {
  toolName: string;
  args: Args;
}

function asRecord(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : {};
}

/** Drops undefined values, so a missing contract arg stays missing for the gate. */
function present(args: Args): Args {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

const asIs = (args: Args): Args => args;
// The arg keys the SafetyGate's required-data check reads for each library tool.
const bookArgs = (a: Args): Args => present({
  startTime: a.start,
  contactName: asRecord(a.customer).name,
  contactPhone: asRecord(a.customer).phone,
  notes: a.notes,
  confirmationToken: a.confirmationToken,
});
const rescheduleArgs = (a: Args): Args => present({
  action: 'reschedule', bookingId: a.bookingId, startTime: a.newStart, confirmationToken: a.confirmationToken,
});
const cancelArgs = (a: Args): Args => present({
  action: 'cancel', bookingId: a.bookingId, notes: a.reason, confirmationToken: a.confirmationToken,
});
const ticketArgs = (a: Args): Args => present({
  subject: a.subject,
  description: a.details,
  contactName: asRecord(a.customer).name,
  contactPhone: asRecord(a.customer).phone,
  confirmationToken: a.confirmationToken,
});
const findArgs = (a: Args): Args => present({ phoneNumber: a.phone, name: a.name });

/**
 * Contract action → the engine's tool name and arg shape. `step: false` on a
 * prepare: its success holds a slot but doesn't finish the engine's step (the
 * commit does), so it is reported under its own name and never advances it.
 */
const ENGINE_TOOLS: Readonly<Record<string, { tool: string; args: (a: Args) => Args; step: boolean }>> = {
  'scheduling.list_services': { tool: 'list_services', args: asIs, step: true },
  'scheduling.list_staff': { tool: 'list_staff', args: asIs, step: true },
  'scheduling.check_availability': { tool: 'check_availability', args: asIs, step: true },
  'scheduling.find_bookings': { tool: 'lookup_customer', args: findArgs, step: true },
  'scheduling.book.prepare': { tool: 'create_booking', args: bookArgs, step: false },
  'scheduling.book.commit': { tool: 'create_booking', args: bookArgs, step: true },
  'scheduling.reschedule.prepare': { tool: 'update_booking', args: rescheduleArgs, step: false },
  'scheduling.reschedule.commit': { tool: 'update_booking', args: rescheduleArgs, step: true },
  'scheduling.cancel.prepare': { tool: 'update_booking', args: cancelArgs, step: false },
  'scheduling.cancel.commit': { tool: 'update_booking', args: cancelArgs, step: true },
  'tickets.open.prepare': { tool: 'create_ticket', args: ticketArgs, step: false },
  'tickets.open.commit': { tool: 'create_ticket', args: ticketArgs, step: true },
};

function entryFor(toolName: string, binding: ContractActions | undefined) {
  const action = binding?.actions[toolName];
  return action ? ENGINE_TOOLS[action] : undefined;
}

/** The call the engine authorizes for a contract tool; the call itself for any other tool. */
export function engineToolCall(toolName: string, args: Args, binding: ContractActions | undefined): EngineToolCall {
  const entry = entryFor(toolName, binding);
  return entry ? { toolName: entry.tool, args: entry.args(args) } : { toolName, args };
}

/** The name a successful run is reported to the engine under (a prepare keeps its own). */
export function engineSuccessToolName(toolName: string, binding: ContractActions | undefined): string {
  const entry = entryFor(toolName, binding);
  return entry?.step ? entry.tool : toolName;
}

/** The agent's tool names plus the engine names of its contract tools (the engine's toolsAvailable). */
export function engineToolNames(toolNames: string[], binding: ContractActions | undefined): string[] {
  const engineNames = toolNames.map((name) => entryFor(name, binding)?.tool).filter((name): name is string => Boolean(name));
  return [...new Set([...toolNames, ...engineNames])];
}

/** The engine's vertical: a composer barbershop agent runs the salon pack ("Salon & Barbershop"). */
export function engineVertical(templateKey: string | undefined, binding: ContractActions | undefined): string {
  if (binding && templateKey === 'barbershop') return 'salon';
  return templateKey ?? 'general';
}
