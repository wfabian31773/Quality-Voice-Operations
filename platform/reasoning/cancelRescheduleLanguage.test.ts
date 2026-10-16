import { describe, expect, it } from 'vitest';
import { hasCancelOrRescheduleLanguage, inferCancelOrRescheduleAction } from './cancelRescheduleLanguage';

describe('cancel/reschedule language', () => {
  it('detects English cancel and reschedule phrases', () => {
    expect(hasCancelOrRescheduleLanguage('Cancel my haircut appointment')).toBe(true);
    expect(hasCancelOrRescheduleLanguage('I need to reschedule my appointment')).toBe(true);
    expect(hasCancelOrRescheduleLanguage('I want to book a haircut tomorrow')).toBe(false);
  });

  it('detects Spanish cancel and move/change phrases', () => {
    expect(hasCancelOrRescheduleLanguage('Quiero cancelar mi cita')).toBe(true);
    expect(hasCancelOrRescheduleLanguage('Puedo cambiar la cita')).toBe(true);
    expect(hasCancelOrRescheduleLanguage('Necesito mover la cita')).toBe(true);
  });

  it('infers cancel vs reschedule', () => {
    expect(inferCancelOrRescheduleAction('Cancel my haircut appointment')).toBe('cancel');
    expect(inferCancelOrRescheduleAction('Quiero cancelar mi cita')).toBe('cancel');
    expect(inferCancelOrRescheduleAction('Puedo cambiar la cita')).toBe('reschedule');
    expect(inferCancelOrRescheduleAction('Necesito mover la cita')).toBe('reschedule');
  });
});
