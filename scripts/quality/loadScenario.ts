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

const expectedBookingSchema = z
  .object({
    status: z.string().optional(),
    startLocal: z.string().optional(),
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
              .optional(),
            tickets: z
              .object({
                count: z.number().int().nonnegative().optional(),
                kind: z.string().optional(),
                status: z.string().optional(),
              })
              .strict()
              .optional(),
            transfers: z
              .object({
                count: z.number().int().nonnegative().optional(),
                to: z.string().optional(),
              })
              .strict()
              .optional(),
            waitlist: z
              .object({
                count: z.number().int().nonnegative().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        mustSay: z.array(z.string()).optional(),
        mustNotSay: z.array(z.string()).optional(),
        readbackRequired: z.boolean().optional(),
      })
      .strict(),
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
