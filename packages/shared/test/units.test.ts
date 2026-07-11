import { describe, expect, it } from 'vitest';
import { conversionFor, normalizeUnit } from '../src/units.js';

describe('normalizeUnit', () => {
  it('normalizes G3X units-row spellings', () => {
    expect(normalizeUnit('kts')).toBe('kt');
    expect(normalizeUnit(' deg F ')).toBe('F');
    expect(normalizeUnit('ft msl')).toBe('ft');
    expect(normalizeUnit('ft Baro')).toBe('ft');
    expect(normalizeUnit('degrees')).toBe('deg');
    expect(normalizeUnit('#degrees')).toBe('deg');
  });

  it('passes through unknown units untouched', () => {
    expect(normalizeUnit('furlongs')).toBe('furlongs');
  });
});

describe('conversionFor', () => {
  it('is identity when units match', () => {
    expect(conversionFor('kt', 'kt')!(123)).toBe(123);
  });

  it('converts F to C', () => {
    expect(conversionFor('F', 'C')!(212)).toBeCloseTo(100);
    expect(conversionFor('F', 'C')!(32)).toBeCloseTo(0);
  });

  it('converts mph to kt', () => {
    expect(conversionFor('mph', 'kt')!(115.078)).toBeCloseTo(100, 2);
  });

  it('returns null for unsafe conversions (never guesses)', () => {
    expect(conversionFor('psi', 'C')).toBeNull();
    expect(conversionFor('furlongs', 'ft')).toBeNull();
  });
});
