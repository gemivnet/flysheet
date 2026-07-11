import type { AircraftConfig, PhaseName } from '@foqa/shared';
import { channel, type FlightChannels } from './channels.js';

/**
 * Deterministic two-pass phase detection.
 *
 * Pass 1 computes debounced per-sample predicates (onGround, climbing,
 * descending, movement). Pass 2 runs a transition table over them. All
 * thresholds come from aircraft.yaml.
 *
 * Invariants (asserted by tests): phases are contiguous, non-overlapping and
 * cover the whole sample range; a go-around never produces a landing for the
 * same approach; a touch-and-go produces rollout → takeoff with ground time
 * under `touchngo_max_ground_s`.
 */

export interface PhaseSpan {
  phase: PhaseName;
  startIdx: number;
  endIdx: number; // inclusive
  details: Record<string, unknown>;
}

export interface PhaseResult {
  phases: PhaseSpan[];
  /** Sample indices of air→ground transitions. */
  touchdowns: number[];
  /** Sample indices of ground→air transitions. */
  liftoffs: number[];
}

/** Debounce a boolean series: state flips only after `n` consecutive opposites. */
function debounce(raw: boolean[], n: number, initial: boolean): boolean[] {
  const out = new Array<boolean>(raw.length);
  let state = initial;
  let run = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === state) {
      run = 0;
    } else {
      run++;
      if (run >= n) {
        state = raw[i]!;
        run = 0;
      }
    }
    out[i] = state;
  }
  return out;
}

export function detectPhases(
  ch: FlightChannels,
  aircraft: AircraftConfig,
  /** Distance to nearest airport per sample (nm); null = unknown → lenient. */
  airportDistNm?: (number | null)[],
): PhaseResult {
  const n = ch.ts.length;
  const p = aircraft.phases;
  const agl = channel(ch, 'agl_ft');
  const vsi = channel(ch, 'vsi_fpm');
  const gs = channel(ch, 'gs_kt');
  const rpm = channel(ch, 'rpm');

  // ---- pass 1: debounced predicates ----
  const groundRaw = new Array<boolean>(n);
  const climbRaw = new Array<boolean>(n);
  const descendRaw = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const a = agl[i];
    const v = vsi[i] ?? 0;
    groundRaw[i] = (a === null ? true : a < p.ground_agl_ft) && Math.abs(v) < p.ground_vsi_fpm;
    climbRaw[i] = v > p.climb_vsi_fpm;
    descendRaw[i] = v < p.descent_vsi_fpm;
  }
  const onGround = debounce(groundRaw, p.ground_debounce_s, true);
  const climbing = debounce(climbRaw, p.vsi_debounce_s, false);
  const descending = debounce(descendRaw, p.vsi_debounce_s, false);

  const touchdowns: number[] = [];
  const liftoffs: number[] = [];
  for (let i = 1; i < n; i++) {
    if (onGround[i - 1] && !onGround[i]) liftoffs.push(i);
    if (!onGround[i - 1] && onGround[i]) touchdowns.push(i);
  }

  // rpm jump over the trailing window (go-around power application)
  const rpmJump = new Array<boolean>(n).fill(false);
  const w = p.goaround_rpm_window_s;
  for (let i = 1; i < n; i++) {
    let min = rpm[i] ?? 0;
    for (let j = Math.max(0, i - w); j < i; j++) min = Math.min(min, rpm[j] ?? 0);
    rpmJump[i] = (rpm[i] ?? 0) - min > p.goaround_rpm_jump;
  }

  const nearAirport = (i: number): boolean => {
    const d = airportDistNm?.[i];
    return d === null || d === undefined || d < p.approach_airport_dist_nm;
  };
  const moving = (i: number): boolean => (gs[i] ?? 0) > p.moving_gs_kt;
  const takeoffPower = (i: number): boolean => (rpm[i] ?? 0) > p.takeoff_rpm;

  // ---- pass 2: transition table ----
  const phases: PhaseSpan[] = [];
  let current: PhaseName = 'preflight';
  let startIdx = 0;
  let touchdownThisApproach = false;
  let circuit = 0;

  const emit = (endIdx: number, next: PhaseName, details: Record<string, unknown> = {}): void => {
    if (endIdx >= startIdx) phases.push({ phase: current, startIdx, endIdx, details });
    current = next;
    startIdx = endIdx + 1;
  };

  for (let i = 0; i < n; i++) {
    const grounded = onGround[i]!;
    switch (current) {
      case 'preflight':
        if (moving(i) && takeoffPower(i)) {
          circuit++;
          emit(i - 1, 'takeoff', {});
        } else if (moving(i)) emit(i - 1, 'taxi');
        break;
      case 'taxi':
        if (takeoffPower(i) && moving(i)) {
          circuit++;
          emit(i - 1, 'takeoff');
        } else if (!moving(i) && (rpm[i] ?? 0) < 200) emit(i - 1, 'postflight');
        break;
      case 'takeoff':
        if (!grounded && (agl[i] ?? 0) > 100) emit(i - 1, 'climb');
        else if (grounded && !takeoffPower(i) && !moving(i)) emit(i - 1, 'taxi'); // rejected
        break;
      case 'climb':
        if (descending[i] && (agl[i] ?? Infinity) < p.approach_agl_ft && nearAirport(i)) {
          touchdownThisApproach = false;
          emit(i - 1, 'approach');
        } else if (descending[i]) emit(i - 1, 'descent');
        else if (!climbing[i]) emit(i - 1, 'cruise');
        break;
      case 'cruise':
        if (descending[i] && (agl[i] ?? Infinity) < p.approach_agl_ft && nearAirport(i)) {
          touchdownThisApproach = false;
          emit(i - 1, 'approach');
        } else if (descending[i]) emit(i - 1, 'descent');
        else if (climbing[i]) emit(i - 1, 'climb');
        break;
      case 'descent':
        if ((agl[i] ?? Infinity) < p.approach_agl_ft && nearAirport(i)) {
          touchdownThisApproach = false;
          emit(i - 1, 'approach');
        } else if (climbing[i]) emit(i - 1, 'climb');
        else if (!descending[i]) emit(i - 1, 'cruise');
        break;
      case 'approach':
        if (grounded) {
          touchdownThisApproach = true;
          emit(i - 1, 'landing');
        } else if ((agl[i] ?? Infinity) < p.landing_agl_ft) {
          emit(i - 1, 'landing');
        } else if (
          !touchdownThisApproach &&
          (agl[i] ?? Infinity) < p.goaround_max_agl_ft &&
          (vsi[i] ?? 0) > p.goaround_vsi_fpm &&
          rpmJump[i]
        ) {
          emit(i - 1, 'go_around');
        } else if (climbing[i] && (agl[i] ?? 0) > p.goaround_max_agl_ft) {
          // climbed back out of the approach window without a go-around signature
          emit(i - 1, 'climb');
        }
        break;
      case 'go_around':
        if ((agl[i] ?? 0) > p.goaround_max_agl_ft || (!climbing[i] && (agl[i] ?? 0) > 400)) {
          emit(i - 1, 'climb');
        }
        break;
      case 'landing':
        // short final below the landing gate; hands over to rollout at touchdown
        if (grounded) {
          touchdownThisApproach = true;
          emit(i, 'rollout');
        }
        break;
      case 'rollout':
        if (takeoffPower(i) && moving(i)) {
          // touch-and-go
          circuit++;
          emit(i - 1, 'takeoff', {});
        } else if (!moving(i)) emit(i - 1, 'taxi');
        break;
      case 'postflight':
        if (moving(i)) emit(i - 1, 'taxi'); // engine restarted / pushed again
        break;
    }
  }
  emit(n - 1, current);

  // annotate takeoffs with circuit numbers
  let c = 0;
  for (const span of phases) {
    if (span.phase === 'takeoff') span.details.circuit = ++c;
  }
  void circuit;

  return { phases: phases.filter((s) => s.endIdx >= s.startIdx), touchdowns, liftoffs };
}
