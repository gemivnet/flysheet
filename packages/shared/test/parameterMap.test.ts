import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadParameterMap } from '../src/parameterMap.js';

const repoMap = readFileSync(
  fileURLToPath(new URL('../../../config/parameter-map.yaml', import.meta.url)),
  'utf8',
);

describe('loadParameterMap', () => {
  it('loads the repo parameter map', () => {
    const map = loadParameterMap(repoMap);
    expect(map.headerToCanonical.get('IAS')).toBe('ias_kt');
    expect(map.headerToCanonical.get('E1 RPM')).toBe('rpm');
    expect(map.time.date).toContain('Lcl Date');
  });

  it('maps alternate header spellings to the same canonical', () => {
    const map = loadParameterMap(repoMap);
    expect(map.headerToCanonical.get('GndSpd')).toBe('gs_kt');
    expect(map.headerToCanonical.get('Gnd Spd')).toBe('gs_kt');
    expect(map.headerToCanonical.get('GS')).toBe('gs_kt');
  });

  it('rejects unknown canonical parameter names', () => {
    const bad = `version: 1\ntime:\n  date: [D]\n  time: [T]\n  utcOffset: [O]\nparameters:\n  not_a_param:\n    headers: [X]\n`;
    expect(() => loadParameterMap(bad)).toThrow(/unknown canonical/);
  });

  it('rejects mapping a derived parameter from CSV', () => {
    const bad = `version: 1\ntime:\n  date: [D]\n  time: [T]\n  utcOffset: [O]\nparameters:\n  agl_ft:\n    headers: [AGL]\n`;
    expect(() => loadParameterMap(bad)).toThrow(/derived/);
  });

  it('rejects one header mapped to two canonicals', () => {
    const bad = `version: 1\ntime:\n  date: [D]\n  time: [T]\n  utcOffset: [O]\nparameters:\n  ias_kt:\n    headers: [SPD]\n  tas_kt:\n    headers: [SPD]\n`;
    expect(() => loadParameterMap(bad)).toThrow(/mapped to both/);
  });
});
