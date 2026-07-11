import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { generateScenario, simulateScenario } from '@foqa/g3x-synth';
import { loadParameterMap } from '@foqa/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseG3xCsv } from '../src/parse/g3xParser.js';
import { configDir } from '../src/config.js';

const map = loadParameterMap(readFileSync(join(configDir(), 'parameter-map.yaml'), 'utf8'));

const parseText = (csv: string) => parseG3xCsv(Readable.from([csv]), map);

describe('parseG3xCsv on clean synthetic logs', () => {
  it('parses every row, converts units, preserves unmapped columns in extra', async () => {
    const sim = simulateScenario('normal-xc', 42);
    const gen = generateScenario('normal-xc', { seed: 42 });
    const parsed = await parseText(gen.files[0]!.csv);

    expect(parsed.samples).toHaveLength(sim.length);
    expect(parsed.droppedRows).toBe(0);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.metadata.airframe_name).toBe('RV-12');
    expect(parsed.metadata.log_version).toBe('1.03');

    // timestamps are UTC (writer emitted local -05:00)
    expect(parsed.samples[0]!.ts.getTime()).toBe(sim[0]!.t.getTime());

    const mid = parsed.samples[Math.floor(sim.length / 2)]!;
    const simMid = sim[Math.floor(sim.length / 2)]!;
    // oil temp was written in °F rounded to whole degrees → within 0.3 °C
    expect(Math.abs(mid.values.oil_temp_c! - simMid.oilTempC)).toBeLessThan(0.3);
    expect(Math.abs(mid.values.coolant_temp_c! - simMid.coolantC)).toBeLessThan(0.3);
    expect(Math.abs(mid.values.egt1_c! - simMid.egtC[0])).toBeLessThan(0.3);
    expect(Math.abs(mid.values.ias_kt! - simMid.iasKt)).toBeLessThan(0.06);
    // AltB is intentionally unmapped → preserved raw
    expect(mid.extra.AltB).toBeDefined();
    expect(mid.values.alt_msl_ft).not.toBeNull();
  });
});

describe('parseG3xCsv on garbage', () => {
  it('tolerates torn last row, --- cells and duplicate timestamps', async () => {
    const sim = simulateScenario('normal-xc', 42);
    const gen = generateScenario('normal-xc', { seed: 42, garbageRate: 1 });
    const parsed = await parseText(gen.files[0]!.csv);

    expect(parsed.duplicateRows).toBeGreaterThan(0);
    // no invented data: every sample ts is unique & monotonic
    for (let i = 1; i < parsed.samples.length; i++) {
      expect(parsed.samples[i]!.ts.getTime()).toBeGreaterThan(parsed.samples[i - 1]!.ts.getTime());
    }
    // sample count within a couple of the source (torn row may or may not survive)
    expect(parsed.samples.length).toBeGreaterThanOrEqual(sim.length - 2);
    expect(parsed.samples.length).toBeLessThanOrEqual(sim.length);
    // '---' tokens became nulls somewhere
    const nullCount = parsed.samples.reduce(
      (acc, s) => acc + Object.values(s.values).filter((v) => v === null).length,
      0,
    );
    expect(nullCount).toBeGreaterThan(0);
  });

  it('routes columns with unconvertible units to extra with a warning', async () => {
    const csv = [
      '#airframe_info, log_version="1.03", airframe_name="RV-12",',
      '#yyyy-mm-dd,hh:mm:ss,hh:mm,furlongs',
      'Lcl Date,Lcl Time,UTCOfst,IAS',
      '2026-07-03,10:00:00,-05:00,61.2',
    ].join('\n');
    const parsed = await parseText(csv);
    expect(parsed.warnings.some((w) => w.includes('furlongs'))).toBe(true);
    expect(parsed.samples[0]!.values.ias_kt).toBeUndefined();
    expect(parsed.samples[0]!.extra.IAS).toBe('61.2');
  });

  it('throws on a file with no header row', async () => {
    await expect(parseText('#airframe_info, x=1\n#units\n')).rejects.toThrow(/no column header/);
  });

  it('drops rows with unparseable time cells', async () => {
    const csv = [
      '#airframe_info, log_version="1.03",',
      '#yyyy-mm-dd,hh:mm:ss,hh:mm,kt',
      'Lcl Date,Lcl Time,UTCOfst,IAS',
      '2026-07-03,10:00:00,-05:00,61.2',
      '---,---,---,55.0',
      '2026-07-03,10:00:02,-05:00,62.0',
    ].join('\n');
    const parsed = await parseText(csv);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.droppedRows).toBe(1);
  });
});
