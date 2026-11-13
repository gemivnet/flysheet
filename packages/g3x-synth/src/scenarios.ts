import { destinationPoint, mulberry32 } from '@foqa/shared';
import { AIRPORTS, runwayEnd, type Airport, type RunwayEnd } from './airports.js';
import { runSim, type Segment, type SimConfig, type SimSample, type Wind } from './sim.js';
import { g3xFileName, writeG3xCsv } from './writer.js';
import type { EngineOverride } from './engine.js';

export const SCENARIO_NAMES = [
  'pattern-work',
  'normal-xc',
  'go-around',
  'power-interruption',
  'unstable-approach',
  'engine-exceedance',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface GeneratedFile {
  name: string;
  csv: string;
}
export interface GeneratedScenario {
  scenario: ScenarioName;
  seed: number;
  files: GeneratedFile[];
}

export interface GenerateOptions {
  seed?: number;
  /** 0..1 — inject torn last row, '---' cells, duplicated timestamps. */
  garbageRate?: number;
}

const UTC_OFFSET_MIN = -300; // CDT

// ---------------------------------------------------------------------------
// Script building blocks
// ---------------------------------------------------------------------------

function startupAndTaxi(rwy: RunwayEnd): Segment[] {
  return [
    { name: 'engine-start', rpm: 1400, ias: 0, durationS: 40, onGround: true, groundElevFt: rwy.elevFt, heading: rwy.headingTrue },
    { name: 'taxi-out', rpm: 2400, ias: 8, durationS: 70, onGround: true, heading: rwy.headingTrue },
    { name: 'runup', rpm: 4000, ias: 0, durationS: 35, onGround: true },
    { name: 'lineup', rpm: 1900, ias: 0, durationS: 12, onGround: true },
  ];
}

function takeoff(rwy: RunwayEnd): Segment[] {
  return [
    { name: 'takeoff-roll', rpm: 5650, ias: 56, onGround: true, heading: rwy.headingTrue, until: { iasAboveKt: 51 }, maxDurationS: 40 },
    { name: 'initial-climb', rpm: 5650, ias: 75, vsi: 700, onGround: false, heading: rwy.headingTrue, until: { altAboveFt: rwy.elevFt + 400 }, maxDurationS: 90 },
  ];
}

function climbCruiseDescend(
  from: Airport,
  to: Airport,
  cruiseAltFt: number,
  opts: { cruiseRpm?: number; cruiseHoldS?: number } = {},
): Segment[] {
  return [
    { name: 'climb', rpm: 5450, ias: 75, altMsl: cruiseAltFt, vsi: 700, navTo: { lat: to.lat, lon: to.lon }, until: { altAboveFt: cruiseAltFt - 60 }, maxDurationS: 900 },
    ...(opts.cruiseHoldS
      ? [{ name: 'cruise-hold', rpm: opts.cruiseRpm ?? 5200, ias: 105, altMsl: cruiseAltFt, navTo: { lat: to.lat, lon: to.lon }, durationS: opts.cruiseHoldS } satisfies Segment]
      : []),
    { name: 'cruise', rpm: opts.cruiseRpm ?? 5200, ias: 105, altMsl: cruiseAltFt, navTo: { lat: to.lat, lon: to.lon }, until: { closerThan: { lat: to.lat, lon: to.lon, nm: 12 } }, maxDurationS: 3600 },
    { name: 'descent', rpm: 4600, ias: 95, altMsl: to.elevFt + 1200, vsi: 600, navTo: { lat: to.lat, lon: to.lon }, until: { closerThan: { lat: to.lat, lon: to.lon, nm: 4 } }, maxDurationS: 900 },
  ];
}

/** Point `distNm` out on the extended centerline of `rwy` (the approach side). */
function finalFix(rwy: RunwayEnd, distNm: number): { lat: number; lon: number } {
  return destinationPoint(rwy.thrLat, rwy.thrLon, (rwy.headingTrue + 180) % 360, distNm);
}

export interface FinalOptions {
  iasFinal?: number;
  iasShort?: number;
  touchdownG?: number;
  /** Slam-dunk: dive at `diveVsi` until `diveToAglFt`, then rejoin the glidepath fast. */
  unstable?: { diveVsi: number; diveToAglFt: number; fastIas: number };
  /** Break off the approach at this AGL and climb away instead of landing. */
  goAroundAtAglFt?: number;
}

/** From ~4 nm out on the approach side: intercept, fly final, land (or go around). */
function finalAndLand(rwy: RunwayEnd, opts: FinalOptions = {}): Segment[] {
  const faf = finalFix(rwy, 3.2);
  const glide = { thrLat: rwy.thrLat, thrLon: rwy.thrLon, thrElevFt: rwy.elevFt, angleDeg: 3.0 };
  const segs: Segment[] = [
    { name: 'intercept', navTo: faf, altMsl: rwy.elevFt + 1150, vsi: 500, ias: 75, rpm: 4400, groundElevFt: rwy.elevFt, until: { closerThan: { ...faf, nm: 0.35 } }, maxDurationS: 600 },
  ];
  if (opts.unstable) {
    segs.push(
      { name: 'final-dive', navTo: { lat: rwy.thrLat, lon: rwy.thrLon }, vsi: opts.unstable.diveVsi, ias: opts.unstable.fastIas, rpm: 3600, until: { altBelowFt: rwy.elevFt + opts.unstable.diveToAglFt }, maxDurationS: 240 },
      { name: 'final-fast', glide, ias: opts.unstable.fastIas, rpm: 4000, until: { altBelowFt: rwy.elevFt + 320 }, maxDurationS: 180 },
      { name: 'short-final', glide, ias: opts.iasShort ?? 62, rpm: 3600, until: { altBelowFt: rwy.elevFt + 15 }, maxDurationS: 120 },
    );
  } else if (opts.goAroundAtAglFt !== undefined) {
    segs.push(
      { name: 'final', glide, ias: opts.iasFinal ?? 61, rpm: 4000, until: { altBelowFt: rwy.elevFt + opts.goAroundAtAglFt }, maxDurationS: 400 },
      { name: 'go-around', rpm: 5650, ias: 70, vsi: 650, heading: rwy.headingTrue, until: { altAboveFt: rwy.elevFt + 800 }, maxDurationS: 180 },
    );
    return segs; // caller continues with a circuit
  } else {
    segs.push(
      { name: 'final', glide, ias: opts.iasFinal ?? 61, rpm: 4000, until: { altBelowFt: rwy.elevFt + 120 }, maxDurationS: 400 },
      { name: 'short-final', glide, ias: opts.iasShort ?? 58, rpm: 3400, until: { altBelowFt: rwy.elevFt + 15 }, maxDurationS: 120 },
    );
  }
  segs.push(
    { name: 'flare', vsi: -140, ias: 52, rpm: 2200, until: { altBelowFt: rwy.elevFt + 4 }, maxDurationS: 12 },
    { name: 'touchdown-roll', onGround: true, touchdownG: opts.touchdownG ?? 1.32, rpm: 1900, ias: 9, heading: rwy.headingTrue, until: { iasBelowKt: 10 }, maxDurationS: 60 },
  );
  return segs;
}

function taxiInAndShutdown(): Segment[] {
  return [
    { name: 'taxi-in', rpm: 2200, ias: 7, durationS: 55, onGround: true },
    { name: 'park', rpm: 1400, ias: 0, durationS: 25, onGround: true },
    { name: 'shutdown', rpm: 0, ias: 0, durationS: 20, onGround: true },
  ];
}

/**
 * Left-traffic circuit for `rwy`, starting from an established climb on runway
 * heading (~400 AGL) and ending back on final. Returns the pattern segments up
 * to (not including) the final approach.
 */
function patternToFinal(rwy: RunwayEnd): Segment[] {
  const elev = rwy.elevFt;
  const left = (rwy.headingTrue + 270) % 360; // left turn = -90°
  const downwind = (rwy.headingTrue + 180) % 360;
  const faf = finalFix(rwy, 2.0);
  return [
    { name: 'upwind', rpm: 5450, ias: 75, vsi: 700, heading: rwy.headingTrue, until: { altAboveFt: elev + 550 }, maxDurationS: 120 },
    { name: 'crosswind', rpm: 5450, ias: 80, altMsl: elev + 1000, vsi: 600, heading: left, durationS: 55 },
    { name: 'downwind', rpm: 4800, ias: 88, altMsl: elev + 1000, heading: downwind, until: { fartherThan: { lat: rwy.thrLat, lon: rwy.thrLon, nm: 2.1 } }, maxDurationS: 300 },
    // base flown as a nav leg to the turn-to-final fix — a fixed heading plus
    // turn displacement can miss the capture radius entirely
    { name: 'base', rpm: 4200, ias: 70, vsi: -400, navTo: faf, until: { closerThan: { ...faf, nm: 0.4 } }, maxDurationS: 240 },
  ];
}

function circuitFinal(rwy: RunwayEnd, touchAndGo: boolean, touchdownG = 1.3): Segment[] {
  const glide = { thrLat: rwy.thrLat, thrLon: rwy.thrLon, thrElevFt: rwy.elevFt, angleDeg: 3.2 };
  const segs: Segment[] = [
    { name: 'final', glide, ias: 61, rpm: 3900, until: { altBelowFt: rwy.elevFt + 15 }, maxDurationS: 300 },
    { name: 'flare', vsi: -140, ias: 53, rpm: 2200, until: { altBelowFt: rwy.elevFt + 4 }, maxDurationS: 12 },
  ];
  if (touchAndGo) {
    segs.push(
      { name: 'tng-roll', onGround: true, touchdownG, rpm: 2600, ias: 40, heading: rwy.headingTrue, until: { iasBelowKt: 42 }, maxDurationS: 20 },
      { name: 'tng-power', onGround: true, rpm: 5650, ias: 56, heading: rwy.headingTrue, until: { iasAboveKt: 51 }, maxDurationS: 25 },
      { name: 'tng-climb', rpm: 5650, ias: 75, vsi: 700, onGround: false, heading: rwy.headingTrue, until: { altAboveFt: rwy.elevFt + 400 }, maxDurationS: 90 },
    );
  } else {
    segs.push({ name: 'touchdown-roll', onGround: true, touchdownG, rpm: 1900, ias: 9, heading: rwy.headingTrue, until: { iasBelowKt: 10 }, maxDurationS: 60 });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioDef {
  startUtc: Date;
  wind: Wind;
  origin: Airport;
  originRunway: string;
  segments: Segment[];
  engineOverride?: EngineOverride;
  /** Split the sample stream into two files: [0, atS) and [atS+gapS, end). */
  split?: { atS: number; gapS: number };
}

function buildScenario(name: ScenarioName): ScenarioDef {
  switch (name) {
    case 'pattern-work': {
      // 3 circuits at KLOT 27: two touch-and-goes, then a full stop.
      const rwy = runwayEnd(AIRPORTS.KLOT!, '27');
      return {
        startUtc: new Date('2026-05-02T14:00:00Z'),
        wind: { fromDeg: 255, kt: 6 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        segments: [
          ...startupAndTaxi(rwy),
          ...takeoff(rwy),
          ...patternToFinal(rwy),
          ...circuitFinal(rwy, true, 1.35),
          ...patternToFinal(rwy),
          ...circuitFinal(rwy, true, 1.4),
          ...patternToFinal(rwy),
          ...circuitFinal(rwy, false, 1.3),
          ...taxiInAndShutdown(),
        ],
      };
    }
    case 'normal-xc': {
      // KLOT → KIKK, 3500 cruise, stable approach, zero events. This is the
      // false-positive regression guard.
      const dep = runwayEnd(AIRPORTS.KLOT!, '27');
      const arr = runwayEnd(AIRPORTS.KIKK!, '16');
      return {
        startUtc: new Date('2026-05-09T15:30:00Z'),
        wind: { fromDeg: 200, kt: 7 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        segments: [
          ...startupAndTaxi(dep),
          ...takeoff(dep),
          ...climbCruiseDescend(AIRPORTS.KLOT!, AIRPORTS.KIKK!, 3500),
          ...finalAndLand(arr, { touchdownG: 1.28 }),
          ...taxiInAndShutdown(),
        ],
      };
    }
    case 'go-around': {
      const rwy = runwayEnd(AIRPORTS.KLOT!, '27');
      return {
        startUtc: new Date('2026-05-16T13:00:00Z'),
        wind: { fromDeg: 260, kt: 8 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        segments: [
          ...startupAndTaxi(rwy),
          ...takeoff(rwy),
          { name: 'climbout', rpm: 5450, ias: 75, altMsl: rwy.elevFt + 1400, vsi: 700, heading: rwy.headingTrue, until: { altAboveFt: rwy.elevFt + 1350 }, maxDurationS: 240 },
          { name: 'depart-east', rpm: 5000, ias: 95, altMsl: rwy.elevFt + 1400, heading: 90, durationS: 240 },
          ...finalAndLand(rwy, { goAroundAtAglFt: 300 }),
          ...patternToFinal(rwy),
          ...circuitFinal(rwy, false, 1.33),
          ...taxiInAndShutdown(),
        ],
      };
    }
    case 'power-interruption': {
      // Same profile as normal-xc but the G3X reboots mid-cruise: one flight
      // split across two files with a 45 s recording gap.
      const dep = runwayEnd(AIRPORTS.KLOT!, '27');
      const arr = runwayEnd(AIRPORTS.KIKK!, '16');
      return {
        startUtc: new Date('2026-05-23T16:00:00Z'),
        wind: { fromDeg: 220, kt: 5 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        split: { atS: 900, gapS: 45 },
        segments: [
          ...startupAndTaxi(dep),
          ...takeoff(dep),
          ...climbCruiseDescend(AIRPORTS.KLOT!, AIRPORTS.KIKK!, 3500),
          ...finalAndLand(arr, { touchdownG: 1.3 }),
          ...taxiInAndShutdown(),
        ],
      };
    }
    case 'unstable-approach': {
      // Slam-dunk final: -1150 fpm through 1000 AGL, 15 kt fast through the
      // 500 AGL gate, firm touchdown.
      const dep = runwayEnd(AIRPORTS.KLOT!, '27');
      const arr = runwayEnd(AIRPORTS.KIKK!, '16');
      return {
        startUtc: new Date('2026-06-06T14:30:00Z'),
        wind: { fromDeg: 180, kt: 6 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        segments: [
          ...startupAndTaxi(dep),
          ...takeoff(dep),
          ...climbCruiseDescend(AIRPORTS.KLOT!, AIRPORTS.KIKK!, 3500),
          ...finalAndLand(arr, {
            unstable: { diveVsi: -1150, diveToAglFt: 480, fastIas: 76 },
            iasShort: 64,
            touchdownG: 2.15,
          }),
          ...taxiInAndShutdown(),
        ],
      };
    }
    case 'engine-exceedance': {
      // Local flight: coolant excursion to ~123 °C in the climb (≥90 s over
      // the 120 °C limit) and 5560 RPM held past the 5-minute limit in cruise.
      const rwy = runwayEnd(AIRPORTS.KLOT!, '27');
      const coolantOverride: EngineOverride = (elapsedS, targets) => {
        if (elapsedS > 260 && elapsedS < 590) return { ...targets, coolantC: 123.5 };
        return targets;
      };
      return {
        startUtc: new Date('2026-06-13T15:00:00Z'),
        wind: { fromDeg: 270, kt: 4 },
        origin: AIRPORTS.KLOT!,
        originRunway: '27',
        engineOverride: coolantOverride,
        segments: [
          ...startupAndTaxi(rwy),
          ...takeoff(rwy),
          { name: 'climb', rpm: 5450, ias: 75, altMsl: rwy.elevFt + 1900, vsi: 650, heading: 300, until: { altAboveFt: rwy.elevFt + 1850 }, maxDurationS: 400 },
          { name: 'cruise-fast', rpm: 5560, ias: 108, altMsl: rwy.elevFt + 1900, heading: 320, durationS: 360 },
          { name: 'cruise-back', rpm: 5100, ias: 100, altMsl: rwy.elevFt + 1400, navTo: finalFix(rwy, 3.2), until: { closerThan: { ...finalFix(rwy, 3.2), nm: 1.2 } }, maxDurationS: 900 },
          ...finalAndLand(rwy, { touchdownG: 1.34 }),
          ...taxiInAndShutdown(),
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------

export function simulateScenario(name: ScenarioName, seed = 42): SimSample[] {
  const def = buildScenario(name);
  const rwy = runwayEnd(def.origin, def.originRunway);
  const config: SimConfig = {
    startUtc: def.startUtc,
    utcOffsetMin: UTC_OFFSET_MIN,
    lat: rwy.thrLat,
    lon: rwy.thrLon,
    elevFt: rwy.elevFt,
    heading: rwy.headingTrue,
    wind: def.wind,
    rand: mulberry32(seed),
    engineOverride: def.engineOverride,
  };
  return runSim(config, def.segments);
}

export function generateScenario(name: ScenarioName, opts: GenerateOptions = {}): GeneratedScenario {
  const seed = opts.seed ?? 42;
  const def = buildScenario(name);
  const samples = simulateScenario(name, seed);
  const writerRand = mulberry32(seed ^ 0x5f3759df);
  const chunks: SimSample[][] = [];
  if (def.split) {
    const startMs = samples[0]!.t.getTime();
    const splitMs = startMs + def.split.atS * 1000;
    const resumeMs = splitMs + def.split.gapS * 1000;
    chunks.push(
      samples.filter((s) => s.t.getTime() < splitMs),
      samples.filter((s) => s.t.getTime() >= resumeMs),
    );
  } else {
    chunks.push(samples);
  }
  const files = chunks.map((chunk) => ({
    name: g3xFileName(chunk[0]!.t, UTC_OFFSET_MIN, def.origin.ident),
    csv: writeG3xCsv(chunk, {
      utcOffsetMin: UTC_OFFSET_MIN,
      garbageRate: opts.garbageRate ?? 0,
      rand: writerRand,
    }),
  }));
  return { scenario: name, seed, files };
}
