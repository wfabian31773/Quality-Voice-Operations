import { z } from 'zod';
import { loadYaml } from './yaml';
import { TEMPLATES, TOOLS, type Scenario } from './types';

const callerTurnSchema = z
  .object({
    text: z.string().optional(),
    silence: z.union([z.boolean(), z.number()]).optional(),
    interrupt: z.boolean().optional(),
  })
  .strict()
  .refine((turn) => turn.text !== undefined || turn.silence !== undefined || turn.interrupt !== undefined, {
    message: 'caller turn needs text, silence, or interrupt',
  });

const scriptStepSchema = z.union([
  z
    .object({
      call: z
        .object({
          name: z.string().min(1),
          input: z.record(z.unknown()).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ say: z.string() }).strict(),
]);

function hasRealAssertion(value: {
  actions?: unknown[];
  endState?: {
    bookings?: { count?: number; items?: unknown[] };
    tickets?: { count?: number; kind?: string; status?: string };
    transfers?: { count?: number; to?: string; status?: string };
    waitlist?: { count?: number };
  };
}): boolean {
  if (Array.isArray(value.actions) && value.actions.length > 0) return true;
  const end = value.endState;
  if (!end) return false;
  if (end.bookings && (end.bookings.count !== undefined || (end.bookings.items?.length ?? 0) > 0)) return true;
  if (end.tickets && (end.tickets.count !== undefined || Boolean(end.tickets.kind) || Boolean(end.tickets.status))) {
    return true;
  }
  if (end.transfers && (end.transfers.count !== undefined || Boolean(end.transfers.to) || Boolean(end.transfers.status))) {
    return true;
  }
  if (end.waitlist && end.waitlist.count !== undefined) return true;
  return false;
}

const expectedBookingSchema = z
  .object({
    status: z.string().optional(),
    startLocal: z.string().optional(),
    date: z.string().optional(),
    staffId: z.string().optional(),
    staffName: z.string().optional(),
  })
  .strict();

const scenarioSchema = z
  .object({
    id: z.string().min(1),
    template: z.enum(TEMPLATES),
    tools: z.array(z.enum(TOOLS)).min(1),
    tags: z.array(z.string()).default([]),
    seed: z.string().min(1),
    now: z.string().optional(),
    caller: z.array(callerTurnSchema).min(1),
    script: z
      .array(
        z
          .object({
            on: z.number().int().nonnegative().optional(),
            steps: z.array(scriptStepSchema).min(1),
          })
          .strict(),
      )
      .optional(),
    expect: z
      .object({
        actions: z
          .array(
            z
              .object({
                name: z.string().min(1),
                input: z.record(z.unknown()).optional(),
              })
              .strict(),
          )
          .optional(),
        endState: z
          .object({
            bookings: z
              .object({
                count: z.number().int().nonnegative().optional(),
                items: z.array(expectedBookingSchema).optional(),
              })
              .strict()
              .refine(
                (value) => value.count !== undefined || (Array.isArray(value.items) && value.items.length > 0),
                { message: 'bookings requires count and/or items' },
              )
              .optional(),
            tickets: z
              .object({
                count: z.number().int().nonnegative().optional(),
                kind: z.string().optional(),
                status: z.string().optional(),
              })
              .strict()
              .refine(
                (value) => value.count !== undefined || Boolean(value.kind) || Boolean(value.status),
                { message: 'tickets requires count, kind, and/or status' },
              )
              .optional(),
            transfers: z
              .object({
                count: z.number().int().nonnegative().optional(),
                to: z.string().optional(),
                status: z.string().optional(),
              })
              .strict()
              .refine(
                (value) => value.count !== undefined || Boolean(value.to) || Boolean(value.status),
                { message: 'transfers requires count, to, and/or status' },
              )
              .optional(),
            waitlist: z
              .object({
                count: z.number().int().nonnegative().optional(),
              })
              .strict()
              .refine((value) => value.count !== undefined, { message: 'waitlist requires count' })
              .optional(),
          })
          .strict()
          .optional(),
        mustSay: z.array(z.string()).optional(),
        mustNotSay: z.array(z.string()).optional(),
        readbackRequired: z.boolean().optional(),
      })
      .strict()
      .refine((value) => hasRealAssertion(value), {
        message: 'expect requires at least one assertion in actions and/or endState',
      }),
    expectedFail: z.string().optional(),
  })
  .strict();

export function parseScenario(raw: unknown, source = 'scenario'): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`).join('; ');
    throw new Error(`${source}: ${details}`);
  }
  return parsed.data;
}

export function loadScenarioYaml(src: string, source = 'scenario'): Scenario {
  return parseScenario(loadYaml(src), source);
}
