/**
 * Columnar view of one flight's time series — the working format for
 * enrichment, phase detection and rule evaluation. `v` holds canonical
 * parameter arrays (samples table) plus derived channels once enrichment has
 * run. Timestamps are 1 Hz but may contain gaps (stitched flights).
 */
export interface FlightChannels {
  ts: Date[];
  v: Record<string, (number | null)[]>;
}

export function channel(ch: FlightChannels, name: string): (number | null)[] {
  return ch.v[name] ?? new Array<number | null>(ch.ts.length).fill(null);
}

/** Seconds between consecutive samples (usually 1; larger across stitch gaps). */
export function dtSeconds(ch: FlightChannels, i: number): number {
  if (i <= 0) return 1;
  return (ch.ts[i]!.getTime() - ch.ts[i - 1]!.getTime()) / 1000;
}
