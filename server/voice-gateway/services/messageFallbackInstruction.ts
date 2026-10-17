export function buildMessageFallbackInstruction(toolName: string): string {
  const tool = toolName.trim() || 'create_ticket';
  return `No live transfer is available. Offer once to take a message for the team, then wait for the caller's answer. Only if the caller says yes, call ${tool} with the caller name, phone, and message. If they say no, do not create one. Do not promise when anyone will call back, and do not keep asking to transfer or repeating that a human is unavailable.`;
}
