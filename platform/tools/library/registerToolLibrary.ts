import { globalToolRegistry } from '../registry';
import { unifiedToolRegistry, type EnhancedToolDefinition } from '../ToolRegistry';
import { lookupCustomerTool } from '../lookupCustomer';
import { recordCallOutcomeTool } from '../recordCallOutcome';
import { TOOL_LIBRARY } from './catalog';
import { sendSmsTool } from './handlers/sendSms';
import { sendEmailTool } from './handlers/sendEmail';
import { createTicketTool } from './handlers/createTicket';
import { createBookingTool } from './handlers/createBooking';
import { createDispatchJobTool } from './handlers/createDispatchJob';

const EXECUTABLE_LIBRARY_TOOLS = [
  sendSmsTool,
  sendEmailTool,
  createTicketTool,
  createBookingTool,
  createDispatchJobTool,
  lookupCustomerTool,
  recordCallOutcomeTool,
];

export function registerToolLibrary(): void {
  for (const tool of EXECUTABLE_LIBRARY_TOOLS) {
    globalToolRegistry.register(tool);
  }

  for (const entry of TOOL_LIBRARY) {
    const executable = EXECUTABLE_LIBRARY_TOOLS.find((tool) => tool.name === entry.name);
    const definition: EnhancedToolDefinition = {
      name: entry.name,
      description: entry.description,
      category: entry.category,
      inputSchema: entry.parameters,
      recoveryInstructions: 'If this tool fails, tell the caller plainly and offer to retry or escalate to a human.',
      handler: executable?.handler ?? (async () => ({
        success: false,
        message: 'This library tool is handled by the voice runtime context.',
      })),
    };
    unifiedToolRegistry.registerEnhanced(definition);
  }
}

export function listRegisteredLibraryTools(): string[] {
  return EXECUTABLE_LIBRARY_TOOLS.map((tool) => tool.name);
}
