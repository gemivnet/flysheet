import { AIRPORTS, type SimSample } from '@foqa/g3x-synth';
import { haversineNm } from '@foqa/shared';
import type { FlightChannels } from '../../src/analyze/channels.js';

/**
 * Build analyzer channels straight from simulator output (bypassing DB and
 * terrain enrichment): agl_ft is computed against the nearest scenario
 * airport's elevation, mirroring what HGT enrichment produces over the flat
 * synthetic terrain.
 */
export function simChannels(samples: SimSample[]): {
  ch: FlightChannels;
  airportDistNm: number[];
} {
  const airports = Object.values(AIRPORTS);
  const n = samples.length;
  const ch: FlightChannels = {
    ts: samples.map((s) => s.t),
    v: {
      lat: samples.map((s) => s.lat),
      lon: samples.map((s) => s.lon),
      alt_msl_ft: samples.map((s) => s.altMslFt),
      ias_kt: samples.map((s) => s.iasKt),
      gs_kt: samples.map((s) => s.gsKt),
      vsi_fpm: samples.map((s) => s.vsiFpm),
      rpm: samples.map((s) => s.rpm),
      roll_deg: samples.map((s) => s.rollDeg),
      norm_g: samples.map((s) => s.normG),
      oil_temp_c: samples.map((s) => s.oilTempC),
      oil_press_psi: samples.map((s) => s.oilPressPsi),
      coolant_temp_c: samples.map((s) => s.coolantC),
      agl_ft: new Array<number | null>(n).fill(null),
      egt_spread_c: samples.map(
        (s) => Math.max(...s.egtC) - Math.min(...s.egtC),
      ),
    },
  };
  const airportDistNm: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    let best = Infinity;
    let bestElev = 0;
    for (const apt of airports) {
      const d = haversineNm(s.lat, s.lon, apt.lat, apt.lon);
      if (d < best) {
        best = d;
        bestElev = apt.elevFt;
      }
    }
    airportDistNm[i] = best;
    ch.v.agl_ft![i] = Math.max(0, s.altMslFt - bestElev);
  }
  return { ch, airportDistNm };
}
