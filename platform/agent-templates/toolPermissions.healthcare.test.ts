import { describe, expect, it } from 'vitest';
import {
  filterToolsByPermissions,
  getAllKnownTools,
  getAvailableToolsForTemplate,
  getTemplatePermissions,
  isToolDenied,
} from './toolPermissions';

describe('healthcare receptionist tool permissions', () => {
  it('allows deployment overrides to disable tools but never expand the role allowlist', () => {
    const tools = [
      { name: 'createServiceTicket', description: 'allowed', parameters: {} },
      { name: 'triageEscalate', description: 'denied', parameters: {} },
      { name: 'deletePatientRecord', description: 'unknown', parameters: {} },
    ];
    const overrides = [
      { toolName: 'createServiceTicket', enabled: false },
      { toolName: 'triageEscalate', enabled: true },
      { toolName: 'deletePatientRecord', enabled: true },
    ];

    expect(filterToolsByPermissions(tools, 'healthcare-receptionist', overrides)).toEqual([]);
    expect(isToolDenied('createServiceTicket', 'healthcare-receptionist', overrides)).toBe(true);
    expect(isToolDenied('triageEscalate', 'healthcare-receptionist', overrides)).toBe(true);
    expect(isToolDenied('deletePatientRecord', 'healthcare-receptionist', overrides)).toBe(true);
  });

  it('keeps the allowlist discoverable and permits only allowed tools by default', () => {
    expect(getTemplatePermissions('healthcare-receptionist').allowedTools).toEqual([
      'createServiceTicket', 'lookupSchedule', 'escalate_to_human',
    ]);
    expect(getAvailableToolsForTemplate('healthcare-receptionist')).toContain('createServiceTicket');
    expect(getAvailableToolsForTemplate('unknown')).toEqual([]);
    expect(getAllKnownTools()).toEqual(expect.arrayContaining(['createServiceTicket', 'triageEscalate']));
    expect(isToolDenied('createServiceTicket', 'healthcare-receptionist', [
      { toolName: 'createServiceTicket', enabled: true },
    ])).toBe(false);
    expect(filterToolsByPermissions([
      { name: 'createServiceTicket', description: 'allowed', parameters: {} },
    ], 'healthcare-receptionist')).toHaveLength(1);
    expect(filterToolsByPermissions([
      { name: 'custom', description: 'unrestricted', parameters: {} },
    ], 'unknown')).toHaveLength(1);
  });
});
