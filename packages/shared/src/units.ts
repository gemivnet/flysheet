/**
 * Unit conversions keyed by (sourceUnit -> canonicalUnit).
 * Source-unit spellings from CSV units rows are normalized via UNIT_ALIASES first.
 * A missing conversion for mismatched units means "don't guess": the parser
 * warns and routes the column to `extra`.
 */

export type Convert = (v: number) => number;

/** Normalize the many spellings found in G3X/G1000-family units rows. */
export const UNIT_ALIASES: Readonly<Record<string, string>> = {
  degrees: 'deg',
  degree: 'deg',
  kts: 'kt',
  knots: 'kt',
  'ft Baro': 'ft',
  'ft msl': 'ft',
  'ft wgs': 'ft',
  'ft agl': 'ft',
  feet: 'ft',
  fpm: 'fpm',
  'ft/min': 'fpm',
  'deg C': 'C',
  'deg F': 'F',
  gals: 'gal',
  gph: 'gph',
  volts: 'V',
  amps: 'A',
  G: 'G',
  g: 'G',
  psi: 'psi',
  rpm: 'rpm',
  mph: 'mph',
  'm/s': 'mps',
  meters: 'm',
};

export function normalizeUnit(raw: string): string {
  const trimmed = raw.trim().replace(/^#/, '').trim();
  return UNIT_ALIASES[trimmed] ?? trimmed;
}

const CONVERSIONS: Readonly<Record<string, Convert>> = {
  'F->C': (f) => ((f - 32) * 5) / 9,
  'C->F': (c) => (c * 9) / 5 + 32,
  'mph->kt': (v) => v * 0.868976,
  'kt->mph': (v) => v / 0.868976,
  'm->ft': (v) => v * 3.28084,
  'ft->m': (v) => v / 3.28084,
  'mps->fpm': (v) => v * 196.850394,
  'mps->kt': (v) => v * 1.943844,
};

/**
 * Returns a conversion from a (normalized) source unit to a canonical unit,
 * identity when they already match, or null when no safe conversion exists.
 */
export function conversionFor(sourceUnit: string, canonicalUnit: string): Convert | null {
  if (sourceUnit === canonicalUnit) return (v) => v;
  return CONVERSIONS[`${sourceUnit}->${canonicalUnit}`] ?? null;
}
