import { describe, expect, it } from 'vitest';
import {
  hasDecorativeHint,
  hashImageUrl,
  isDecorativeUrl,
  isHttpUrl,
  normalizeImageUrl,
  stripImageDecoration,
} from '../../src/content/url-normalizer';

describe('normalizeImageUrl', () => {
  it('strips the AliExpress size suffix so the same asset dedupes', () => {
    expect(normalizeImageUrl('https://ae01.alicdn.com/kf/Sabc123.jpg_220x220.jpg')).toBe(
      'https://ae01.alicdn.com/kf/Sabc123.jpg',
    );
    expect(normalizeImageUrl('https://ae01.alicdn.com/kf/Sabc123.jpg_Q90.jpg')).toBe(
      'https://ae01.alicdn.com/kf/Sabc123.jpg',
    );
    expect(normalizeImageUrl('https://ae01.alicdn.com/kf/Sabc123.jpg_.webp')).toBe(
      'https://ae01.alicdn.com/kf/Sabc123.jpg',
    );
    expect(normalizeImageUrl('https://ae01.alicdn.com/kf/Sabc123.jpg_300x300.png_.webp')).toBe(
      'https://ae01.alicdn.com/kf/Sabc123.jpg',
    );
  });

  it('collapses query strings and fragments, and lowercases host + protocol', () => {
    expect(normalizeImageUrl('HTTPS://AE01.ALICDN.COM/kf/A.png?width=800#frag')).toBe(
      'https://ae01.alicdn.com/kf/A.png',
    );
  });

  it('upgrades protocol-relative URLs to https', () => {
    expect(normalizeImageUrl('//ae01.alicdn.com/kf/B.png')).toBe('https://ae01.alicdn.com/kf/B.png');
  });

  it('returns an empty string for unusable input', () => {
    expect(normalizeImageUrl('data:image/png;base64,AAAA')).toBe('');
    expect(normalizeImageUrl('blob:https://x/y')).toBe('');
    expect(normalizeImageUrl('/kf/relative.png')).toBe('');
    expect(normalizeImageUrl('')).toBe('');
    expect(normalizeImageUrl(undefined)).toBe('');
    expect(normalizeImageUrl(42)).toBe('');
  });

  it('is stable across differently decorated forms of one asset', () => {
    const forms = [
      'https://ae01.alicdn.com/kf/S1.jpg',
      'https://ae01.alicdn.com/kf/S1.jpg_50x50.jpg',
      'https://ae01.alicdn.com/kf/S1.jpg_Q75.jpg_.webp',
    ].map(normalizeImageUrl);
    expect(new Set(forms).size).toBe(1);
  });
});

describe('stripImageDecoration', () => {
  it('cuts at the first image extension', () => {
    expect(stripImageDecoration('/kf/a.jpg_220x220.jpg')).toBe('/kf/a.jpg');
    expect(stripImageDecoration('/kf/a.png')).toBe('/kf/a.png');
    expect(stripImageDecoration('/kf/no-extension')).toBe('/kf/no-extension');
  });
});

describe('filtering helpers', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://a.com/x.png')).toBe(true);
    expect(isHttpUrl('http://a.com/x.png')).toBe(true);
    expect(isHttpUrl('chrome-extension://abc/x.png')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });

  it('rejects data/blob/svg/gif and non-http sources', () => {
    expect(isDecorativeUrl('data:image/png;base64,AA')).toBe(true);
    expect(isDecorativeUrl('blob:https://a/b')).toBe(true);
    expect(isDecorativeUrl('https://a.com/icon.svg')).toBe(true);
    expect(isDecorativeUrl('https://a.com/anim.gif')).toBe(true);
    expect(isDecorativeUrl('https://a.com/photo.jpg')).toBe(false);
  });

  it('detects icon/logo/avatar/placeholder hints', () => {
    expect(hasDecorativeHint('https://a.com/icon-cart.png')).toBe(true);
    expect(hasDecorativeHint('https://a.com/kf/logo.png')).toBe(true);
    expect(hasDecorativeHint('用户头像 avatar')).toBe(true);
    expect(hasDecorativeHint('https://a.com/kf/Sabc.png')).toBe(false);
  });
});

describe('hashImageUrl', () => {
  it('is deterministic and collision-free for distinct urls', () => {
    const a = normalizeImageUrl('https://ae01.alicdn.com/kf/A.jpg');
    const b = normalizeImageUrl('https://ae01.alicdn.com/kf/B.jpg');
    expect(hashImageUrl(a)).toBe(hashImageUrl(a));
    expect(hashImageUrl(a)).not.toBe(hashImageUrl(b));
    expect(hashImageUrl(a)).toMatch(/^img-/);
  });
});
