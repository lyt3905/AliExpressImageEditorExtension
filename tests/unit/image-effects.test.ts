import { describe, expect, it } from 'vitest';

import { DEFAULT_IMAGE_EFFECTS, IMAGE_EFFECT_LIMITS } from '../../src/shared/constants';
import {
  colorChannels,
  EMPTY_IMAGE_EFFECTS,
  hasVisibleEffects,
  imageEffectsEqual,
  needsFilterPass,
  normalizeColor,
  normalizeImageEffects,
  shadowColorWithOpacity,
} from '../../src/services/image-effects';

describe('normalizeImageEffects', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const input of [undefined, null, 42, 'effects', [], true]) {
      expect(normalizeImageEffects(input)).toEqual(DEFAULT_IMAGE_EFFECTS);
    }
  });

  it('clamps every number into its legal range', () => {
    const effects = normalizeImageEffects({
      opacity: 3,
      brightness: -9,
      shadowBlur: 500,
      shadowOpacity: 2,
      shadowOffsetX: -900,
      shadowOffsetY: 900,
      glowRadius: 900,
      glowBlur: 900,
      glowOpacity: -1,
    });

    expect(effects.opacity).toBe(1);
    expect(effects.brightness).toBe(-1);
    expect(effects.shadowBlur).toBe(IMAGE_EFFECT_LIMITS.shadowBlur);
    expect(effects.shadowOpacity).toBe(1);
    expect(effects.shadowOffsetX).toBe(-IMAGE_EFFECT_LIMITS.shadowOffset);
    expect(effects.shadowOffsetY).toBe(IMAGE_EFFECT_LIMITS.shadowOffset);
    expect(effects.glowRadius).toBe(IMAGE_EFFECT_LIMITS.glowRadius);
    expect(effects.glowBlur).toBe(IMAGE_EFFECT_LIMITS.glowBlur);
    expect(effects.glowOpacity).toBe(0);
  });

  it('keeps a NaN / Infinity out of the document', () => {
    const effects = normalizeImageEffects({ opacity: Number.NaN, shadowBlur: Number.POSITIVE_INFINITY });
    expect(effects.opacity).toBe(1);
    expect(effects.shadowBlur).toBe(0);
  });

  it('drops a half-written block back to per-field defaults instead of failing', () => {
    const effects = normalizeImageEffects({ opacity: 0.5 });
    expect(effects.opacity).toBe(0.5);
    expect(effects.brightness).toBe(0);
    expect(effects.grayscale).toBe(false);
    expect(effects.shadowColor).toBe(DEFAULT_IMAGE_EFFECTS.shadowColor);
    expect(effects.glowOpacity).toBe(0);
  });

  it('reads only a real boolean for grayscale', () => {
    expect(normalizeImageEffects({ grayscale: 'true' }).grayscale).toBe(false);
    expect(normalizeImageEffects({ grayscale: 1 }).grayscale).toBe(false);
    expect(normalizeImageEffects({ grayscale: true }).grayscale).toBe(true);
  });
});

describe('normalizeColor', () => {
  it('expands the short form and lowercases', () => {
    expect(normalizeColor('#ABC', '#000000')).toBe('#aabbcc');
    expect(normalizeColor('#A1B2C3', '#000000')).toBe('#a1b2c3');
  });

  it('falls back for anything that is not a hex colour', () => {
    for (const input of ['red', 'rgba(0,0,0,0.5)', '#12345', '', 42, null]) {
      expect(normalizeColor(input, '#ff0000')).toBe('#ff0000');
    }
  });
});

describe('hasVisibleEffects / needsFilterPass', () => {
  it('treats an absent or default block as "nothing to paint"', () => {
    expect(hasVisibleEffects(undefined)).toBe(false);
    expect(hasVisibleEffects(DEFAULT_IMAGE_EFFECTS)).toBe(false);
    expect(needsFilterPass(undefined)).toBe(false);
  });

  it('counts each visible effect once it is actually reachable', () => {
    expect(hasVisibleEffects({ opacity: 0.5 })).toBe(true);
    expect(hasVisibleEffects({ brightness: 0.2 })).toBe(true);
    expect(hasVisibleEffects({ grayscale: true })).toBe(true);
    // A shadow with zero blur and zero offsets paints nothing, so it does not count.
    expect(hasVisibleEffects({ shadowOpacity: 0.8 })).toBe(false);
    expect(hasVisibleEffects({ shadowOpacity: 0.8, shadowBlur: 8 })).toBe(true);
    expect(hasVisibleEffects({ glowOpacity: 0.8 })).toBe(false);
    expect(hasVisibleEffects({ glowOpacity: 0.8, glowBlur: 10 })).toBe(true);
  });

  it('asks for a filter pass only for the pixel filters', () => {
    expect(needsFilterPass({ grayscale: true })).toBe(true);
    expect(needsFilterPass({ brightness: -0.3 })).toBe(true);
    // Opacity, shadows and glows are painted, not filtered.
    expect(needsFilterPass({ opacity: 0.4, shadowBlur: 10, shadowOpacity: 0.5 })).toBe(false);
    expect(needsFilterPass({ glowBlur: 12, glowOpacity: 0.6 })).toBe(false);
  });
});

describe('imageEffectsEqual', () => {
  it('ignores undefined vs an explicit default block', () => {
    expect(imageEffectsEqual(undefined, { ...EMPTY_IMAGE_EFFECTS })).toBe(true);
  });

  it('compares a normalised view, so #ABC equals #aabbcc', () => {
    expect(imageEffectsEqual({ glowColor: '#ABC' }, { glowColor: '#aabbcc' })).toBe(true);
  });

  it('notices a single changed field', () => {
    expect(imageEffectsEqual({ opacity: 0.9 }, { opacity: 0.8 })).toBe(false);
    expect(imageEffectsEqual({ grayscale: true }, {})).toBe(false);
    expect(imageEffectsEqual({ shadowOffsetY: 4 }, {})).toBe(false);
  });
});

describe('colour helpers used by the stage', () => {
  it('splits a hex colour into 0–255 channels', () => {
    expect(colorChannels('#ff8000')).toEqual({ red: 255, green: 128, blue: 0 });
    expect(colorChannels('#abc')).toEqual({ red: 170, green: 187, blue: 204 });
  });

  it('folds the shadow opacity into an rgba colour (Konva has no shadow opacity)', () => {
    expect(shadowColorWithOpacity('#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
    expect(shadowColorWithOpacity('#ffffff', 2)).toBe('rgba(255, 255, 255, 1)');
    expect(shadowColorWithOpacity('nonsense', -1)).toBe('rgba(0, 0, 0, 0)');
  });
});
