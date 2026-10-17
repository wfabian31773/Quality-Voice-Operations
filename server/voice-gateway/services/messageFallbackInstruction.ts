export function buildMessageFallbackInstruction(toolName: string): string {
  const tool = toolName.trim() || 'create_ticket';
  return `No live transfer is available. Offer to take a message once and call ${tool} with the caller name, phone, and message. Do not keep asking to transfer or repeating that a human is unavailable.`;
}
