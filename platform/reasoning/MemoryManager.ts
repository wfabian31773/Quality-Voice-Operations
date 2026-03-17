import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import type { CallerMemory } from '../infra/memory/types';
import type { CallerContext } from './types';

const logger = createLogger('MEMORY_MANAGER');

export interface MemoryStorage {
  getCallerMemory(
    tenantId: TenantId,
    phoneNumber: string,
  ): Promise<CallerMemory | null>;
}

export class MemoryManager {
  private readonly storage: MemoryStorage | null;

  constructor(storage: MemoryStorage | null) {
    this.storage = storage;
  }

  async buildCallerContext(
    tenantId: TenantId,
    callerNumber: string,
  ): Promise<CallerContext> {
    if (!this.storage || !callerNumber) {
      return this.emptyContext();
    }

    try {
      const memory = await this.storage.getCallerMemory(tenantId, callerNumber);

      if (!memory || memory.totalCalls === 0) {
        logger.debug('New caller, no prior history', {
          tenantId,
          phone: `***${callerNumber.slice(-4)}`,
        });
        return this.emptyContext();
      }

      const context: CallerContext = {
        memory,
        isReturningCaller: true,
        hasOpenTickets: memory.openTickets.length > 0,
        openTicketIds: memory.openTickets,
        preferredContactMethod: memory.preferredContactMethod,
      };

      if (memory.recentCalls.length > 0) {
        const lastCall = memory.recentCalls[0];
        context.lastCallSummary = `Last call on ${lastCall.date}: ${lastCall.reason} — ${lastCall.outcome}`;
      }

      logger.info('Returning caller context built', {
        tenantId,
        phone: `***${callerNumber.slice(-4)}`,
        totalCalls: memory.totalCalls,
        openTickets: memory.openTickets.length,
      });

      return context;
    } catch (err) {
      logger.error('Failed to build caller context', {
        tenantId,
        error: String(err),
      });
      return this.emptyContext();
    }
  }

  buildCallerContextPrompt(context: CallerContext): string {
    if (!context.isReturningCaller || !context.memory) {
      return '';
    }

    const lines: string[] = ['===== CALLER HISTORY ====='];

    lines.push(`Returning caller (${context.memory.totalCalls} previous calls).`);

    if (context.memory.patientName) {
      lines.push(`Name on file: ${context.memory.patientName}`);
    }

    if (context.lastCallSummary) {
      lines.push(context.lastCallSummary);
    }

    if (context.hasOpenTickets) {
      lines.push(`Open tickets: ${context.openTicketIds.join(', ')}`);
      lines.push('IMPORTANT: Ask if they are calling about an existing ticket before creating a new one.');
    }

    if (context.preferredContactMethod) {
      lines.push(`Preferred contact method: ${context.preferredContactMethod}`);
    }

    if (context.memory.lastProviderSeen) {
      lines.push(`Last provider seen: ${context.memory.lastProviderSeen}`);
    }

    const recentAppointments = this.extractRecentAppointments(context.memory);
    if (recentAppointments.length > 0) {
      lines.push('Recent appointments:');
      for (const appt of recentAppointments) {
        lines.push(`  - ${appt}`);
      }
      lines.push('IMPORTANT: Reference recent appointments if the caller asks about follow-ups or rescheduling.');
    }

    if (context.memory.notes) {
      lines.push(`Notes: ${context.memory.notes}`);
    }

    return lines.join('\n');
  }

  private extractRecentAppointments(memory: CallerMemory): string[] {
    const appointmentKeywords = ['appointment', 'schedule', 'booking', 'visit', 'consultation', 'viewing', 'reservation'];
    return memory.recentCalls
      .filter((call) => {
        const reason = call.reason.toLowerCase();
        return appointmentKeywords.some((kw) => reason.includes(kw));
      })
      .slice(0, 3)
      .map((call) => `${call.date}: ${call.reason} — ${call.outcome}${call.ticketNumber ? ` (Ticket: ${call.ticketNumber})` : ''}`);
  }

  private emptyContext(): CallerContext {
    return {
      memory: null,
      isReturningCaller: false,
      hasOpenTickets: false,
      openTicketIds: [],
    };
  }
}
