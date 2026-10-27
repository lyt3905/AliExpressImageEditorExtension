import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANVAS_SIZE,
  MAX_FONT_SIZE,
  MAX_SHADOW_BLUR,
  MAX_STROKE_WIDTH,
  MAX_TEXT_WIDTH,
  MIN_FONT_SIZE,
  MIN_TEXT_WIDTH,
  STORAGE_KEYS,
  TEXT_LAYER_DEFAULTS,
  TEXT_STYLE_KEYS,
} from '../../src/shared/constants';
import {
  DEFAULT_TEXT_STYLE,
  pickTextStyle,
  sanitizeTextStyle,
  type TextStyleDefaults,
} from '../../src/shared/text-style';
import { createTextLayer } from '../../src/editor/state/editor-reducer';
import {
  clearTextDefaults,
  loadTextDefaults,
  saveTextDefaults,
} from '../../src/services/text-defaults';

/**
 * The preference store runs without a browser: `chrome.storage.local` is stubbed
 * in memory and handed back so a test can assert on the raw stored value.
 */
function installChromeStub(): Map<string, unknown> {
  const backing = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (backing.has(key) ? { [key]: backing.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) backing.set(key, value);
        },
        remove: async (key: string) => {
          backing.delete(key);
        },
      },
    },
  };
  return backing;
}

/** A style that differs from the factory defaults in every remembered field. */
const CUSTOM_STYLE: TextStyleDefaults = {
  width: 620,
  fontSize: 72,
  fontFamily: 'SimHei',
  fill: '#ff0000',
  fontStyle: 'bold',
  align: 'left',
  stroke: '#000000',
  strokeWidth: 6,
  shadowColor: '#00ff00',
  shadowBlur: 12,
  shadowOffsetX: 4,
  shadowOffsetY: -8,
  shadowOpacity: 0.8,
};

describe('DEFAULT_TEXT_STYLE', () => {
  it('covers exactly the remembered keys', () => {
    expect(Object.keys(DEFAULT_TEXT_STYLE).sort()).toEqual([...TEXT_STYLE_KEYS].sort());
  });

  it('takes its values from the factory defaults', () => {
    for (const key of TEXT_STYLE_KEYS) {
      expect(DEFAULT_TEXT_STYLE[key]).toBe(TEXT_LAYER_DEFAULTS[key]);
    }
  });

  it('does not carry the copy, the position or the transform', () => {
    for (const key of ['text', 'x', 'y', 'scale', 'rotation']) {
      expect(DEFAULT_TEXT_STYLE).not.toHaveProperty(key);
    }
  });

  it('remembers the wrap width', () => {
    // 10.5.4: the box width is how a label is shaped, so it belongs to the style.
    // A seller who drags 400 → 620 must not have to drag it out again next time.
    expect(DEFAULT_TEXT_STYLE.width).toBe(TEXT_LAYER_DEFAULTS.width);
  });
});

describe('pickTextStyle', () => {
  it('returns null when a patch carries no style at all', () => {
    expect(pickTextStyle({})).toBeNull();
    expect(pickTextStyle({ text: '新的文案' })).toBeNull();
    expect(pickTextStyle({ x: 10, y: 20 })).toBeNull();
    expect(pickTextStyle({ scale: 1.5, rotation: 30 })).toBeNull();
  });

  it('treats a wrap-width change as a style edit', () => {
    // A transformer drag on a text layer commits `width` and nothing else, so
    // this is the path that has to write the preference.
    expect(pickTextStyle({ width: 320 })).toEqual({ width: 320 });
  });

  it('keeps only the style fields of a mixed patch', () => {
    expect(pickTextStyle({ x: 10, fontSize: 64, text: 'hi', strokeWidth: 3 })).toEqual({
      fontSize: 64,
      strokeWidth: 3,
    });
  });

  it('treats zero as a value, not as a missing field', () => {
    // strokeWidth 0 is "no outline" — the single most important thing to remember.
    expect(pickTextStyle({ strokeWidth: 0 })).toEqual({ strokeWidth: 0 });
    expect(pickTextStyle({ shadowBlur: 0, shadowOffsetY: 0 })).toEqual({
      shadowBlur: 0,
      shadowOffsetY: 0,
    });
  });

  it('skips keys that are explicitly undefined', () => {
    expect(pickTextStyle({ x: 5, fontSize: undefined })).toBeNull();
  });

  it('carries every remembered key through', () => {
    expect(pickTextStyle({ ...CUSTOM_STYLE })).toEqual(CUSTOM_STYLE);
  });
});

describe('sanitizeTextStyle', () => {
  it('returns the factory style for anything unusable', () => {
    expect(sanitizeTextStyle(undefined)).toEqual(DEFAULT_TEXT_STYLE);
    expect(sanitizeTextStyle(null)).toEqual(DEFAULT_TEXT_STYLE);
    expect(sanitizeTextStyle('nonsense')).toEqual(DEFAULT_TEXT_STYLE);
    expect(sanitizeTextStyle(42)).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('rebuilds a partially written entry field by field', () => {
    const restored = sanitizeTextStyle({ fill: '#123456' });
    expect(restored.fill).toBe('#123456');
    expect(restored.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(restored.strokeWidth).toBe(TEXT_LAYER_DEFAULTS.strokeWidth);
  });

  it('clamps numbers into the panel ranges', () => {
    expect(sanitizeTextStyle({ fontSize: 9999 }).fontSize).toBe(MAX_FONT_SIZE);
    expect(sanitizeTextStyle({ fontSize: -5 }).fontSize).toBe(MIN_FONT_SIZE);
    expect(sanitizeTextStyle({ strokeWidth: 999 }).strokeWidth).toBe(MAX_STROKE_WIDTH);
    expect(sanitizeTextStyle({ shadowBlur: 999 }).shadowBlur).toBe(MAX_SHADOW_BLUR);
    expect(sanitizeTextStyle({ shadowOpacity: 5 }).shadowOpacity).toBe(1);
    expect(sanitizeTextStyle({ shadowOpacity: -1 }).shadowOpacity).toBe(0);
  });

  it('keeps the remembered wrap width inside the box limits, in whole px', () => {
    expect(sanitizeTextStyle({ width: 5000 }).width).toBe(MAX_TEXT_WIDTH);
    expect(sanitizeTextStyle({ width: 1 }).width).toBe(MIN_TEXT_WIDTH);
    expect(sanitizeTextStyle({ width: 437.6 }).width).toBe(438);
    expect(sanitizeTextStyle({ width: Number.NaN }).width).toBe(TEXT_LAYER_DEFAULTS.width);
    expect(sanitizeTextStyle({ width: '620' }).width).toBe(TEXT_LAYER_DEFAULTS.width);
  });

  it('drops values of the wrong type', () => {
    expect(sanitizeTextStyle({ fontSize: 'big' }).fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(sanitizeTextStyle({ fill: '' }).fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(sanitizeTextStyle({ fill: 7 }).fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(sanitizeTextStyle({ fontFamily: '   ' }).fontFamily).toBe(TEXT_LAYER_DEFAULTS.fontFamily);
  });

  it('rejects enum values it does not know', () => {
    expect(sanitizeTextStyle({ align: 'justify' }).align).toBe(TEXT_LAYER_DEFAULTS.align);
    expect(sanitizeTextStyle({ fontStyle: 'italic' }).fontStyle).toBe(TEXT_LAYER_DEFAULTS.fontStyle);
  });

  it('uses the given fallback for missing fields', () => {
    const fallback: TextStyleDefaults = { ...DEFAULT_TEXT_STYLE, fill: '#abcdef', fontSize: 30 };
    expect(sanitizeTextStyle({}, fallback)).toEqual(fallback);
    expect(sanitizeTextStyle({ fontSize: 12 }, fallback).fill).toBe('#abcdef');
  });
});

describe('text-defaults store', () => {
  beforeEach(() => {
    installChromeStub();
  });

  it('returns the factory defaults when nothing has been remembered', async () => {
    expect(await loadTextDefaults()).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('round-trips a saved style', async () => {
    await saveTextDefaults(CUSTOM_STYLE);
    expect(await loadTextDefaults()).toEqual(CUSTOM_STYLE);
  });

  it('sanitizes what it writes', async () => {
    const backing = installChromeStub();
    await saveTextDefaults({ ...CUSTOM_STYLE, fontSize: 9999, fill: '' });

    const raw = backing.get(STORAGE_KEYS.textDefaults) as TextStyleDefaults;
    expect(raw.fontSize).toBe(MAX_FONT_SIZE);
    expect(raw.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
  });

  it('sanitizes a corrupted entry on read', async () => {
    const backing = installChromeStub();
    backing.set(STORAGE_KEYS.textDefaults, { fontSize: -3, align: 12 });
    expect(await loadTextDefaults()).toEqual({
      ...DEFAULT_TEXT_STYLE,
      fontSize: MIN_FONT_SIZE,
    });
  });

  it('replaces the stored style instead of merging into it', async () => {
    await saveTextDefaults(CUSTOM_STYLE);
    // No explicit fields → sanitizes to the factory style, which must replace
    // the red one rather than leave its fields behind.
    await saveTextDefaults({} as TextStyleDefaults);
    expect(await loadTextDefaults()).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('lets the last of two quick writes win', async () => {
    // Whole-object overwrites, never a read-modify-write: two commits in a row
    // must not interleave their get/set pairs.
    await Promise.all([
      saveTextDefaults({ ...CUSTOM_STYLE, fill: '#111111' }),
      saveTextDefaults(CUSTOM_STYLE),
    ]);
    expect((await loadTextDefaults()).fill).toBe(CUSTOM_STYLE.fill);
  });

  it('forgets the preference', async () => {
    const backing = installChromeStub();
    await saveTextDefaults(CUSTOM_STYLE);
    await clearTextDefaults();

    expect(backing.has(STORAGE_KEYS.textDefaults)).toBe(false);
    expect(await loadTextDefaults()).toEqual(DEFAULT_TEXT_STYLE);
  });

  it('degrades quietly when storage is unavailable', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error('storage down');
          },
          set: async () => {
            throw new Error('storage down');
          },
          remove: async () => {
            throw new Error('storage down');
          },
        },
      },
    };

    await expect(saveTextDefaults(CUSTOM_STYLE)).resolves.toBeUndefined();
    await expect(clearTextDefaults()).resolves.toBeUndefined();
    expect(await loadTextDefaults()).toEqual(DEFAULT_TEXT_STYLE);
  });
});

describe('createTextLayer with a remembered style', () => {
  it('uses the factory style when nothing was remembered', () => {
    const layer = createTextLayer();
    for (const key of TEXT_STYLE_KEYS) expect(layer[key]).toBe(TEXT_LAYER_DEFAULTS[key]);
  });

  it('applies the remembered style', () => {
    const layer = createTextLayer(CUSTOM_STYLE);
    for (const key of TEXT_STYLE_KEYS) expect(layer[key]).toBe(CUSTOM_STYLE[key]);
  });

  it('comes out the width you dragged last time', () => {
    // The whole point of remembering the box: no re-stretching on every label.
    expect(createTextLayer(CUSTOM_STYLE).width).toBe(CUSTOM_STYLE.width);
    expect(createTextLayer().width).toBe(TEXT_LAYER_DEFAULTS.width);
  });

  it('always starts from a fresh copy, position and transform', () => {
    const layer = createTextLayer(CUSTOM_STYLE);
    expect(layer.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(layer.x).toBe(CANVAS_SIZE / 2);
    expect(layer.y).toBe(CANVAS_SIZE / 2);
    expect(layer.scale).toBe(TEXT_LAYER_DEFAULTS.scale);
    expect(layer.rotation).toBe(TEXT_LAYER_DEFAULTS.rotation);
    expect(layer.id).not.toBe(createTextLayer().id);
  });

  it('ignores non-style fields even if a caller smuggles them in', () => {
    const smuggled = { ...CUSTOM_STYLE, text: '上一层的文案', x: 0, scale: 4 } as TextStyleDefaults;
    const layer = createTextLayer(smuggled);

    expect(layer.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(layer.x).toBe(CANVAS_SIZE / 2);
    expect(layer.scale).toBe(TEXT_LAYER_DEFAULTS.scale);
    expect(layer.fontSize).toBe(CUSTOM_STYLE.fontSize);
  });

  it('never lets an undefined field clobber a default', () => {
    const layer = createTextLayer({ fontSize: undefined, fill: undefined });
    expect(layer.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(layer.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
  });

  it('carries a commit through to the next layer', async () => {
    // The full loop: edit → pick → store → load → create.
    const backing = installChromeStub();
    const style = pickTextStyle({ fontSize: 88, strokeWidth: 5, text: '不该被记住' }) ?? {};
    expect(Object.keys(style).sort()).toEqual(['fontSize', 'strokeWidth']);

    await saveTextDefaults({ ...DEFAULT_TEXT_STYLE, ...style });
    const remembered = await loadTextDefaults();
    const layer = createTextLayer(remembered);

    expect(layer.fontSize).toBe(88);
    expect(layer.strokeWidth).toBe(5);
    expect(layer.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(backing.has(STORAGE_KEYS.textDefaults)).toBe(true);
  });
});
