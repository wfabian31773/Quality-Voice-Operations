import { describe, it, expect } from 'vitest';
import { SlotTracker } from './SlotTracker';
import type { SlotManifest } from './types';

function manifest(slots: SlotManifest['slots']): SlotManifest {
  return { vertical: 'hvac', intent: 'service_request', slots };
}

const TWO_REQUIRED = manifest([
  { name: 'caller_name', label: 'Name', required: true, prompt: 'Name?' },
  { name: 'callback_number', label: 'Number', required: true, prompt: 'Number?' },
  { name: 'preferred_time', label: 'Time', required: false, prompt: 'Time?' },
]);

describe('SlotTracker.fillSlot', () => {
  it('fills a known slot and records the value, turn, and an attempt', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    t.advanceTurn(); // currentTurn = 1
    expect(t.fillSlot('caller_name', 'Ada')).toBe(true);
    expect(t.getSlotValue('caller_name')).toBe('Ada');
    expect(t.isSlotFilled('caller_name')).toBe(true);
    expect(t.getSlotAttempts('caller_name')).toBe(1);
  });

  it('rejects an unknown slot without throwing', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    expect(t.fillSlot('nonexistent', 'x')).toBe(false);
    expect(t.getSlotValue('nonexistent')).toBeNull();
  });

  it('rejects a value that fails the slot validation and counts the attempt', () => {
    const t = new SlotTracker(
      manifest([
        {
          name: 'callback_number',
          label: 'Number',
          required: true,
          prompt: 'Number?',
          validation: (v) => /^\d{10}$/.test(v),
        },
      ]),
    );
    expect(t.fillSlot('callback_number', 'not-a-number')).toBe(false);
    expect(t.getSlotValue('callback_number')).toBeNull();
    expect(t.getSlotAttempts('callback_number')).toBe(1);
    expect(t.fillSlot('callback_number', '5551234567')).toBe(true);
    expect(t.getSlotAttempts('callback_number')).toBe(2);
  });

  it('clears a previously filled slot', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    t.fillSlot('caller_name', 'Ada');
    t.clearSlot('caller_name');
    expect(t.getSlotValue('caller_name')).toBeNull();
    expect(t.isSlotFilled('caller_name')).toBe(false);
  });
});

describe('SlotTracker completeness', () => {
  it('reports missing required and optional slots separately', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    expect(t.getMissingRequired()).toEqual(['caller_name', 'callback_number']);
    expect(t.getMissingOptional()).toEqual(['preferred_time']);
    t.fillSlot('caller_name', 'Ada');
    expect(t.getMissingRequired()).toEqual(['callback_number']);
  });

  it('returns the next unfilled required slot in manifest order', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    expect(t.getNextSlotToCollect()?.name).toBe('caller_name');
    t.fillSlot('caller_name', 'Ada');
    expect(t.getNextSlotToCollect()?.name).toBe('callback_number');
    t.fillSlot('callback_number', '5551234567');
    expect(t.getNextSlotToCollect()).toBeNull();
  });

  it('computes completeness as the fraction of required slots filled', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    expect(t.getCompleteness()).toBe(0);
    t.fillSlot('caller_name', 'Ada');
    expect(t.getCompleteness()).toBe(0.5);
    t.fillSlot('callback_number', '5551234567');
    expect(t.getCompleteness()).toBe(1);
    expect(t.isComplete()).toBe(true);
  });

  it('treats a manifest with no required slots as fully complete', () => {
    const t = new SlotTracker(manifest([{ name: 'note', label: 'Note', required: false, prompt: '?' }]));
    expect(t.getCompleteness()).toBe(1);
    expect(t.isComplete()).toBe(true);
  });

  it('maps completeness onto confidence levels at the 0.9 / 0.5 boundaries', () => {
    const three = manifest([
      { name: 'a', label: 'A', required: true, prompt: '?' },
      { name: 'b', label: 'B', required: true, prompt: '?' },
      { name: 'c', label: 'C', required: true, prompt: '?' },
    ]);
    const t = new SlotTracker(three);
    expect(t.getCompletenessLevel()).toBe('low'); // 0/3
    t.fillSlot('a', '1');
    t.fillSlot('b', '2'); // 2/3 = 0.66 -> medium
    expect(t.getCompletenessLevel()).toBe('medium');
    t.fillSlot('c', '3'); // 3/3 = 1 -> high
    expect(t.getCompletenessLevel()).toBe('high');
  });

  it('flags excessive attempts once the threshold is reached', () => {
    const t = new SlotTracker(
      manifest([{ name: 'pin', label: 'PIN', required: true, prompt: '?', validation: () => false }]),
    );
    t.fillSlot('pin', 'a');
    t.fillSlot('pin', 'b');
    expect(t.hasExcessiveAttempts('pin')).toBe(false); // 2 < 3
    t.fillSlot('pin', 'c');
    expect(t.hasExcessiveAttempts('pin')).toBe(true); // 3 >= 3
    expect(t.hasExcessiveAttempts('pin', 5)).toBe(false);
  });
});

describe('SlotTracker.toSerializable', () => {
  it('redacts sensitive slot values to the last four characters by default', () => {
    const t = new SlotTracker(
      manifest([{ name: 'patient_dob', label: 'DOB', required: true, prompt: '?', sensitive: true }]),
    );
    t.fillSlot('patient_dob', '1990-06-15');
    const out = t.toSerializable() as { slots: Record<string, { value: string }> };
    expect(out.slots.patient_dob.value).toBe('***6-15'); // last 4 chars of 1990-06-15
  });

  it('does not redact when redactSensitive is false', () => {
    const t = new SlotTracker(
      manifest([{ name: 'patient_dob', label: 'DOB', required: true, prompt: '?', sensitive: true }]),
    );
    t.fillSlot('patient_dob', '1990-06-15');
    const out = t.toSerializable(false) as { slots: Record<string, { value: string }> };
    expect(out.slots.patient_dob.value).toBe('1990-06-15');
  });

  it('includes manifest metadata and a live completeness snapshot', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    t.fillSlot('caller_name', 'Ada');
    const out = t.toSerializable() as Record<string, unknown>;
    expect(out.vertical).toBe('hvac');
    expect(out.intent).toBe('service_request');
    expect(out.completeness).toBe(0.5);
    expect(out.missingRequired).toEqual(['callback_number']);
  });
});

describe('SlotTracker.getState', () => {
  it('returns a copy whose slot map is decoupled from internal state', () => {
    const t = new SlotTracker(TWO_REQUIRED);
    const snapshot = t.getState();
    snapshot.slots.delete('caller_name');
    // Mutating the snapshot must not affect the tracker.
    expect(t.getNextSlotToCollect()?.name).toBe('caller_name');
  });
});
