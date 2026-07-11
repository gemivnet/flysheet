import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAircraftConfig } from '../src/aircraft.js';
import {
  canonicalRulesetJson,
  loadRuleset,
  mergeRulesets,
  resolveRuleset,
} from '../src/rules.js';

const aircraft = loadAircraftConfig(
  readFileSync(fileURLToPath(new URL('../../../config/aircraft.yaml', import.meta.url)), 'utf8'),
);

const VALID = `
rules:
  - id: sink_rate_low
    severity: warning
    phases: [approach, descent]
    when:
      all:
        - { parameter: agl_ft, lt: 1000, gt: 50 }
        - { parameter: vsi_fpm, lt: -1000 }
    min_duration_s: 3
    hysteresis: { release_after_s: 2 }
    peak: { parameter: vsi_fpm, mode: min }
`;

describe('rule schema', () => {
  it('parses a valid interval rule', () => {
    const rs = loadRuleset(VALID);
    expect(rs.rules[0]!.id).toBe('sink_rate_low');
  });

  it('rejects unknown parameters', () => {
    expect(() =>
      loadRuleset(`rules:\n  - id: x\n    severity: info\n    when: { parameter: bogus, gt: 1 }\n`),
    ).toThrow();
  });

  it('rejects a leaf with no operator', () => {
    expect(() =>
      loadRuleset(`rules:\n  - id: x\n    severity: info\n    when: { parameter: ias_kt }\n`),
    ).toThrow();
  });

  it('rejects gate + window on the same rule', () => {
    const bad = `
rules:
  - id: x
    severity: info
    gate: { parameter: agl_ft, crossing: { value: 500, direction: down } }
    window: { anchor: touchdown, before_s: 1, after_s: 1 }
    when: { parameter: ias_kt, gt: 1 }
`;
    expect(() => loadRuleset(bad)).toThrow(/mutually exclusive/);
  });

  it('rejects duplicate rule ids on merge', () => {
    const rs = loadRuleset(VALID);
    expect(() => mergeRulesets([rs, rs])).toThrow(/duplicate/);
  });
});

describe('$aircraft refs', () => {
  it('resolves refs to numbers from aircraft.yaml', () => {
    const rs = loadRuleset(`
rules:
  - id: fast_at_gate
    severity: warning
    gate: { parameter: agl_ft, crossing: { value: 500, direction: down } }
    when:
      { parameter: ias_kt, outside: { min: '$aircraft.vspeeds.vs0_kt', max: '$aircraft.vspeeds.vfe_kt' } }
`);
    const resolved = resolveRuleset(rs, aircraft);
    const when = resolved.rules[0]!.when;
    expect('parameter' in when && when.outside).toEqual({ min: 41, max: 82 });
  });

  it('throws on a bad ref path', () => {
    const rs = loadRuleset(`
rules:
  - id: x
    severity: info
    when: { parameter: ias_kt, gt: '$aircraft.vspeeds.nope_kt' }
`);
    expect(() => resolveRuleset(rs, aircraft)).toThrow(/not found/);
  });
});

describe('canonicalRulesetJson', () => {
  it('is stable across rule order and key order', () => {
    const a = loadRuleset(`
rules:
  - id: b_rule
    severity: info
    when: { parameter: ias_kt, gt: 1 }
  - id: a_rule
    severity: info
    when: { parameter: rpm, lt: 9000 }
`);
    const b = loadRuleset(`
rules:
  - id: a_rule
    when: { parameter: rpm, lt: 9000 }
    severity: info
  - id: b_rule
    when: { parameter: ias_kt, gt: 1 }
    severity: info
`);
    expect(canonicalRulesetJson(a)).toBe(canonicalRulesetJson(b));
  });
});
