/**
 * Canonical parameter registry — the single source of truth for:
 * samples/samples_derived table columns, chart labels, rule validation,
 * and the synthetic fixture generator.
 */

export type SampleTable = 'samples' | 'samples_derived';

export interface ParamDef {
  /** Canonical snake_case name; doubles as the DB column name. */
  name: string;
  label: string;
  /** Canonical unit (see units.ts for accepted source-unit conversions). */
  unit: string;
  table: SampleTable;
}

const P = (name: string, label: string, unit: string, table: SampleTable = 'samples'): ParamDef => ({
  name,
  label,
  unit,
  table,
});

export const PARAMS: readonly ParamDef[] = [
  P('lat', 'Latitude', 'deg'),
  P('lon', 'Longitude', 'deg'),
  P('alt_msl_ft', 'Altitude (baro MSL)', 'ft'),
  P('alt_gps_ft', 'Altitude (GPS)', 'ft'),
  P('pitch_deg', 'Pitch', 'deg'),
  P('roll_deg', 'Roll', 'deg'),
  P('hdg_deg', 'Heading', 'deg'),
  P('track_deg', 'Ground Track', 'deg'),
  P('ias_kt', 'Indicated Airspeed', 'kt'),
  P('tas_kt', 'True Airspeed', 'kt'),
  P('gs_kt', 'Ground Speed', 'kt'),
  P('vsi_fpm', 'Vertical Speed', 'fpm'),
  P('norm_g', 'Normal Acceleration', 'G'),
  P('lat_g', 'Lateral Acceleration', 'G'),
  P('rpm', 'Engine RPM', 'rpm'),
  P('oil_temp_c', 'Oil Temperature', 'C'),
  P('oil_press_psi', 'Oil Pressure', 'psi'),
  P('coolant_temp_c', 'Coolant Temperature', 'C'),
  P('egt1_c', 'EGT 1', 'C'),
  P('egt2_c', 'EGT 2', 'C'),
  P('egt3_c', 'EGT 3', 'C'),
  P('egt4_c', 'EGT 4', 'C'),
  P('fuel_flow_gph', 'Fuel Flow', 'gph'),
  P('fuel_qty_gal', 'Fuel Quantity', 'gal'),
  P('volts', 'Bus Voltage', 'V'),
  P('amps', 'Alternator Load', 'A'),
  P('oat_c', 'Outside Air Temperature', 'C'),
  // Derived (analyze-stage output; regenerable):
  P('agl_ft', 'Height AGL', 'ft', 'samples_derived'),
  P('terrain_elev_ft', 'Terrain Elevation', 'ft', 'samples_derived'),
  P('dist_thr_nm', 'Distance to Threshold', 'nm', 'samples_derived'),
  P('gp_dev_deg', 'Glidepath Deviation', 'deg', 'samples_derived'),
  P('egt_spread_c', 'EGT Spread', 'C', 'samples_derived'),
];

export const PARAM_BY_NAME: ReadonlyMap<string, ParamDef> = new Map(PARAMS.map((p) => [p.name, p]));

export const SAMPLE_PARAMS = PARAMS.filter((p) => p.table === 'samples');
export const DERIVED_PARAMS = PARAMS.filter((p) => p.table === 'samples_derived');

export function isCanonicalParam(name: string): boolean {
  return PARAM_BY_NAME.has(name);
}

/** One canonical 1 Hz sample: canonical param name → value (null = not recorded). */
export type Sample = {
  ts: Date;
  values: Record<string, number | null>;
  /** Unmapped G3X columns preserved verbatim for future promotion. */
  extra: Record<string, string>;
};
