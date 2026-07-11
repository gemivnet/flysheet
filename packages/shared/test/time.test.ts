import { describe, expect, it } from 'vitest';
import { formatG3xLocal, parseG3xTimestamp, parseUtcOffsetMinutes } from '../src/time.js';

describe('parseUtcOffsetMinutes', () => {
  it('parses negative and positive offsets', () => {
    expect(parseUtcOffsetMinutes('-05:00')).toBe(-300);
    expect(parseUtcOffsetMinutes('+05:30')).toBe(330);
    expect(parseUtcOffsetMinutes('00:00')).toBe(0);
  });

  it('rejects malformed offsets', () => {
    expect(parseUtcOffsetMinutes('---')).toBeNull();
    expect(parseUtcOffsetMinutes('25:00')).toBeNull();
    expect(parseUtcOffsetMinutes('')).toBeNull();
  });
});

describe('parseG3xTimestamp', () => {
  it('converts local + offset to UTC', () => {
    const d = parseG3xTimestamp('2026-07-03', '14:23:01', '-05:00');
    expect(d?.toISOString()).toBe('2026-07-03T19:23:01.000Z');
  });

  it('handles a DST fall-back mid-flight: UTC stays monotonic when the offset flips', () => {
    // Local clock repeats 01:30 (CDT -05:00 → CST -06:00); UTC must not.
    const before = parseG3xTimestamp('2026-11-01', '01:30:00', '-05:00');
    const after = parseG3xTimestamp('2026-11-01', '01:30:00', '-06:00');
    expect(before?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(after?.toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('rejects garbage cells', () => {
    expect(parseG3xTimestamp('---', '14:23:01', '-05:00')).toBeNull();
    expect(parseG3xTimestamp('2026-07-03', '--', '-05:00')).toBeNull();
  });
});

describe('formatG3xLocal', () => {
  it('round-trips through parseG3xTimestamp', () => {
    const utc = new Date('2026-07-03T19:23:01.000Z');
    const { lclDate, lclTime, utcOfst } = formatG3xLocal(utc, -300);
    expect(lclDate).toBe('2026-07-03');
    expect(lclTime).toBe('14:23:01');
    expect(utcOfst).toBe('-05:00');
    expect(parseG3xTimestamp(lclDate, lclTime, utcOfst)?.getTime()).toBe(utc.getTime());
  });
});
