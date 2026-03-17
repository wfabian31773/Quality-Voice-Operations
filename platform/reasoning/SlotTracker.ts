import { createLogger } from '../core/logger';
import type {
  SlotManifest,
  SlotManifestEntry,
  SlotState,
  SlotTrackerState,
  ConfidenceLevel,
} from './types';

const logger = createLogger('SLOT_TRACKER');

export class SlotTracker {
  private state: SlotTrackerState;

  constructor(manifest: SlotManifest) {
    const slots = new Map<string, SlotState>();
    for (const entry of manifest.slots) {
      slots.set(entry.name, {
        name: entry.name,
        value: null,
        required: entry.required,
        filledAtTurn: null,
        attempts: 0,
      });
    }
    this.state = { manifest, slots, currentTurn: 0 };
  }

  advanceTurn(): void {
    this.state.currentTurn++;
  }

  fillSlot(name: string, value: string): boolean {
    const slot = this.state.slots.get(name);
    if (!slot) {
      logger.warn('Attempted to fill unknown slot', { slot: name });
      return false;
    }

    const entry = this.getManifestEntry(name);
    if (entry?.validation && !entry.validation(value)) {
      slot.attempts++;
      logger.debug('Slot validation failed', { slot: name, attempts: slot.attempts });
      return false;
    }

    slot.value = value;
    slot.filledAtTurn = this.state.currentTurn;
    slot.attempts++;
    logger.debug('Slot filled', { slot: name, turn: this.state.currentTurn });
    return true;
  }

  clearSlot(name: string): void {
    const slot = this.state.slots.get(name);
    if (slot) {
      slot.value = null;
      slot.filledAtTurn = null;
    }
  }

  getSlotValue(name: string): string | null {
    return this.state.slots.get(name)?.value ?? null;
  }

  isSlotFilled(name: string): boolean {
    return this.state.slots.get(name)?.value !== null && this.state.slots.get(name)?.value !== undefined;
  }

  getFilledSlots(): Record<string, string> {
    const filled: Record<string, string> = {};
    for (const [name, slot] of this.state.slots) {
      if (slot.value !== null) {
        filled[name] = slot.value;
      }
    }
    return filled;
  }

  getMissingRequired(): string[] {
    const missing: string[] = [];
    for (const [name, slot] of this.state.slots) {
      if (slot.required && slot.value === null) {
        missing.push(name);
      }
    }
    return missing;
  }

  getMissingOptional(): string[] {
    const missing: string[] = [];
    for (const [name, slot] of this.state.slots) {
      if (!slot.required && slot.value === null) {
        missing.push(name);
      }
    }
    return missing;
  }

  getNextSlotToCollect(): SlotManifestEntry | null {
    for (const entry of this.state.manifest.slots) {
      const slot = this.state.slots.get(entry.name);
      if (slot && slot.required && slot.value === null) {
        return entry;
      }
    }
    return null;
  }

  getCompleteness(): number {
    const required = this.state.manifest.slots.filter((s) => s.required);
    if (required.length === 0) return 1.0;
    const filled = required.filter((s) => {
      const slot = this.state.slots.get(s.name);
      return slot && slot.value !== null;
    });
    return filled.length / required.length;
  }

  getCompletenessLevel(): ConfidenceLevel {
    const completeness = this.getCompleteness();
    if (completeness >= 0.9) return 'high';
    if (completeness >= 0.5) return 'medium';
    return 'low';
  }

  isComplete(): boolean {
    return this.getMissingRequired().length === 0;
  }

  getSlotAttempts(name: string): number {
    return this.state.slots.get(name)?.attempts ?? 0;
  }

  hasExcessiveAttempts(name: string, threshold = 3): boolean {
    return this.getSlotAttempts(name) >= threshold;
  }

  getState(): SlotTrackerState {
    return {
      ...this.state,
      slots: new Map(this.state.slots),
    };
  }

  toSerializable(redactSensitive = true): Record<string, unknown> {
    const slots: Record<string, unknown> = {};
    for (const [name, slot] of this.state.slots) {
      const entry = this.getManifestEntry(name);
      const isSensitive = entry?.sensitive === true;
      slots[name] = {
        value: redactSensitive && isSensitive && slot.value
          ? `***${slot.value.slice(-4)}`
          : slot.value,
        filled: slot.value !== null,
        required: slot.required,
        filledAtTurn: slot.filledAtTurn,
        attempts: slot.attempts,
      };
    }
    return {
      vertical: this.state.manifest.vertical,
      intent: this.state.manifest.intent,
      currentTurn: this.state.currentTurn,
      slots,
      completeness: this.getCompleteness(),
      missingRequired: this.getMissingRequired(),
    };
  }

  private getManifestEntry(name: string): SlotManifestEntry | undefined {
    return this.state.manifest.slots.find((s) => s.name === name);
  }
}
