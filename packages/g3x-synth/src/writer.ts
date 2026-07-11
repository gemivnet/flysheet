import { formatG3xLocal } from '@foqa/shared';
import type { SimSample } from './sim.js';

/**
 * Emits G3X-Touch-style CSV: an #airframe_info metadata line, a #-prefixed
 * units row, a column-name row, then 1 Hz data rows in local time + UTC offset.
 * Temperatures for engine channels are written in °F (as US-unit G3X installs
 * log them) to exercise unit conversion at parse time.
 */

export interface WriterOptions {
  utcOffsetMin: number;
  systemId?: string;
  airframeName?: string;
  /** 0..1 — probability knobs for torn last row / '---' cells / duplicated rows. */
  garbageRate?: number;
  rand?: () => number;
}

const cToF = (c: number) => (c * 9) / 5 + 32;

interface Col {
  header: string;
  unit: string;
  value: (s: SimSample) => string;
}

const num = (v: number, dp: number) => v.toFixed(dp);

export const G3X_COLUMNS: Col[] = [
  { header: 'Lcl Date', unit: 'yyyy-mm-dd', value: () => '' }, // filled by writer
  { header: 'Lcl Time', unit: 'hh:mm:ss', value: () => '' },
  { header: 'UTCOfst', unit: 'hh:mm', value: () => '' },
  { header: 'Latitude', unit: 'degrees', value: (s) => num(s.lat, 7) },
  { header: 'Longitude', unit: 'degrees', value: (s) => num(s.lon, 7) },
  // AltB is deliberately left out of parameter-map.yaml: it must land in
  // samples.extra, proving unmapped-column preservation.
  { header: 'AltB', unit: 'ft Baro', value: (s) => num(s.altMslFt - 15, 1) },
  { header: 'AltMSL', unit: 'ft msl', value: (s) => num(s.altMslFt, 1) },
  { header: 'AltGPS', unit: 'ft wgs', value: (s) => num(s.altGpsFt, 1) },
  { header: 'OAT', unit: 'deg C', value: (s) => num(s.oatC, 1) },
  { header: 'IAS', unit: 'kt', value: (s) => num(s.iasKt, 1) },
  { header: 'TAS', unit: 'kt', value: (s) => num(s.tasKt, 1) },
  { header: 'GndSpd', unit: 'kt', value: (s) => num(s.gsKt, 1) },
  { header: 'VSpd', unit: 'fpm', value: (s) => num(s.vsiFpm, 0) },
  { header: 'Pitch', unit: 'degrees', value: (s) => num(s.pitchDeg, 1) },
  { header: 'Roll', unit: 'degrees', value: (s) => num(s.rollDeg, 1) },
  { header: 'LatAc', unit: 'G', value: (s) => num(s.latG, 2) },
  { header: 'NormAc', unit: 'G', value: (s) => num(s.normG, 2) },
  { header: 'HDG', unit: 'degrees', value: (s) => num(s.hdgDeg, 1) },
  { header: 'TRK', unit: 'degrees', value: (s) => num(s.trkDeg, 1) },
  { header: 'volt1', unit: 'volts', value: (s) => num(s.volts, 1) },
  { header: 'amp1', unit: 'amps', value: (s) => num(s.amps, 1) },
  { header: 'FQtyL', unit: 'gals', value: (s) => num(s.fuelQtyGal, 1) },
  { header: 'E1 FFlow', unit: 'gph', value: (s) => num(s.fuelFlowGph, 1) },
  { header: 'E1 OilT', unit: 'deg F', value: (s) => num(cToF(s.oilTempC), 0) },
  { header: 'E1 OilP', unit: 'psi', value: (s) => num(s.oilPressPsi, 0) },
  { header: 'E1 RPM', unit: 'rpm', value: (s) => num(s.rpm, 0) },
  { header: 'E1 CoolT', unit: 'deg F', value: (s) => num(cToF(s.coolantC), 0) },
  { header: 'E1 EGT1', unit: 'deg F', value: (s) => num(cToF(s.egtC[0]), 0) },
  { header: 'E1 EGT2', unit: 'deg F', value: (s) => num(cToF(s.egtC[1]), 0) },
  { header: 'E1 EGT3', unit: 'deg F', value: (s) => num(cToF(s.egtC[2]), 0) },
  { header: 'E1 EGT4', unit: 'deg F', value: (s) => num(cToF(s.egtC[3]), 0) },
];

export function writeG3xCsv(samples: SimSample[], opts: WriterOptions): string {
  const rand = opts.rand ?? Math.random;
  const garbage = opts.garbageRate ?? 0;
  const lines: string[] = [];
  lines.push(
    `#airframe_info, log_version="1.03", airframe_name="${opts.airframeName ?? 'RV-12'}", ` +
      `unit_software_part_number="006-B1727-XX", system_id="${opts.systemId ?? 'FOQA-SYNTH'}", mode=NORMAL,`,
  );
  lines.push('#' + G3X_COLUMNS.map((c) => c.unit).join(','));
  lines.push(G3X_COLUMNS.map((c) => c.header).join(','));

  for (const s of samples) {
    const { lclDate, lclTime, utcOfst } = formatG3xLocal(s.t, opts.utcOffsetMin);
    const cells = G3X_COLUMNS.map((c) => c.value(s));
    cells[0] = lclDate;
    cells[1] = lclTime;
    cells[2] = utcOfst;
    if (garbage > 0) {
      // sprinkle '---' into non-critical cells (never time/lat/lon)
      for (let i = 5; i < cells.length; i++) {
        if (rand() < garbage * 0.02) cells[i] = '---';
      }
    }
    lines.push(cells.join(','));
    if (garbage > 0 && rand() < garbage * 0.01) lines.push(cells.join(',')); // duplicate timestamp row
  }

  if (garbage > 0 && lines.length > 4) {
    // torn final row: power was cut mid-write
    const last = lines.pop()!;
    lines.push(last.slice(0, Math.max(20, Math.floor(last.length * 0.4))));
  }
  return lines.join('\n') + '\n';
}

/** G3X-style log file name: log_YYMMDD_HHMMSS_<near>.csv (local time). */
export function g3xFileName(firstSample: Date, utcOffsetMin: number, nearIdent: string): string {
  const { lclDate, lclTime } = formatG3xLocal(firstSample, utcOffsetMin);
  const d = lclDate.replaceAll('-', '').slice(2);
  const t = lclTime.replaceAll(':', '');
  return `log_${d}_${t}_${nearIdent}.csv`;
}
