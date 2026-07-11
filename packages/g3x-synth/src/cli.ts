import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIO_NAMES, generateScenario, type ScenarioName } from './scenarios.js';

function usage(): never {
  console.error(
    `Usage: g3x-synth --scenario <name|all> [--seed N] [--garbage-rate 0..1] [--out DIR]\n` +
      `Scenarios: ${SCENARIO_NAMES.join(', ')}`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const scenarioArg = opt('scenario') ?? usage();
const seed = Number(opt('seed') ?? 42);
const garbageRate = Number(opt('garbage-rate') ?? 0);
const outDir = opt('out') ?? './fixtures/generated';

const names: ScenarioName[] =
  scenarioArg === 'all'
    ? [...SCENARIO_NAMES]
    : SCENARIO_NAMES.includes(scenarioArg as ScenarioName)
      ? [scenarioArg as ScenarioName]
      : usage();

mkdirSync(outDir, { recursive: true });
for (const name of names) {
  const result = generateScenario(name, { seed, garbageRate });
  for (const file of result.files) {
    const path = join(outDir, file.name);
    writeFileSync(path, file.csv);
    const rows = file.csv.split('\n').length - 4;
    console.log(`${name}: ${path} (${rows} rows)`);
  }
}
