import type { AgentToolDef } from './types';

export interface TemplateToolPermissions {
  allowedTools: string[];
  deniedTools: string[];
}

const TEMPLATE_PERMISSIONS: Record<string, TemplateToolPermissions> = {
  'answering-service': {
    allowedTools: ['createServiceTicket'],
    deniedTools: ['triageEscalate', 'scheduleDentalAppointment', 'scheduleConsultation', 'submitMaintenanceRequest', 'bookServiceAppointment'],
  },
  'medical-after-hours': {
    allowedTools: ['createAfterHoursTicket', 'triageEscalate'],
    deniedTools: ['createServiceTicket', 'scheduleDentalAppointment', 'scheduleConsultation', 'submitMaintenanceRequest', 'bookServiceAppointment'],
  },
  'dental': {
    allowedTools: ['scheduleDentalAppointment'],
    deniedTools: ['createServiceTicket', 'createAfterHoursTicket', 'triageEscalate', 'scheduleConsultation', 'submitMaintenanceRequest', 'bookServiceAppointment'],
  },
  'property-management': {
    allowedTools: ['submitMaintenanceRequest'],
    deniedTools: ['createServiceTicket', 'createAfterHoursTicket', 'triageEscalate', 'scheduleDentalAppointment', 'scheduleConsultation', 'bookServiceAppointment'],
  },
  'home-services': {
    allowedTools: ['bookServiceAppointment'],
    deniedTools: ['createServiceTicket', 'createAfterHoursTicket', 'triageEscalate', 'scheduleDentalAppointment', 'scheduleConsultation', 'submitMaintenanceRequest'],
  },
  'legal': {
    allowedTools: ['scheduleConsultation'],
    deniedTools: ['createServiceTicket', 'createAfterHoursTicket', 'triageEscalate', 'scheduleDentalAppointment', 'submitMaintenanceRequest', 'bookServiceAppointment'],
  },
};

export function getTemplatePermissions(templateKey: string): TemplateToolPermissions {
  return TEMPLATE_PERMISSIONS[templateKey] ?? { allowedTools: [], deniedTools: [] };
}

export interface ToolOverride {
  toolName: string;
  enabled: boolean;
}

export function filterToolsByPermissions(
  tools: AgentToolDef[],
  templateKey: string,
  overrides?: ToolOverride[],
): AgentToolDef[] {
  const permissions = getTemplatePermissions(templateKey);
  const overrideMap = new Map<string, boolean>();

  if (overrides) {
    for (const o of overrides) {
      overrideMap.set(o.toolName, o.enabled);
    }
  }

  return tools.filter((t) => {
    const overrideEnabled = overrideMap.get(t.name);
    if (overrideEnabled !== undefined) {
      return overrideEnabled;
    }

    if (permissions.deniedTools.includes(t.name)) {
      return false;
    }

    if (permissions.allowedTools.length > 0) {
      return permissions.allowedTools.includes(t.name);
    }

    return true;
  });
}

export function isToolDenied(
  toolName: string,
  templateKey: string,
  overrides?: ToolOverride[],
): boolean {
  const permissions = getTemplatePermissions(templateKey);

  if (overrides) {
    const override = overrides.find((o) => o.toolName === toolName);
    if (override !== undefined) {
      return !override.enabled;
    }
  }

  if (permissions.deniedTools.includes(toolName)) {
    return true;
  }

  if (permissions.allowedTools.length > 0 && !permissions.allowedTools.includes(toolName)) {
    return true;
  }

  return false;
}

export function getAvailableToolsForTemplate(templateKey: string): string[] {
  const permissions = TEMPLATE_PERMISSIONS[templateKey];
  if (!permissions) return [];
  return [...permissions.allowedTools];
}

export function getAllKnownTools(): string[] {
  const allTools = new Set<string>();
  for (const perms of Object.values(TEMPLATE_PERMISSIONS)) {
    for (const t of perms.allowedTools) allTools.add(t);
    for (const t of perms.deniedTools) allTools.add(t);
  }
  return [...allTools];
}
