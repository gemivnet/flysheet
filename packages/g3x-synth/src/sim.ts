import { bearingDeg, destinationPoint, haversineNm, noise } from '@foqa/shared';
import {
  initialEngineState,
  stepEngine,
  type EngineOverride,
  type EngineState,
} from './engine.js';

/**
 * Segment-scripted point-mass simulator, integrated at 1 Hz. Each segment
 * slews the state toward its targets at realistic RV-12 rates and ends on
 * duration and/or a predicate over the state.
 */

export interface Wind {
  fromDeg: number;
  kt: number;
}

export interface SimSample {
  t: Date;
  lat: number;
  lon: number;
  altMslFt: number;
  altGpsFt: number;
  iasKt: number;
  tasKt: number;
  gsKt: number;
  vsiFpm: number;
  pitchDeg: number;
  rollDeg: number;
  hdgDeg: number;
  trkDeg: number;
  normG: number;
  latG: number;
  rpm: number;
  oilTempC: number;
  oilPressPsi: number;
  coolantC: number;
  egtC: [number, number, number, number];
  fuelFlowGph: number;
  fuelQtyGal: number;
  volts: number;
  amps: number;
  oatC: number;
  onGround: boolean;
  segment: string;
}

export interface Until {
  altAboveFt?: number;
  altBelowFt?: number;
  iasAboveKt?: number;
  iasBelowKt?: number;
  /** True when within `nm` of the point. */
  closerThan?: { lat: number; lon: number; nm: number };
  /** True when farther than `nm` from the point. */
  fartherThan?: { lat: number; lon: number; nm: number };
}

export interface Segment {
  name: string;
  /** Slew targets; omitted values hold their current state. */
  ias?: number;
  vsi?: number;
  altMsl?: number; // when set, vsi is derived (capped by `vsi` magnitude, default 700)
  heading?: number;
  rpm?: number;
  /** Steer toward a point; overrides `heading`. */
  navTo?: { lat: number; lon: number };
  /** Fly a glidepath toward a threshold; overrides vsi/altMsl. */
  glide?: { thrLat: number; thrLon: number; thrElevFt: number; angleDeg: number };
  onGround?: boolean;
  groundElevFt?: number;
  /** Inject a touchdown normal-G spike on the first sample of this segment. */
  touchdownG?: number;
  durationS?: number;
  until?: Until;
  maxDurationS?: number;
}

export interface SimConfig {
  startUtc: Date;
  utcOffsetMin: number;
  lat: number;
  lon: number;
  elevFt: number;
  heading: number;
  wind: Wind;
  rand: () => number;
  fuelGal?: number;
  engineOverride?: EngineOverride;
}

const IAS_SLEW = 1.5; // kt/s
const VSI_SLEW = 250; // fpm/s
const TURN_RATE = 3; // deg/s (standard rate)
const RPM_SLEW = 500; // rpm/s

function slew(current: number, target: number, rate: number, dt: number): number {
  const delta = target - current;
  const max = rate * dt;
  return Math.abs(delta) <= max ? target : current + Math.sign(delta) * max;
}

function slewHeading(current: number, target: number, rate: number, dt: number): number {
  let delta = ((target - current + 540) % 360) - 180;
  const max = rate * dt;
  if (Math.abs(delta) > max) delta = Math.sign(delta) * max;
  return (current + delta + 360) % 360;
}

interface MutableState {
  t: number; // epoch ms
  lat: number;
  lon: number;
  altMsl: number;
  ias: number;
  vsi: number;
  heading: number;
  rpm: number;
  roll: number;
  onGround: boolean;
  groundElev: number;
  fuelGal: number;
  engine: EngineState;
  elapsedS: number;
}

function untilMet(u: Until, s: MutableState): boolean {
  if (u.altAboveFt !== undefined && !(s.altMsl > u.altAboveFt)) return false;
  if (u.altBelowFt !== undefined && !(s.altMsl < u.altBelowFt)) return false;
  if (u.iasAboveKt !== undefined && !(s.ias > u.iasAboveKt)) return false;
  if (u.iasBelowKt !== undefined && !(s.ias < u.iasBelowKt)) return false;
  if (u.closerThan && !(haversineNm(s.lat, s.lon, u.closerThan.lat, u.closerThan.lon) < u.closerThan.nm))
    return false;
  if (
    u.fartherThan &&
    !(haversineNm(s.lat, s.lon, u.fartherThan.lat, u.fartherThan.lon) > u.fartherThan.nm)
  )
    return false;
  return true;
}

export function runSim(config: SimConfig, segments: Segment[]): SimSample[] {
  const { rand, wind } = config;
  const oatGround = 15;
  const samples: SimSample[] = [];
  const s: MutableState = {
    t: config.startUtc.getTime(),
    lat: config.lat,
    lon: config.lon,
    altMsl: config.elevFt,
    ias: 0,
    vsi: 0,
    heading: config.heading,
    rpm: 0,
    roll: 0,
    onGround: true,
    groundElev: config.elevFt,
    fuelGal: config.fuelGal ?? 18,
    engine: initialEngineState(oatGround),
    elapsedS: 0,
  };
  const dt = 1;

  for (const seg of segments) {
    const started = s.elapsedS;
    const maxDur = seg.maxDurationS ?? seg.durationS ?? 1800;
    let first = true;
    for (;;) {
      const segElapsed = s.elapsedS - started;
      if (seg.durationS !== undefined && segElapsed >= seg.durationS) break;
      if (seg.until && segElapsed > 0 && untilMet(seg.until, s)) break;
      if (segElapsed >= maxDur) break;

      if (seg.onGround !== undefined) s.onGround = seg.onGround;
      if (seg.groundElevFt !== undefined) s.groundElev = seg.groundElevFt;

      // --- heading ---
      let tgtHeading = seg.heading ?? s.heading;
      if (seg.navTo) tgtHeading = bearingDeg(s.lat, s.lon, seg.navTo.lat, seg.navTo.lon);
      if (seg.glide) tgtHeading = bearingDeg(s.lat, s.lon, seg.glide.thrLat, seg.glide.thrLon);
      const prevHeading = s.heading;
      s.heading = s.onGround
        ? slewHeading(s.heading, seg.heading ?? s.heading, 5, dt)
        : slewHeading(s.heading, tgtHeading, TURN_RATE, dt);
      const turnRate = ((s.heading - prevHeading + 540) % 360) - 180;
      const tgtRoll = s.onGround ? 0 : Math.max(-30, Math.min(30, turnRate * 7));
      s.roll = slew(s.roll, tgtRoll + (s.onGround ? 0 : noise(rand, 0.4)), 8, dt);

      // --- speed / power ---
      if (seg.rpm !== undefined) s.rpm = slew(s.rpm, seg.rpm, RPM_SLEW, dt);
      if (seg.ias !== undefined) s.ias = slew(s.ias, seg.ias, IAS_SLEW, dt);

      // --- vertical ---
      let tgtVsi = 0;
      if (seg.glide && !s.onGround) {
        const g = seg.glide;
        const distNm = haversineNm(s.lat, s.lon, g.thrLat, g.thrLon);
        const angleRad = (g.angleDeg * Math.PI) / 180;
        const targetAlt = g.thrElevFt + Math.tan(angleRad) * distNm * 6076.12;
        // feed-forward the on-path descent rate, correct toward the path
        const ff = -s.ias * 101.27 * Math.tan(angleRad);
        tgtVsi = Math.max(-1300, Math.min(200, ff + (targetAlt - s.altMsl) * 0.8));
      } else if (seg.altMsl !== undefined) {
        const err = seg.altMsl - s.altMsl;
        const cap = Math.abs(seg.vsi ?? 700);
        tgtVsi = Math.max(-cap, Math.min(cap, err * 0.4));
      } else if (seg.vsi !== undefined) {
        tgtVsi = seg.vsi;
      }
      if (s.onGround) tgtVsi = 0;
      s.vsi = slew(s.vsi, tgtVsi, VSI_SLEW, dt);
      s.altMsl += (s.vsi / 60) * dt;
      if (s.onGround) {
        s.altMsl = s.groundElev;
        s.vsi = 0;
      } else if (s.altMsl < s.groundElev) {
        s.altMsl = s.groundElev;
      }

      // --- position ---
      const oat = oatGround - (2 * (s.altMsl - config.elevFt)) / 1000;
      const tas = s.ias * (1 + (0.015 * s.altMsl) / 1000);
      let gs: number;
      let track: number;
      if (s.onGround) {
        gs = s.ias; // close enough while rolling
        track = s.heading;
      } else {
        const hdgRad = (s.heading * Math.PI) / 180;
        const windToRad = ((wind.fromDeg + 180) * Math.PI) / 180;
        const vn = tas * Math.cos(hdgRad) + wind.kt * Math.cos(windToRad);
        const ve = tas * Math.sin(hdgRad) + wind.kt * Math.sin(windToRad);
        gs = Math.hypot(vn, ve);
        track = ((Math.atan2(ve, vn) * 180) / Math.PI + 360) % 360;
      }
      if (gs > 0.05) {
        const moved = destinationPoint(s.lat, s.lon, track, (gs / 3600) * dt);
        s.lat = moved.lat;
        s.lon = moved.lon;
      }

      // --- engine / systems ---
      s.engine = stepEngine(s.engine, s.rpm, s.elapsedS, dt, rand, config.engineOverride);
      s.fuelGal = Math.max(0, s.fuelGal - (s.engine.fuelFlowGph / 3600) * dt);

      const pitch =
        s.onGround && s.ias < 45
          ? 0.5
          : Math.max(-8, Math.min(15, s.vsi / 150 + (s.ias > 0 ? 900 / Math.max(s.ias, 45) - 12 : 0)));
      const rollRad = (s.roll * Math.PI) / 180;
      let normG = (s.onGround ? 1 : 1 / Math.max(0.5, Math.cos(rollRad))) + noise(rand, 0.02);
      if (first && seg.touchdownG !== undefined) normG = seg.touchdownG + noise(rand, 0.05);

      samples.push({
        t: new Date(s.t),
        lat: s.lat + noise(rand, 0.5e-6),
        lon: s.lon + noise(rand, 0.5e-6),
        altMslFt: s.altMsl + noise(rand, 1.5),
        altGpsFt: s.altMsl + 85 + noise(rand, 6),
        iasKt: Math.max(0, s.ias + (s.ias > 15 ? noise(rand, 0.3) : 0)),
        tasKt: Math.max(0, tas + noise(rand, 0.3)),
        gsKt: Math.max(0, gs + noise(rand, 0.2)),
        vsiFpm: s.vsi + noise(rand, s.onGround ? 4 : 15),
        pitchDeg: pitch + noise(rand, 0.2),
        rollDeg: s.roll + noise(rand, 0.2),
        hdgDeg: (s.heading + noise(rand, 0.3) + 360) % 360,
        trkDeg: (track + noise(rand, 0.3) + 360) % 360,
        normG,
        latG: noise(rand, 0.015),
        rpm: Math.max(0, s.rpm + (s.rpm > 500 ? noise(rand, 12) : 0)),
        oilTempC: s.engine.oilTempC,
        oilPressPsi: s.engine.oilPressPsi,
        coolantC: s.engine.coolantC,
        egtC: s.engine.egtC,
        fuelFlowGph: s.engine.fuelFlowGph,
        fuelQtyGal: s.fuelGal,
        volts: s.rpm > 1000 ? 13.9 + noise(rand, 0.05) : 12.4 + noise(rand, 0.05),
        amps: s.rpm > 1000 ? 9 + noise(rand, 0.4) : -2 + noise(rand, 0.2),
        oatC: oat + noise(rand, 0.1),
        onGround: s.onGround,
        segment: seg.name,
      });

      s.t += dt * 1000;
      s.elapsedS += dt;
      first = false;
    }
  }
  return samples;
}
