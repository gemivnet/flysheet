import { noise } from '@foqa/shared';

/**
 * Rotax 912iS thermal/fuel model: first-order lags toward RPM-derived targets.
 * Time constants: coolant ~90 s, oil temp ~180 s, EGT ~20 s, oil pressure ~5 s.
 */

export interface EngineState {
  coolantC: number;
  oilTempC: number;
  oilPressPsi: number;
  egtC: [number, number, number, number];
  fuelFlowGph: number;
}

export interface EngineTargets {
  coolantC: number;
  oilTempC: number;
  oilPressPsi: number;
  egtC: number;
  fuelFlowGph: number;
}

/** Scenario hook: mutate the computed targets (e.g. force a coolant excursion). */
export type EngineOverride = (elapsedS: number, targets: EngineTargets) => EngineTargets;

const EGT_CYL_OFFSET_C: [number, number, number, number] = [0, -14, 9, -6];

export function initialEngineState(oatC: number): EngineState {
  return {
    coolantC: oatC + 5,
    oilTempC: oatC + 5,
    oilPressPsi: 0,
    egtC: [oatC, oatC, oatC, oatC],
    fuelFlowGph: 0,
  };
}

export function engineTargets(rpm: number): EngineTargets {
  const power = Math.max(0, Math.min(1, rpm / 5500)); // crude fraction of max
  if (rpm < 100) {
    // engine stopped
    return { coolantC: 20, oilTempC: 20, oilPressPsi: 0, egtC: 20, fuelFlowGph: 0 };
  }
  return {
    coolantC: 62 + power * 52, // ~95 taxi, ~109 climb/cruise, limit 120
    oilTempC: 60 + power * 45, // ~102 at max continuous, limit 130
    oilPressPsi: rpm < 2000 ? 32 : 42 + power * 16, // 22–73 psi normal band
    egtC: 480 + power * 330, // ~810 °C in cruise
    fuelFlowGph: 0.6 + power * 4.9,
  };
}

function lag(current: number, target: number, tauS: number, dtS: number): number {
  const k = 1 - Math.exp(-dtS / tauS);
  return current + (target - current) * k;
}

export function stepEngine(
  state: EngineState,
  rpm: number,
  elapsedS: number,
  dtS: number,
  rand: () => number,
  override?: EngineOverride,
): EngineState {
  let targets = engineTargets(rpm);
  if (override) targets = override(elapsedS, targets);
  const egt: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const cylTarget = targets.egtC + EGT_CYL_OFFSET_C[i]! + noise(rand, 2);
    egt[i] = lag(state.egtC[i]!, cylTarget, 20, dtS);
  }
  return {
    coolantC: lag(state.coolantC, targets.coolantC + noise(rand, 0.3), 90, dtS),
    oilTempC: lag(state.oilTempC, targets.oilTempC + noise(rand, 0.3), 180, dtS),
    oilPressPsi: lag(state.oilPressPsi, targets.oilPressPsi + noise(rand, 0.4), 5, dtS),
    egtC: egt,
    fuelFlowGph: lag(state.fuelFlowGph, targets.fuelFlowGph + noise(rand, 0.05), 8, dtS),
  };
}
