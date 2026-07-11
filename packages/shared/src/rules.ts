import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { PARAM_BY_NAME } from './params.js';
import { resolveAircraftRef, type AircraftConfig } from './aircraft.js';

/**
 * Structured YAML exceedance rules. Conditions are typed operators — never
 * expression strings — so rule files are statically validatable and there is
 * no eval/sandboxing surface.
 */

export const PHASE_NAMES = [
  'preflight',
  'taxi',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
  'go_around',
  'rollout',
  'postflight',
] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export const SEVERITIES = ['info', 'caution', 'warning', 'exceedance'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A numeric literal or a "$aircraft.path.to.value" reference. */
export type NumOrRef = number | string;
const numOrRef = z.union([z.number(), z.string().regex(/^\$aircraft\.[a-z0-9_.]+$/i)]);

const rangeSchema = z.object({ min: numOrRef, max: numOrRef }).strict();

export interface LeafCondition {
  parameter: string;
  gt?: NumOrRef;
  gte?: NumOrRef;
  lt?: NumOrRef;
  lte?: NumOrRef;
  abs_gt?: NumOrRef;
  between?: { min: NumOrRef; max: NumOrRef };
  outside?: { min: NumOrRef; max: NumOrRef };
}
export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] };

const leafSchema = z
  .object({
    parameter: z.string().min(1),
    gt: numOrRef.optional(),
    gte: numOrRef.optional(),
    lt: numOrRef.optional(),
    lte: numOrRef.optional(),
    abs_gt: numOrRef.optional(),
    between: rangeSchema.optional(),
    outside: rangeSchema.optional(),
  })
  .strict()
  .refine(
    (c) =>
      [c.gt, c.gte, c.lt, c.lte, c.abs_gt, c.between, c.outside].some((op) => op !== undefined),
    { message: 'leaf condition needs at least one operator' },
  )
  .refine((c) => PARAM_BY_NAME.has(c.parameter), {
    message: 'unknown canonical parameter in condition',
  });

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict(),
  ]),
);

const gateSchema = z
  .object({
    parameter: z.string().refine((p) => PARAM_BY_NAME.has(p), 'unknown parameter'),
    crossing: z.object({ value: numOrRef, direction: z.enum(['up', 'down']) }).strict(),
  })
  .strict();

export const ANCHORS = ['touchdown', 'takeoff'] as const;
const windowSchema = z
  .object({
    anchor: z.enum(ANCHORS),
    before_s: z.number().nonnegative(),
    after_s: z.number().nonnegative(),
  })
  .strict();

const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    description: z.string().optional(),
    severity: z.enum(SEVERITIES),
    phases: z.array(z.enum(PHASE_NAMES)).min(1).optional(),
    when: conditionSchema,
    gate: gateSchema.optional(),
    window: windowSchema.optional(),
    min_duration_s: z.number().positive().optional(),
    hysteresis: z.object({ release_after_s: z.number().positive() }).strict().optional(),
    peak: z
      .object({
        parameter: z.string().refine((p) => PARAM_BY_NAME.has(p), 'unknown parameter'),
        mode: z.enum(['max', 'min', 'abs_max']),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((r) => !(r.gate && r.window), { message: 'gate and window are mutually exclusive' })
  .refine((r) => !(r.gate || r.window) || (!r.min_duration_s && !r.hysteresis), {
    message: 'min_duration_s/hysteresis only apply to interval rules',
  });

export const rulesetSchema = z.object({ rules: z.array(ruleSchema).min(1) }).strict();

export type Rule = z.infer<typeof ruleSchema>;
export type Ruleset = z.infer<typeof rulesetSchema>;

export function loadRuleset(yamlText: string): Ruleset {
  return rulesetSchema.parse(parseYaml(yamlText));
}

/** Merge several rule files; duplicate ids are an error. */
export function mergeRulesets(sets: Ruleset[]): Ruleset {
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const s of sets) {
    for (const r of s.rules) {
      if (seen.has(r.id)) throw new Error(`duplicate rule id: ${r.id}`);
      seen.add(r.id);
      rules.push(r);
    }
  }
  return { rules };
}

function resolveNum(v: NumOrRef, aircraft: AircraftConfig): number {
  return typeof v === 'number' ? v : resolveAircraftRef(v, aircraft);
}

function resolveCondition(c: Condition, aircraft: AircraftConfig): Condition {
  if ('all' in c) return { all: c.all.map((x) => resolveCondition(x, aircraft)) };
  if ('any' in c) return { any: c.any.map((x) => resolveCondition(x, aircraft)) };
  const out: LeafCondition = { parameter: c.parameter };
  for (const op of ['gt', 'gte', 'lt', 'lte', 'abs_gt'] as const) {
    const v = c[op];
    if (v !== undefined) out[op] = resolveNum(v, aircraft);
  }
  for (const op of ['between', 'outside'] as const) {
    const v = c[op];
    if (v !== undefined)
      out[op] = { min: resolveNum(v.min, aircraft), max: resolveNum(v.max, aircraft) };
  }
  return out;
}

/** Resolve every $aircraft.* reference to a number; result is fully literal. */
export function resolveRuleset(ruleset: Ruleset, aircraft: AircraftConfig): Ruleset {
  return {
    rules: ruleset.rules.map((r) => ({
      ...r,
      when: resolveCondition(r.when, aircraft),
      gate: r.gate
        ? { ...r.gate, crossing: { ...r.gate.crossing, value: resolveNum(r.gate.crossing.value, aircraft) } }
        : undefined,
    })),
  };
}

/**
 * Canonical JSON of a resolved ruleset (sorted by rule id, stable key order via
 * JSON.stringify of already-plain objects). The server hashes this to produce
 * ruleset_hash stamped onto each analyzed flight.
 */
export function canonicalRulesetJson(ruleset: Ruleset): string {
  const sorted = [...ruleset.rules].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(sorted, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return v;
  });
}
