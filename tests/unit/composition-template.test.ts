import { describe, expect, it } from 'vitest';
import SOURCE from '../../src/services/composition/templates/hero_closeup_package_backdrop.v1.4.json';
import {
  DEFAULT_PACKAGE_VISIBLE_RATIO,
  parseLayoutTemplate,
  parseLayoutTemplateOrThrow,
  slotFootprints,
} from '../../src/services/composition/template-schema';
import { rectFromCenter, rectsIntersect } from '../../src/services/composition/rect';
import { parseAllTemplates } from '../../src/services/composition/templates';

/** Mutable deep copy of the shipped template — every case edits one field only. */
type Raw = Record<string, any>;
function raw(): Raw {
  return structuredClone(SOURCE) as unknown as Raw;
}

function issuePaths(result: { issues: Array<{ path: string; message: string }> }): string[] {
  return result.issues.map((issue) => issue.path);
}

function issueText(result: { issues: Array<{ path: string; message: string }> }): string {
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

describe('parseLayoutTemplate — the shipped v1.4 template', () => {
  const result = parseLayoutTemplate(SOURCE);

  it('validates without errors', () => {
    expect(result.issues).toEqual([]);
    expect(result.template).not.toBeNull();
  });

  it('keeps the numbers that encode the layout', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    expect(template.canvas.width).toBe(800);
    expect(template.canvas.safeMargin).toBe(16);
    // The footer strip must start exactly where the hero viewport ends.
    expect(template.canvas.reservedZones[0].box).toEqual([0, 712, 800, 800]);
    expect(template.canvas.reservedZones[0].avoidFor).toEqual(['hero', 'box']);
  });

  it('reads the hero close-up rule as [l,t,r,b] and keeps zoom/centre overrides', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    const hero = template.slots.find((slot) => slot.role === 'hero');
    expect(hero).toBeDefined();
    expect(hero?.closeup).toMatchObject({
      viewport: [16, 185, 784, 712],
      fit: 'height',
      zoom: 2.2,
      anchor: 'top_center',
      centerX: 300,
      clipToViewport: false,
    });
    // 784 === 800 - 16 and 712 === footer top: both edges are explained by the
    // rest of the template, which is why [l,t,r,b] is the only sane reading.
    expect(hero?.closeup?.viewport[2]).toBe(template.canvas.width - template.canvas.safeMargin);
    expect(hero?.closeup?.viewport[3]).toBe(template.canvas.reservedZones[0].box[1]);
  });

  it('keeps the four package variants inside the canvas', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    const box = template.slots.find((slot) => slot.role === 'box');
    expect(box?.variants).toHaveLength(4);
    expect(box?.variants?.[0]).toEqual({ center: [575, 280], maxSize: [380, 510] });
    const rect = rectFromCenter(box!.variants![0].center, box!.variants![0].maxSize);
    expect(rect).toEqual([385, 25, 765, 535]);
  });

  it('parses the missing-package fallback ladder as data', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    const box = template.slots.find((slot) => slot.role === 'box');
    expect(box?.fallbacks?.map((fallback) => fallback.kind)).toEqual([
      'secondary_view',
      'plate',
      'drop',
    ]);
    expect(box?.fallbacks?.[1]).toEqual({
      kind: 'plate',
      fill: '#F5F5F5',
      cornerRadius: 24,
      carries: 'model_code',
    });
  });

  it('defaults the undeclared package threshold and says so', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    expect(template.rules.packageReadability.minVisibleRatio).toBe(DEFAULT_PACKAGE_VISIBLE_RATIO);
    expect(result.warnings.map((warning) => warning.path)).toContain(
      'rules.package_readability.min_visible_ratio',
    );
  });

  it('flags the draft status instead of pretending it is stable', () => {
    expect(result.warnings.map((warning) => warning.path)).toContain('status');
  });

  it('warns that the widest variant creeps into the model-code column', () => {
    // 390 wide at centre 570 starts at 375; the text zone starts at 380, so the
    // nominal box overlaps it by 5px. Only the widest variant does this, which is
    // exactly the kind of drift a lint test should surface.
    const warning = result.warnings.find((entry) => entry.path === 'slots.package_backdrop');
    expect(warning?.message).toContain('model_top_left');
  });

  it('keeps hero and box from intruding into the footer strip', () => {
    const template = parseLayoutTemplateOrThrow(SOURCE);
    const footer = template.canvas.reservedZones[0].box;
    for (const slot of template.slots) {
      for (const rect of slotFootprints(slot)) {
        expect(rectsIntersect(rect, footer)).toBe(false);
      }
    }
  });
});

describe('parseLayoutTemplate — rejecting malformed templates', () => {
  it('catches an overflowing rect and names the [x,y,w,h] mix-up', () => {
    // A wrong-convention box usually runs off the canvas. When it does, the
    // message must say which mistake it suspects instead of just "出界".
    const broken = raw();
    broken.slots[0].closeup.viewport = [16, 185, 768, 900];
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issuePaths(result)).toContain('slots[0].closeup.viewport');
    expect(issueText(result)).toContain('[x, y, 宽, 高]');
  });

  it('cannot detect a plausible [x,y,w,h] misreading — the pinned relations must', () => {
    // Recorded on purpose. `[16,185,768,527]` is a legal rect (16..768 x 185..527),
    // so no local rule can reject it. This is exactly why the test above pins
    // `viewport.right === width - safe_margin` and `viewport.bottom === footer.top`:
    // that reading breaks both, and the misreading below breaks both.
    const misread = raw();
    misread.slots[0].closeup.viewport = [16, 185, 768, 527];
    const result = parseLayoutTemplate(misread);
    expect(result.template, '误写本身是合法矩形，校验层拦不住').not.toBeNull();

    const viewport = result.template!.slots[0].closeup!.viewport;
    expect(viewport[2]).not.toBe(result.template!.canvas.width - result.template!.canvas.safeMargin);
    expect(viewport[3]).not.toBe(result.template!.canvas.reservedZones[0].box[1]);
  });

  it('rejects a hero viewport that eats into the footer reserved zone', () => {
    const broken = raw();
    broken.slots[0].closeup.viewport = [16, 185, 784, 760];
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('store_footer');
  });

  it('rejects a text zone the hero viewport overlaps', () => {
    const broken = raw();
    broken.text_zones[0].box = [40, 65, 500, 260];
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('keep_clear_of_hero');
  });

  it('rejects clip_to_viewport: true instead of silently ignoring it', () => {
    const broken = raw();
    broken.slots[0].closeup.clip_to_viewport = true;
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('尚不支持');
  });

  it('rejects duplicate z_index — paint order would be undefined', () => {
    const broken = raw();
    broken.slots[1].z_index = 10;
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('z_index');
  });

  it('rejects an inverted occupancy band', () => {
    const broken = raw();
    broken.rules.hero_dominance.target_canvas_occupancy = [0.46, 0.36];
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('target_canvas_occupancy');
  });

  it('rejects a minimum occupancy floor above the target band', () => {
    const broken = raw();
    broken.rules.hero_dominance.min_canvas_occupancy = 0.9;
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('永远无法同时满足');
  });

  it('rejects an empty variant list', () => {
    const broken = raw();
    broken.slots[1].variants = [];
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('至少需要一个 variant');
  });

  it('rejects a slot with no geometry source', () => {
    const broken = raw();
    delete broken.slots[1].variants;
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('closeup 或 variants');
  });

  it('rejects an unknown slot role rather than guessing', () => {
    const broken = raw();
    broken.slots[1].role = 'backdrop';
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issueText(result)).toContain('未知角色');
  });

  it('rejects a missing id', () => {
    const broken = raw();
    delete broken.id;
    const result = parseLayoutTemplate(broken);
    expect(result.template).toBeNull();
    expect(issuePaths(result)).toContain('id');
  });

  it('rejects a non-object root', () => {
    const result = parseLayoutTemplate('nope');
    expect(result.template).toBeNull();
    expect(issuePaths(result)).toContain('');
  });

  it('treats unknown top-level keys as a warning, not an error', () => {
    const extended = raw();
    extended.notes = 'v1.5 想加的东西';
    const result = parseLayoutTemplate(extended);
    expect(result.template).not.toBeNull();
    expect(result.warnings.map((warning) => warning.path)).toContain('notes');
  });
});

describe('template registry', () => {
  it('every registered template passes the lint', () => {
    const results = parseAllTemplates();
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.issues, `${result.key}:\n${issueText(result)}`).toEqual([]);
      expect(result.template, result.key).not.toBeNull();
    }
  });
});

describe('rect helpers', () => {
  it('treats touching edges as non-overlapping', () => {
    // The shipped template depends on this: footer top === viewport bottom.
    expect(rectsIntersect([0, 712, 800, 800], [16, 185, 784, 712])).toBe(false);
    expect(rectsIntersect([0, 712, 800, 800], [16, 185, 784, 713])).toBe(true);
  });

  it('builds a rect from centre + size', () => {
    expect(rectFromCenter([575, 280], [380, 510])).toEqual([385, 25, 765, 535]);
  });
});
