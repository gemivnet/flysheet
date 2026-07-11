import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { PARAM_BY_NAME } from './params.js';

/**
 * config/parameter-map.yaml — data-driven mapping from G3X CSV header cells
 * (with alternate spellings across G3X software versions) to canonical params.
 */

const parameterMapSchema = z.object({
  version: z.number().int(),
  time: z.object({
    date: z.array(z.string().min(1)).min(1),
    time: z.array(z.string().min(1)).min(1),
    utcOffset: z.array(z.string().min(1)).min(1),
  }),
  parameters: z.record(z.string(), z.object({ headers: z.array(z.string().min(1)).min(1) })),
});

export type ParameterMapConfig = z.infer<typeof parameterMapSchema>;

export interface ParameterMap {
  version: number;
  time: { date: string[]; time: string[]; utcOffset: string[] };
  /** header cell (trimmed) → canonical param name */
  headerToCanonical: ReadonlyMap<string, string>;
}

export function loadParameterMap(yamlText: string): ParameterMap {
  const cfg = parameterMapSchema.parse(parseYaml(yamlText));
  const headerToCanonical = new Map<string, string>();
  for (const [canonical, { headers }] of Object.entries(cfg.parameters)) {
    const def = PARAM_BY_NAME.get(canonical);
    if (!def) throw new Error(`parameter-map: unknown canonical parameter "${canonical}"`);
    if (def.table !== 'samples')
      throw new Error(`parameter-map: "${canonical}" is derived; it cannot be mapped from CSV`);
    for (const h of headers) {
      const key = h.trim();
      const existing = headerToCanonical.get(key);
      if (existing && existing !== canonical)
        throw new Error(`parameter-map: header "${key}" mapped to both ${existing} and ${canonical}`);
      headerToCanonical.set(key, canonical);
    }
  }
  return { version: cfg.version, time: cfg.time, headerToCanonical };
}
