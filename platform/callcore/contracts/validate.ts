import type { ZodTypeAny } from 'zod';
import { contractKey, TERMINAL_STEPS, type ToolContract } from './types';

/**
 * What the validator needs from an action. Structural, so this folder never
 * imports the action runtime (which pulls in the database layer).
 */
export interface ContractActionInfo {
  name: string;
  permissions: { agent?: boolean };
  input: ZodTypeAny;
  output: ZodTypeAny;
}

export type ContractActionRegistry = ReadonlyMap<string, ContractActionInfo> | Iterable<ContractActionInfo>;

export type ContractRule = 1 | 2 | 3 | 4 | 5 | 6;

export interface ContractIssue {
  rule: ContractRule;
  message: string;
}

export interface ContractValidation {
  ok: boolean;
  issues: ContractIssue[];
}

function toMap(registry: ContractActionRegistry): ReadonlyMap<string, ContractActionInfo> {
  if (registry instanceof Map) return registry;
  return new Map(Array.from(registry as Iterable<ContractActionInfo>, (def) => [def.name, def]));
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let cur = schema;
  for (;;) {
    const def = cur._def as Record<string, unknown>;
    switch (String(def.typeName)) {
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodReadonly':
        cur = def.innerType as ZodTypeAny;
        continue;
      case 'ZodEffects':
        cur = def.schema as ZodTypeAny;
        continue;
      case 'ZodPipeline':
        cur = def.in as ZodTypeAny;
        continue;
      case 'ZodBranded':
        cur = def.type as ZodTypeAny;
        continue;
      default:
        return cur;
    }
  }
}

/** True when a dotted path names a field of a (possibly nested) Zod object. */
export function schemaHasPath(schema: ZodTypeAny, path: string): boolean {
  let cur: ZodTypeAny = schema;
  for (const key of path.split('.')) {
    const obj = unwrapSchema(cur);
    if (String(obj._def.typeName) !== 'ZodObject') return false;
    const shape = (obj as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    if (!Object.prototype.hasOwnProperty.call(shape, key)) return false;
    cur = shape[key];
  }
  return true;
}

/**
 * Checks one contract against the action registry. `peers` is the full
 * contract list, used for the id@version uniqueness rule.
 *
 * 1. Named actions exist and are open to the agent.
 * 2. A write contract has a confirm block.
 * 3. Outbound other than 'none' names its destination source.
 * 4. Every sayBack field exists in the commit action's output schema.
 * 5. Every onFailure chain ends in message_ticket or scripted_close. When
 *    `errorCodes` is given (the action runtime's code list, passed in so this
 *    folder never imports it), every onFailure key is one of them or 'default'.
 * 6. id@version is unique, and every slot inputPath exists in the prepare input.
 */
export function validateContract(
  contract: ToolContract,
  registry: ContractActionRegistry,
  peers: readonly ToolContract[] = [],
  errorCodes?: readonly string[],
): ContractValidation {
  const actions = toMap(registry);
  const issues: ContractIssue[] = [];
  const key = contractKey(contract);

  const named = contract.confirm ? [contract.confirm.prepare, contract.confirm.commit] : [];
  for (const name of named) {
    const def = actions.get(name);
    if (!def) issues.push({ rule: 1, message: `${key}: action ${name} is not registered` });
    else if (def.permissions.agent !== true) issues.push({ rule: 1, message: `${key}: action ${name} is not open to the agent` });
  }

  if (contract.sideEffect === 'write' && !contract.confirm) {
    issues.push({ rule: 2, message: `${key}: a write contract needs a confirm block (prepare, readback, yes, commit)` });
  }

  if (contract.outbound !== 'none' && !contract.outboundDestination) {
    issues.push({ rule: 3, message: `${key}: outbound '${contract.outbound}' needs an outboundDestination` });
  }

  const commit = contract.confirm ? actions.get(contract.confirm.commit) : undefined;
  for (const field of contract.sayBack) {
    if (!commit) {
      issues.push({ rule: 4, message: `${key}: sayBack '${field}' has no commit action output to come from` });
    } else if (!schemaHasPath(commit.output, field)) {
      issues.push({ rule: 4, message: `${key}: sayBack '${field}' is not in ${commit.name} output` });
    }
  }

  const slotNames = new Set(contract.slots.map((s) => s.name));
  for (const [code, chain] of Object.entries(contract.onFailure)) {
    if (errorCodes && code !== 'default' && !errorCodes.includes(code)) {
      issues.push({ rule: 5, message: `${key}: onFailure.${code} is not a known error code` });
    }
    const last = chain[chain.length - 1];
    if (!last || !TERMINAL_STEPS.has(last.step)) {
      issues.push({ rule: 5, message: `${key}: onFailure.${code} must end in message_ticket or scripted_close` });
    }
    for (const step of chain) {
      if (step.step === 'ask_again' && !slotNames.has(step.slot)) {
        issues.push({ rule: 5, message: `${key}: onFailure.${code} asks again for unknown slot '${step.slot}'` });
      }
    }
  }

  if (peers.some((other) => other !== contract && contractKey(other) === key)) {
    issues.push({ rule: 6, message: `${key}: id@version is not unique` });
  }
  const prepare = contract.confirm ? actions.get(contract.confirm.prepare) : undefined;
  for (const slot of contract.slots) {
    if (!prepare) {
      issues.push({ rule: 6, message: `${key}: slot '${slot.name}' has no prepare action input to map to` });
    } else if (!schemaHasPath(prepare.input, slot.inputPath)) {
      issues.push({ rule: 6, message: `${key}: slot '${slot.name}' inputPath '${slot.inputPath}' is not in ${prepare.name} input` });
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Validates every contract in a list, including id@version uniqueness across it. */
export function validateContracts(
  contracts: readonly ToolContract[],
  registry: ContractActionRegistry,
  errorCodes?: readonly string[],
): ContractValidation {
  const actions = toMap(registry);
  const issues = contracts.flatMap((c) => validateContract(c, actions, contracts, errorCodes).issues);
  return { ok: issues.length === 0, issues };
}
