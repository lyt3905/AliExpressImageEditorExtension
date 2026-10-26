import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM helper under scripts/, no type declarations on purpose.
import { isChromeVersion, nextVersion } from '../../scripts/version-math.mjs';

describe('nextVersion', () => {
  it('bumps patch / minor / major without losing segments', () => {
    // The bug this file exists for: `minor` used to drop the major, turning
    // 10.0.0 into 1.0 — and it was only caught by reading the output back.
    expect(nextVersion('10.0.0', 'patch')).toBe('10.0.1');
    expect(nextVersion('10.0.0', 'minor')).toBe('10.1.0');
    expect(nextVersion('10.0.0', 'major')).toBe('11.0.0');
    expect(nextVersion('10.9.9', 'minor')).toBe('10.10.0');
    expect(nextVersion('10.9.9', 'patch')).toBe('10.9.10');
  });

  it('treats a two-part version as if the patch were zero', () => {
    expect(nextVersion('1.0', 'patch')).toBe('1.0.1');
    expect(nextVersion('1.0', 'minor')).toBe('1.1.0');
  });

  it('accepts an explicit version, with or without a leading v', () => {
    expect(nextVersion('10.0.0', '10.2.3')).toBe('10.2.3');
    expect(nextVersion('10.0.0', 'v10.2.3')).toBe('10.2.3');
  });

  it('rejects anything Chrome would refuse', () => {
    expect(() => nextVersion('10.0.0', '10.02.3')).toThrow(/Chrome/); // leading zero
    expect(() => nextVersion('10.0.0', '10.0.0.0.0')).toThrow(/Chrome/); // five parts
    expect(() => nextVersion('10.0.0', '10.70000.0')).toThrow(/Chrome/); // out of range
    expect(() => nextVersion('10.0.0', 'nonsense')).toThrow(/Chrome/);
  });

  it('rejects a no-op bump', () => {
    expect(() => nextVersion('10.0.0', '10.0.0')).toThrow(/没变/);
  });

  it('rejects a missing argument or a broken current version', () => {
    expect(() => nextVersion('10.0.0', '')).toThrow(/缺少参数/);
    expect(() => nextVersion('10.000.0', 'patch')).toThrow(/不合法/);
  });
});

describe('isChromeVersion', () => {
  it('matches Chrome’s accepted shapes', () => {
    for (const version of ['1', '1.0', '1.2.3', '10.0.0', '10.1.0', '0.0.1', '65535.0.0']) {
      expect(isChromeVersion(version), version).toBe(true);
    }
  });

  it('rejects the shapes Chrome rejects', () => {
    for (const version of ['', '01.0.0', '1.0.0.0.0', '1.-1.0', '1.0.0-beta', '65536.0.0']) {
      expect(isChromeVersion(version), version).toBe(false);
    }
  });

  it('enforces the 65535 ceiling numerically, not by digit count', () => {
    // 65535 is five digits — a `\d{0,3}` regex tail wrongly rejects it.
    expect(isChromeVersion('65535.65535.65535')).toBe(true);
    expect(isChromeVersion('65536.0.0')).toBe(false);
  });
});
