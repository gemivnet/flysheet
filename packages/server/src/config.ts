import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAircraftConfig,
  loadParameterMap,
  loadRuleset,
  mergeRulesets,
  type AircraftConfig,
  type ParameterMap,
  type Ruleset,
} from '@foqa/shared';

/** Repo-root config/ by default; FOQA_CONFIG_DIR overrides (Docker mounts it). */
export function configDir(): string {
  return process.env.FOQA_CONFIG_DIR ?? fileURLToPath(new URL('../../../config', import.meta.url));
}

export interface FoqaConfig {
  parameterMap: ParameterMap;
  aircraft: AircraftConfig;
  ruleset: Ruleset;
}

export function loadConfig(dir = configDir()): FoqaConfig {
  const parameterMap = loadParameterMap(readFileSync(join(dir, 'parameter-map.yaml'), 'utf8'));
  const aircraft = loadAircraftConfig(readFileSync(join(dir, 'aircraft.yaml'), 'utf8'));
  const ruleFiles = readdirSync(join(dir, 'rules'))
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const ruleset = mergeRulesets(
    ruleFiles.map((f) => loadRuleset(readFileSync(join(dir, 'rules', f), 'utf8'))),
  );
  return { parameterMap, aircraft, ruleset };
}
