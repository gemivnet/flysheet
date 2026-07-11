import { describe, expect, it } from 'vitest';
import { simulateScenario, type ScenarioName } from '@foqa/g3x-synth';
import { loadConfig } from '../src/config.js';
import { detectPhases, type PhaseResult } from '../src/analyze/phases.js';
import { simChannels } from './helpers/simChannels.js';

const { aircraft } = loadConfig();

function run(name: ScenarioName): PhaseResult & { n: number } {
  const samples = simulateScenario(name, 42);
  const { ch, airportDistNm } = simChannels(samples);
  return { ...detectPhases(ch, aircraft, airportDistNm), n: samples.length };
}

function count(r: PhaseResult, phase: string): number {
  return r.phases.filter((p) => p.phase === phase).length;
}

function assertInvariants(r: PhaseResult & { n: number }): void {
  expect(r.phases[0]!.startIdx).toBe(0);
  expect(r.phases.at(-1)!.endIdx).toBe(r.n - 1);
  for (let i = 1; i < r.phases.length; i++) {
    expect(r.phases[i]!.startIdx).toBe(r.phases[i - 1]!.endIdx + 1);
  }
  for (const p of r.phases) expect(p.endIdx).toBeGreaterThanOrEqual(p.startIdx);
}

describe('detectPhases', () => {
  it('pattern-work: 3 takeoffs, 3 landings/rollouts, 3 approaches, no go-around', () => {
    const r = run('pattern-work');
    assertInvariants(r);
    expect(count(r, 'takeoff')).toBe(3);
    expect(count(r, 'landing')).toBe(3);
    expect(count(r, 'rollout')).toBe(3);
    expect(count(r, 'approach')).toBe(3);
    expect(count(r, 'go_around')).toBe(0);
    expect(r.phases[0]!.phase).toBe('preflight');
    expect(r.phases.at(-1)!.phase).toBe('postflight');
    expect(r.touchdowns).toHaveLength(3);
    expect(r.liftoffs).toHaveLength(3);
    // takeoffs carry circuit numbers
    const circuits = r.phases.filter((p) => p.phase === 'takeoff').map((p) => p.details.circuit);
    expect(circuits).toEqual([1, 2, 3]);
  });

  it('pattern-work: touch-and-go rollouts are shorter than the T&G ground limit', () => {
    const r = run('pattern-work');
    const rollouts = r.phases.filter((p) => p.phase === 'rollout');
    // first two rollouts are the touch-and-goes
    for (const ro of rollouts.slice(0, 2)) {
      expect(ro.endIdx - ro.startIdx).toBeLessThan(aircraft.phases.touchngo_max_ground_s);
    }
  });

  it('go-around: exactly one go_around, never a landing for that approach', () => {
    const r = run('go-around');
    assertInvariants(r);
    expect(count(r, 'go_around')).toBe(1);
    expect(count(r, 'landing')).toBe(1);
    expect(count(r, 'approach')).toBe(2);
    expect(count(r, 'takeoff')).toBe(1);
    // the go_around phase follows an approach directly
    const gaIdx = r.phases.findIndex((p) => p.phase === 'go_around');
    expect(r.phases[gaIdx - 1]!.phase).toBe('approach');
    // and no touchdown happened during or before that approach's window
    const ga = r.phases[gaIdx]!;
    for (const td of r.touchdowns) expect(td).toBeGreaterThan(ga.endIdx);
  });

  it('normal-xc: clean single-leg sequence', () => {
    const r = run('normal-xc');
    assertInvariants(r);
    expect(count(r, 'takeoff')).toBe(1);
    expect(count(r, 'approach')).toBe(1);
    expect(count(r, 'landing')).toBe(1);
    expect(count(r, 'go_around')).toBe(0);
    expect(count(r, 'cruise')).toBeGreaterThanOrEqual(1);
    expect(count(r, 'descent')).toBeGreaterThanOrEqual(1);
    const names = r.phases.map((p) => p.phase);
    // core ordering
    const order = ['preflight', 'taxi', 'takeoff', 'climb', 'cruise'];
    let last = -1;
    for (const ph of order) {
      const idx = names.indexOf(ph as (typeof names)[number]);
      expect(idx, `phase ${ph} present in order`).toBeGreaterThan(last);
      last = idx;
    }
    expect(names.at(-1)).toBe('postflight');
  });

  it('power-interruption: stitched gap does not break phase contiguity', () => {
    const samples = simulateScenario('power-interruption', 42);
    const { ch, airportDistNm } = simChannels(samples);
    // simulate the 45 s recording gap the two files produce
    const startMs = samples[0]!.t.getTime();
    const keep = samples
      .map((_, i) => i)
      .filter((i) => {
        const dt = (samples[i]!.t.getTime() - startMs) / 1000;
        return dt < 900 || dt >= 945;
      });
    const gapped = {
      ts: keep.map((i) => ch.ts[i]!),
      v: Object.fromEntries(Object.entries(ch.v).map(([k, arr]) => [k, keep.map((i) => arr[i]!)])),
    };
    const r = { ...detectPhases(gapped, aircraft, keep.map((i) => airportDistNm[i]!)), n: keep.length };
    assertInvariants(r);
    expect(count(r, 'takeoff')).toBe(1);
    expect(count(r, 'landing')).toBe(1);
    expect(count(r, 'go_around')).toBe(0);
  });

  it('unstable-approach and engine-exceedance still classify as normal flights', () => {
    for (const name of ['unstable-approach', 'engine-exceedance'] as const) {
      const r = run(name);
      assertInvariants(r);
      expect(count(r, 'takeoff'), name).toBe(1);
      expect(count(r, 'landing'), name).toBe(1);
      expect(count(r, 'go_around'), name).toBe(0);
    }
  });
});
