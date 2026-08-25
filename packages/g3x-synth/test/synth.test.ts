import { describe, expect, it } from 'vitest';
import { haversineNm } from '@foqa/shared';
import { AIRPORTS, runwayEnd } from '../src/airports.js';
import { G3X_COLUMNS, writeG3xCsv } from '../src/writer.js';
import { SCENARIO_NAMES, generateScenario, simulateScenario } from '../src/scenarios.js';
import type { SimSample } from '../src/sim.js';

function liftoffs(samples: SimSample[]): number[] {
  const idx: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]!.onGround && !samples[i]!.onGround) idx.push(i);
  }
  return idx;
}
function touchdowns(samples: SimSample[]): number[] {
  const idx: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (!samples[i - 1]!.onGround && samples[i]!.onGround) idx.push(i);
  }
  return idx;
}
const agl = (s: SimSample, elev: number) => s.altMslFt - elev;

describe('every scenario', () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name}: monotonic 1 Hz time, sane dynamics, lands where it should`, () => {
      const samples = simulateScenario(name, 42);
      expect(samples.length).toBeGreaterThan(600);
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]!.t.getTime() - samples[i - 1]!.t.getTime()).toBe(1000);
        // |Δias| bounded (slew 1.5 kt/s + noise)
        expect(Math.abs(samples[i]!.iasKt - samples[i - 1]!.iasKt)).toBeLessThanOrEqual(2.5);
        expect(Math.abs(samples[i]!.rollDeg)).toBeLessThan(40);
      }
      // starts and ends parked
      expect(samples[0]!.onGround).toBe(true);
      expect(samples[0]!.iasKt).toBe(0);
      expect(samples.at(-1)!.onGround).toBe(true);
      expect(samples.at(-1)!.rpm).toBeLessThan(100);
      expect(touchdowns(samples).length).toBeGreaterThan(0);
    });
  }
});

describe('pattern-work', () => {
  const samples = simulateScenario('pattern-work', 42);
  const rwy = runwayEnd(AIRPORTS.KLOT!, '27');

  it('has 3 liftoffs and 3 touchdowns (2 T&G + full stop)', () => {
    expect(liftoffs(samples)).toHaveLength(3);
    expect(touchdowns(samples)).toHaveLength(3);
  });

  it('touch-and-go ground time < 30 s', () => {
    const tds = touchdowns(samples);
    const lifts = liftoffs(samples);
    // T&G ground intervals: touchdown i → next liftoff
    for (const td of tds.slice(0, 2)) {
      const nextLift = lifts.find((l) => l > td)!;
      expect(nextLift - td).toBeLessThan(30);
    }
  });

  it('every touchdown is on the runway near the threshold', () => {
    for (const td of touchdowns(samples)) {
      const s = samples[td]!;
      const dThr = haversineNm(s.lat, s.lon, rwy.thrLat, rwy.thrLon);
      expect(dThr).toBeLessThan(0.6); // within ~2/3 of the 1.07 nm runway
    }
  });
});

describe('go-around', () => {
  const samples = simulateScenario('go-around', 42);
  const elev = AIRPORTS.KLOT!.elevFt;

  it('descends to ~300 AGL on approach without touching, then climbs away', () => {
    const tds = touchdowns(samples);
    expect(tds).toHaveLength(1); // only the final full-stop
    const ga = samples.findIndex((s) => s.segment === 'go-around');
    expect(ga).toBeGreaterThan(0);
    const minAglBefore = Math.min(...samples.slice(ga - 20, ga + 5).map((s) => agl(s, elev)));
    expect(minAglBefore).toBeLessThan(400);
    expect(minAglBefore).toBeGreaterThan(150);
    // climbing with power within 10 s of go-around start
    const after = samples[ga + 10]!;
    expect(after.rpm).toBeGreaterThan(5400);
    expect(after.vsiFpm).toBeGreaterThan(300);
  });
});

describe('unstable-approach', () => {
  const samples = simulateScenario('unstable-approach', 42);
  const arr = runwayEnd(AIRPORTS.KIKK!, '16');

  it('sinks > 1000 fpm below 1000 AGL for at least 3 s', () => {
    const bad = samples.filter((s) => {
      const a = agl(s, arr.elevFt);
      return a > 50 && a < 1000 && s.vsiFpm < -1000;
    });
    expect(bad.length).toBeGreaterThanOrEqual(3);
  });

  it('crosses 500 AGL descending at Vref+10 or faster', () => {
    let crossing: SimSample | undefined;
    for (let i = 1; i < samples.length; i++) {
      const prev = agl(samples[i - 1]!, arr.elevFt);
      const cur = agl(samples[i]!, arr.elevFt);
      if (prev >= 500 && cur < 500 && !samples[i]!.onGround) crossing = samples[i]!;
    }
    expect(crossing).toBeDefined();
    expect(crossing!.iasKt).toBeGreaterThan(70); // vref 60 → well outside +8
  });

  it('touches down hard (> 2 G)', () => {
    const td = touchdowns(samples).at(-1)!;
    expect(samples[td]!.normG).toBeGreaterThan(2.0);
  });
});

describe('engine-exceedance', () => {
  const samples = simulateScenario('engine-exceedance', 42);

  it('coolant exceeds 120 °C for ≥ 90 s with peak ≈ 123', () => {
    const hot = samples.filter((s) => s.coolantC > 120);
    expect(hot.length).toBeGreaterThanOrEqual(90);
    const peak = Math.max(...samples.map((s) => s.coolantC));
    expect(peak).toBeGreaterThan(122);
    expect(peak).toBeLessThan(125);
  });

  it('holds > 5500 RPM continuously past the 5-minute limit', () => {
    let run = 0;
    let best = 0;
    for (const s of samples) {
      run = s.rpm > 5500 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    expect(best).toBeGreaterThan(300);
  });
});

describe('normal-xc (false-positive guard)', () => {
  const samples = simulateScenario('normal-xc', 42);
  const arr = runwayEnd(AIRPORTS.KIKK!, '16');

  it('never sinks > 1000 fpm below 1000 AGL and lands gently near the threshold', () => {
    for (const s of samples) {
      const a = agl(s, arr.elevFt);
      if (a > 50 && a < 1000 && !s.onGround) expect(s.vsiFpm).toBeGreaterThan(-1000);
    }
    const td = touchdowns(samples).at(-1)!;
    expect(samples[td]!.normG).toBeLessThan(1.6);
    expect(haversineNm(samples[td]!.lat, samples[td]!.lon, arr.thrLat, arr.thrLon)).toBeLessThan(0.6);
  });

  it('stays inside Vref−5..Vref+8 through the 500 AGL gate', () => {
    for (let i = 1; i < samples.length; i++) {
      const prev = agl(samples[i - 1]!, arr.elevFt);
      const cur = agl(samples[i]!, arr.elevFt);
      if (prev >= 500 && cur < 500 && !samples[i]!.onGround && samples[i]!.vsiFpm < 0) {
        expect(samples[i]!.iasKt).toBeGreaterThan(55);
        expect(samples[i]!.iasKt).toBeLessThan(68);
      }
    }
  });

  it('keeps engine parameters inside Rotax limits', () => {
    for (const s of samples) {
      expect(s.coolantC).toBeLessThan(120);
      expect(s.oilTempC).toBeLessThan(130);
    }
    let run = 0;
    for (const s of samples) {
      run = s.rpm > 5500 ? run + 1 : 0;
      expect(run).toBeLessThan(300);
    }
  });
});

describe('power-interruption', () => {
  it('emits two files with a 45 s recording gap mid-flight', () => {
    const gen = generateScenario('power-interruption', { seed: 42 });
    expect(gen.files).toHaveLength(2);
    const lastA = gen.files[0]!.csv.trimEnd().split('\n').at(-1)!.split(',');
    const firstB = gen.files[1]!.csv.split('\n')[3]!.split(',');
    // Lcl Time cells
    const [hA, mA, sA] = lastA[1]!.split(':').map(Number);
    const [hB, mB, sB] = firstB[1]!.split(':').map(Number);
    const gap = hB! * 3600 + mB! * 60 + sB! - (hA! * 3600 + mA! * 60 + sA!);
    expect(gap).toBe(46); // 45 s of missing samples → 46 s between adjacent rows
  });
});

describe('CSV writer', () => {
  const samples = simulateScenario('normal-xc', 42).slice(0, 50);

  it('emits the three-line G3X header with aligned units and columns', () => {
    const csv = writeG3xCsv(samples, { utcOffsetMin: -300 });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^#airframe_info/);
    expect(lines[0]).toContain('airframe_name="RV-12"');
    expect(lines[1]!.startsWith('#')).toBe(true);
    const units = lines[1]!.slice(1).split(',');
    const headers = lines[2]!.split(',');
    expect(units).toHaveLength(G3X_COLUMNS.length);
    expect(headers).toHaveLength(G3X_COLUMNS.length);
    expect(headers[0]).toBe('Lcl Date');
    // every data row has the full column count
    for (const row of lines.slice(3)) {
      expect(row.split(',')).toHaveLength(G3X_COLUMNS.length);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = generateScenario('pattern-work', { seed: 7 });
    const b = generateScenario('pattern-work', { seed: 7 });
    expect(a.files[0]!.csv).toBe(b.files[0]!.csv);
    const c = generateScenario('pattern-work', { seed: 8 });
    expect(c.files[0]!.csv).not.toBe(a.files[0]!.csv);
  });

  it('garbageRate injects a torn last row and --- cells', () => {
    const gen = generateScenario('normal-xc', { seed: 42, garbageRate: 1 });
    const lines = gen.files[0]!.csv.trimEnd().split('\n');
    const last = lines.at(-1)!;
    expect(last.split(',').length).toBeLessThan(G3X_COLUMNS.length);
    expect(gen.files[0]!.csv).toContain('---');
  });
});
