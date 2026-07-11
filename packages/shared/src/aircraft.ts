import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

/** config/aircraft.yaml — airframe constants; also resolvable from rules via $aircraft.* refs. */

export const aircraftSchema = z.object({
  name: z.string(),
  engine: z.string(),
  vspeeds: z.object({
    vs0_kt: z.number(),
    vr_kt: z.number(),
    vx_kt: z.number(),
    vy_kt: z.number(),
    vfe_kt: z.number(),
    va_kt: z.number(),
    vno_kt: z.number(),
    vne_kt: z.number(),
    vref_kt: z.number(),
  }),
  pattern_alt_agl_ft: z.number(),
  phases: z.object({
    ground_agl_ft: z.number(),
    ground_vsi_fpm: z.number(),
    ground_debounce_s: z.number(),
    moving_gs_kt: z.number(),
    moving_sustain_s: z.number(),
    takeoff_rpm: z.number(),
    climb_vsi_fpm: z.number(),
    descent_vsi_fpm: z.number(),
    vsi_debounce_s: z.number(),
    approach_agl_ft: z.number(),
    approach_airport_dist_nm: z.number(),
    goaround_vsi_fpm: z.number(),
    goaround_rpm_jump: z.number(),
    goaround_rpm_window_s: z.number(),
    goaround_max_agl_ft: z.number(),
    touchngo_max_ground_s: z.number(),
    landing_agl_ft: z.number(),
  }),
  stitching: z.object({
    max_gap_s: z.number(),
    max_dist_nm: z.number(),
  }),
});

export type AircraftConfig = z.infer<typeof aircraftSchema>;

export function loadAircraftConfig(yamlText: string): AircraftConfig {
  return aircraftSchema.parse(parseYaml(yamlText));
}

/** Resolve a "$aircraft.a.b.c" reference against the loaded config. Throws on miss. */
export function resolveAircraftRef(ref: string, aircraft: AircraftConfig): number {
  if (!ref.startsWith('$aircraft.')) throw new Error(`not an aircraft ref: ${ref}`);
  const path = ref.slice('$aircraft.'.length).split('.');
  let cur: unknown = aircraft;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || !(key in cur))
      throw new Error(`aircraft ref not found: ${ref}`);
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== 'number') throw new Error(`aircraft ref is not a number: ${ref}`);
  return cur;
}
