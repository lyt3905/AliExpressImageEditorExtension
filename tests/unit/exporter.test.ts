import { describe, expect, it } from 'vitest';
import { CANVAS_SIZE } from '../../src/shared/constants';
import { buildExportFileName } from '../../src/services/exporter';

describe('buildExportFileName', () => {
  it('produces the documented aliexpress-composite-<date>-<time>.png shape', () => {
    const name = buildExportFileName(new Date(2026, 8, 27, 11, 45, 0));
    expect(name).toBe('aliexpress-composite-20260927-114500.png');
    expect(name).toMatch(/^aliexpress-composite-\d{8}-\d{6}\.png$/);
  });

  it('zero-pads every component', () => {
    expect(buildExportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('aliexpress-composite-20260102-030405.png');
  });
});

describe('export constants', () => {
  it('locks the export to 800x800', () => {
    expect(CANVAS_SIZE).toBe(800);
  });
});
