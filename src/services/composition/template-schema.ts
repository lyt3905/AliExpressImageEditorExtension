/**
 * Parse + validate a layout template.
 *
 * Two jobs, and the second one is the point:
 *
 * 1. NORMALISE — snake_case JSON -> camelCase types, defaults filled in, numbers
 *    range-checked. Without this every downstream module would re-implement its
 *    own reading of the file.
 * 2. LINT — prove the template is self-consistent BEFORE any pixels exist:
 *    boxes inside the canvas, no slot inside a reserved zone, no hero creeping
 *    into the code-text zone, unique ids, a sane occupancy band.
 *
 * The lint is not ceremony. These templates are hand-tuned numbers (`784 ===
 * 800 - 16`, a 5px gap between the code zone and the package box); the next
 * version is one careless edit away from putting the box on top of the code, and
 * that failure is invisible in code review and obvious in a lint test.
 *
 * Errors make `template` null. Warnings keep the template usable and record what
 * was assumed instead.
 */

import {
  formatRect,
  rectFromCenter,
  rectsIntersect,
} from './rect';
import type {
  BoxVariant,
  CloseupSpec,
  CollisionRule,
  HeroDominanceRule,
  LayoutTemplate,
  Point,
  Rect,
  ReservedZone,
  ShadowRule,
  Size,
  SlotFallback,
  SlotRole,
  SlotSourceSelection,
  TemplateRules,
  TemplateSlot,
  TemplateStatus,
  TextZone,
} from './types';

/**
 * Fallback threshold for `rules.package_readability.min_visible_ratio`.
 *
 * The template does not declare it yet, so the parser supplies this value and
 * records a warning. Keeping the number in code while ACCEPTING it from the file
 * means a future version can tune how much of the box must stay visible without
 * touching a solver.
 */
export const DEFAULT_PACKAGE_VISIBLE_RATIO = 0.55;

export interface TemplateIssue {
  /** Dotted path into the raw JSON, e.g. `slots.package_backdrop.variants[2].center`. */
  path: string;
  message: string;
}

export interface TemplateParseResult {
  /** Null whenever `issues` is non-empty — a half-valid template must not render. */
  template: LayoutTemplate | null;
  issues: TemplateIssue[];
  warnings: TemplateIssue[];
}

const SLOT_ROLES: readonly SlotRole[] = ['hero', 'box', 'secondary', 'accent', 'support'];
const TEMPLATE_STATUSES: readonly TemplateStatus[] = ['draft', 'active', 'retired'];
const FALLBACK_KINDS: readonly SlotFallback['kind'][] = [
  'secondary_view',
  'mirrored_copy',
  'plate',
  'drop',
];

class Sink {
  readonly issues: TemplateIssue[] = [];
  readonly warnings: TemplateIssue[] = [];

  error(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  get failed(): boolean {
    return this.issues.length > 0;
  }
}

// ---------------------------------------------------------------- primitives

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `数组(${value.length})`;
  return typeof value;
}

function readNumber(raw: unknown, path: string, sink: Sink): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    sink.error(path, `需要有限数字，实际是${describe(raw)}`);
    return null;
  }
  return raw;
}

function readString(raw: unknown, path: string, sink: Sink): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    sink.error(path, `需要非空字符串，实际是${describe(raw)}`);
    return null;
  }
  return raw.trim();
}

function readBoolean(raw: unknown, path: string, sink: Sink, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    sink.error(path, `需要布尔值，实际是${describe(raw)}`);
    return fallback;
  }
  return raw;
}

function readRecord(raw: unknown, path: string, sink: Sink): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    sink.error(path, `需要对象，实际是${describe(raw)}`);
    return null;
  }
  return raw;
}

function readArray(raw: unknown, path: string, sink: Sink): unknown[] | null {
  if (!Array.isArray(raw)) {
    sink.error(path, `需要数组，实际是${describe(raw)}`);
    return null;
  }
  return raw;
}

function readRange(
  raw: unknown,
  path: string,
  sink: Sink,
  min: number,
  max: number,
): number | null {
  const value = readNumber(raw, path, sink);
  if (value === null) return null;
  if (value < min || value > max) {
    sink.error(path, `需要在 ${min}..${max} 之间，实际是 ${value}`);
    return null;
  }
  return value;
}

/**
 * Parse `[left, top, right, bottom]`.
 *
 * The `right/bottom past the canvas` check doubles as a PARTIAL format guard:
 * a `[x, y, width, height]` mix-up usually pushes an edge past the canvas, and
 * when it does the message names the likely mistake.
 *
 * It cannot catch every case, and pretending otherwise would be worse than the
 * gap. Feeding the shipped viewport in as `[16, 185, 768, 527]` yields
 * `16..768 × 185..527` — a perfectly legal rect. No local rule distinguishes it
 * from an intentional one. What actually protects the layout is the lint test
 * pinning the relationships (`viewport.right === width - safe_margin`,
 * `viewport.bottom === footer.top`); a misreading breaks those instantly.
 */
function readRect(
  raw: unknown,
  path: string,
  sink: Sink,
  canvas: { width: number; height: number },
): Rect | null {
  if (!Array.isArray(raw) || raw.length !== 4) {
    sink.error(path, `需要 [左, 上, 右, 下] 四个数字，实际是${describe(raw)}`);
    return null;
  }
  const values = raw.map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : NaN));
  if (values.some((entry) => Number.isNaN(entry))) {
    sink.error(path, `四个值必须都是有限数字，实际是 ${JSON.stringify(raw)}`);
    return null;
  }
  const [left, top, right, bottom] = values as [number, number, number, number];
  let bad = false;
  if (left < 0 || top < 0) {
    sink.error(path, `左/上边界不能为负（${left}, ${top}）`);
    bad = true;
  }
  if (left >= right || top >= bottom) {
    sink.error(path, `右/下边界必须大于左/上，实际是 [${left}, ${top}, ${right}, ${bottom}]`);
    bad = true;
  }
  if (canvas.width > 0 && canvas.height > 0) {
    if (right > canvas.width || bottom > canvas.height) {
      sink.error(
        path,
        `右/下边界 (${right}, ${bottom}) 超出画布 ${canvas.width}×${canvas.height}；` +
          '本模板的 box 一律是 [左, 上, 右, 下]，若写成了 [x, y, 宽, 高] 请换算',
      );
      bad = true;
    }
  }
  return bad ? null : [left, top, right, bottom];
}

function readSize(raw: unknown, path: string, sink: Sink): Size | null {
  if (!Array.isArray(raw) || raw.length !== 2) {
    sink.error(path, `需要 [宽, 高] 两个数字，实际是${describe(raw)}`);
    return null;
  }
  const [width, height] = raw;
  const w = readNumber(width, `${path}[0]`, sink);
  const h = readNumber(height, `${path}[1]`, sink);
  if (w === null || h === null) return null;
  if (w <= 0 || h <= 0) {
    sink.error(path, `宽高必须为正，实际是 [${w}, ${h}]`);
    return null;
  }
  return [w, h];
}

function readPoint(raw: unknown, path: string, sink: Sink): Point | null {
  if (!Array.isArray(raw) || raw.length !== 2) {
    sink.error(path, `需要 [x, y] 两个数字，实际是${describe(raw)}`);
    return null;
  }
  const x = readNumber(raw[0], `${path}[0]`, sink);
  const y = readNumber(raw[1], `${path}[1]`, sink);
  return x === null || y === null ? null : [x, y];
}

// ---------------------------------------------------------------- canvas

interface CanvasScalars {
  width: number;
  height: number;
  background: string;
  safeMargin: number;
}

function parseCanvasScalars(raw: unknown, sink: Sink): CanvasScalars | null {
  const canvas = readRecord(raw, 'canvas', sink);
  if (!canvas) return null;

  const width = readNumber(canvas.width, 'canvas.width', sink);
  const height = readNumber(canvas.height, 'canvas.height', sink);
  const background = readString(canvas.background, 'canvas.background', sink);
  const safeMargin = readNumber(canvas.safe_margin, 'canvas.safe_margin', sink);

  if (width !== null && width <= 0) {
    sink.error('canvas.width', `必须为正，实际是 ${width}`);
    return null;
  }
  if (height !== null && height <= 0) {
    sink.error('canvas.height', `必须为正，实际是 ${height}`);
    return null;
  }
  if (background !== null && !/^#[0-9a-f]{6}$/i.test(background)) {
    sink.error('canvas.background', `需要 #RRGGBB，实际是 ${background}`);
    return null;
  }
  if (safeMargin !== null) {
    if (safeMargin < 0) {
      sink.error('canvas.safe_margin', `不能为负，实际是 ${safeMargin}`);
      return null;
    }
    const shortest = Math.min(width ?? 0, height ?? 0);
    if (shortest > 0 && safeMargin * 2 >= shortest) {
      sink.error('canvas.safe_margin', `过大：${safeMargin} × 2 ≥ 画布短边 ${shortest}`);
      return null;
    }
  }
  if (width === null || height === null || background === null || safeMargin === null) return null;
  return { width, height, background, safeMargin };
}

function parseReservedZones(
  raw: unknown,
  sink: Sink,
  canvas: CanvasScalars,
): ReservedZone[] {
  if (raw === undefined) {
    sink.warn('canvas.reserved_zones', '未声明保留区，任何槽位都可以铺满画布');
    return [];
  }
  const list = readArray(raw, 'canvas.reserved_zones', sink);
  if (!list) return [];

  const zones: ReservedZone[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const path = `canvas.reserved_zones[${index}]`;
    const zone = readRecord(entry, path, sink);
    if (!zone) return;
    const id = readString(zone.id, `${path}.id`, sink);
    if (id) {
      if (seen.has(id)) sink.error(`${path}.id`, `保留区 id 重复：${id}`);
      seen.add(id);
    }
    const box = readRect(zone.box, `${path}.box`, sink, canvas);
    const avoidRaw = readArray(zone.avoid_for, `${path}.avoid_for`, sink);
    const avoidFor: SlotRole[] = [];
    avoidRaw?.forEach((role, roleIndex) => {
      const path2 = `${path}.avoid_for[${roleIndex}]`;
      const candidate = readString(role, path2, sink);
      if (!candidate) return;
      if (!SLOT_ROLES.includes(candidate as SlotRole)) {
        sink.error(path2, `未知角色 ${candidate}，可用：${SLOT_ROLES.join(' / ')}`);
        return;
      }
      avoidFor.push(candidate as SlotRole);
    });
    if (avoidRaw && avoidFor.length === 0) {
      sink.error(`${path}.avoid_for`, '至少需要一个角色，否则这条保留区没有约束力');
      return;
    }
    if (!id || !box) return;
    zones.push({ id, box, avoidFor });
  });
  return zones;
}

// ---------------------------------------------------------------- text zones

function parseTextZones(raw: unknown, sink: Sink, canvas: CanvasScalars): TextZone[] {
  if (raw === undefined) return [];
  const list = readArray(raw, 'text_zones', sink);
  if (!list) return [];

  const zones: TextZone[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const path = `text_zones[${index}]`;
    const zone = readRecord(entry, path, sink);
    if (!zone) return;
    const id = readString(zone.id, `${path}.id`, sink);
    if (id) {
      if (seen.has(id)) sink.error(`${path}.id`, `文字区 id 重复：${id}`);
      seen.add(id);
    }
    const role = readString(zone.role, `${path}.role`, sink);
    const box = readRect(zone.box, `${path}.box`, sink, canvas);
    const fontStyle = readString(zone.font_style, `${path}.font_style`, sink);
    const alignRaw = readString(zone.align, `${path}.align`, sink);
    let align: TextZone['align'] = 'left';
    if (alignRaw) {
      if (alignRaw !== 'left' && alignRaw !== 'center' && alignRaw !== 'right') {
        sink.error(`${path}.align`, `需要 left / center / right，实际是 ${alignRaw}`);
      } else {
        align = alignRaw;
      }
    }
    const maxLines = readNumber(zone.max_lines, `${path}.max_lines`, sink);
    if (maxLines !== null && (!Number.isInteger(maxLines) || maxLines < 1)) {
      sink.error(`${path}.max_lines`, `需要 ≥1 的整数，实际是 ${maxLines}`);
    }
    if (!id || !role || !box || !fontStyle || maxLines === null) return;
    zones.push({ id, role, box, fontStyle, align, maxLines });
  });
  return zones;
}

// ---------------------------------------------------------------- slots

function parseCloseup(raw: unknown, path: string, sink: Sink, canvas: CanvasScalars): CloseupSpec | null {
  const spec = readRecord(raw, path, sink);
  if (!spec) return null;

  const viewport = readRect(spec.viewport, `${path}.viewport`, sink, canvas);
  const zoom = readNumber(spec.zoom, `${path}.zoom`, sink);
  if (zoom !== null && zoom <= 0) sink.error(`${path}.zoom`, `必须为正，实际是 ${zoom}`);

  const anchorRaw = readString(spec.anchor, `${path}.anchor`, sink);
  if (anchorRaw && anchorRaw !== 'top_center') {
    sink.error(`${path}.anchor`, `目前只支持 top_center，实际是 ${anchorRaw}`);
  }

  const fitRaw = readString(spec.fit, `${path}.fit`, sink);
  if (fitRaw && fitRaw !== 'height' && fitRaw !== 'width') {
    sink.error(`${path}.fit`, `需要 height / width，实际是 ${fitRaw}`);
  }

  const centerX = readNumber(spec.center_x, `${path}.center_x`, sink);
  if (centerX !== null && (centerX < 0 || centerX > canvas.width)) {
    sink.error(`${path}.center_x`, `需要落在 0..${canvas.width}，实际是 ${centerX}`);
  }

  // Rejected loudly rather than ignored: an unimplemented clip would render a
  // close-up that bleeds over the package box, and it would look like a template
  // authoring mistake instead of a missing feature.
  if (spec.clip_to_viewport !== undefined && typeof spec.clip_to_viewport !== 'boolean') {
    sink.error(`${path}.clip_to_viewport`, `需要布尔值，实际是${describe(spec.clip_to_viewport)}`);
  }
  const clipToViewport = spec.clip_to_viewport === true;
  if (clipToViewport) {
    sink.error(`${path}.clip_to_viewport`, '尚不支持 true（需要 Konva clip 组）；请改为 false 或用 reserved_zones 表达');
  }

  if (!viewport || zoom === null || !anchorRaw || !fitRaw || centerX === null) return null;
  return {
    viewport,
    fit: fitRaw as 'height' | 'width',
    zoom,
    anchor: 'top_center',
    centerX,
    clipToViewport,
  };
}

function parseVariants(
  raw: unknown,
  path: string,
  sink: Sink,
  canvas: CanvasScalars,
): BoxVariant[] {
  const list = readArray(raw, path, sink);
  if (!list) return [];
  if (list.length === 0) {
    sink.error(path, '至少需要一个 variant，否则这个槽位无从摆放');
    return [];
  }
  const variants: BoxVariant[] = [];
  list.forEach((entry, index) => {
    const variantPath = `${path}[${index}]`;
    const variant = readRecord(entry, variantPath, sink);
    if (!variant) return;
    const center = readPoint(variant.center, `${variantPath}.center`, sink);
    const maxSize = readSize(variant.max_size, `${variantPath}.max_size`, sink);
    if (center && (center[0] < 0 || center[0] > canvas.width || center[1] < 0 || center[1] > canvas.height)) {
      sink.error(`${variantPath}.center`, `中心点必须落在画布内，实际是 [${center[0]}, ${center[1]}]`);
      return;
    }
    if (maxSize && (maxSize[0] > canvas.width || maxSize[1] > canvas.height)) {
      sink.error(`${variantPath}.max_size`, `上限 ${maxSize[0]}×${maxSize[1]} 超出画布 ${canvas.width}×${canvas.height}`);
      return;
    }
    if (!center || !maxSize) return;
    variants.push({ center, maxSize });
  });
  return variants;
}

function parseFallbacks(raw: unknown, path: string, sink: Sink): SlotFallback[] {
  if (raw === undefined) return [];
  const list = readArray(raw, path, sink);
  if (!list) return [];

  const fallbacks: SlotFallback[] = [];
  list.forEach((entry, index) => {
    const fallbackPath = `${path}[${index}]`;
    const fallback = readRecord(entry, fallbackPath, sink);
    if (!fallback) return;
    const kindRaw = readString(fallback.kind, `${fallbackPath}.kind`, sink);
    if (!kindRaw) return;
    if (!FALLBACK_KINDS.includes(kindRaw as SlotFallback['kind'])) {
      sink.error(`${fallbackPath}.kind`, `未知兜底方式 ${kindRaw}，可用：${FALLBACK_KINDS.join(' / ')}`);
      return;
    }
    switch (kindRaw as SlotFallback['kind']) {
      case 'secondary_view':
        fallbacks.push({ kind: 'secondary_view' });
        return;
      case 'drop':
        fallbacks.push({ kind: 'drop' });
        return;
      case 'mirrored_copy': {
        const of = readString(fallback.of, `${fallbackPath}.of`, sink);
        if (of && of !== 'hero') sink.error(`${fallbackPath}.of`, `目前只支持 hero，实际是 ${of}`);
        const opacity = readRange(fallback.opacity, `${fallbackPath}.opacity`, sink, 0, 1);
        if (!of || opacity === null) return;
        fallbacks.push({ kind: 'mirrored_copy', of: 'hero', opacity });
        return;
      }
      case 'plate': {
        const fill = readString(fallback.fill, `${fallbackPath}.fill`, sink);
        if (fill && !/^#[0-9a-f]{6}$/i.test(fill)) {
          sink.error(`${fallbackPath}.fill`, `需要 #RRGGBB，实际是 ${fill}`);
          return;
        }
        const cornerRadius = readNumber(fallback.corner_radius, `${fallbackPath}.corner_radius`, sink);
        if (cornerRadius !== null && cornerRadius < 0) {
          sink.error(`${fallbackPath}.corner_radius`, `不能为负，实际是 ${cornerRadius}`);
          return;
        }
        const carriesRaw = fallback.carries;
        let carries: 'model_code' | null = null;
        if (carriesRaw !== undefined && carriesRaw !== null) {
          const value = readString(carriesRaw, `${fallbackPath}.carries`, sink);
          if (value && value !== 'model_code') {
            sink.error(`${fallbackPath}.carries`, `目前只支持 model_code，实际是 ${value}`);
            return;
          }
          carries = 'model_code';
        }
        if (!fill || cornerRadius === null) return;
        fallbacks.push({ kind: 'plate', fill, cornerRadius, carries });
        return;
      }
      default:
        return;
    }
  });
  return fallbacks;
}

function parseSourceSelection(
  raw: unknown,
  path: string,
  sink: Sink,
): SlotSourceSelection | undefined {
  if (raw === undefined) return undefined;
  const record = readRecord(raw, path, sink);
  if (!record) return undefined;

  const strings = (value: unknown, at: string): string[] => {
    const list = readArray(value, at, sink);
    if (!list) return [];
    const out: string[] = [];
    list.forEach((entry, index) => {
      const text = readString(entry, `${at}[${index}]`, sink);
      if (text) out.push(text);
    });
    return out;
  };

  const expectedClass = record.expected_class === undefined ? undefined : readString(record.expected_class, `${path}.expected_class`, sink) ?? undefined;
  const productMatch = record.product_match === undefined ? undefined : readString(record.product_match, `${path}.product_match`, sink) ?? undefined;
  return {
    ...(productMatch ? { productMatch } : {}),
    ...(expectedClass ? { expectedClass } : {}),
    viewTypes: strings(record.view_type, `${path}.view_type`),
    framing: strings(record.framing, `${path}.framing`),
    prefer: strings(record.prefer, `${path}.prefer`),
    exclude: strings(record.exclude, `${path}.exclude`),
  };
}

function parseSlots(raw: unknown, sink: Sink, canvas: CanvasScalars): TemplateSlot[] {
  const list = readArray(raw, 'slots', sink);
  if (!list) return [];

  const slots: TemplateSlot[] = [];
  const seenIds = new Set<string>();
  const seenZ = new Map<number, string>();

  list.forEach((entry, index) => {
    const path = `slots[${index}]`;
    const slot = readRecord(entry, path, sink);
    if (!slot) return;

    const id = readString(slot.id, `${path}.id`, sink);
    if (id) {
      if (seenIds.has(id)) sink.error(`${path}.id`, `槽位 id 重复：${id}`);
      seenIds.add(id);
    }

    const roleRaw = readString(slot.role, `${path}.role`, sink);
    let role: SlotRole | null = null;
    if (roleRaw) {
      if (!SLOT_ROLES.includes(roleRaw as SlotRole)) {
        sink.error(`${path}.role`, `未知角色 ${roleRaw}，可用：${SLOT_ROLES.join(' / ')}`);
      } else {
        role = roleRaw as SlotRole;
      }
    }

    const required = readBoolean(slot.required, `${path}.required`, sink, false);
    const maxItems = readNumber(slot.max_items, `${path}.max_items`, sink);
    if (maxItems !== null && (!Number.isInteger(maxItems) || maxItems < 1)) {
      sink.error(`${path}.max_items`, `需要 ≥1 的整数，实际是 ${maxItems}`);
    }

    const zIndex = readNumber(slot.z_index, `${path}.z_index`, sink);
    if (zIndex !== null) {
      const taken = seenZ.get(zIndex);
      if (taken !== undefined) {
        sink.error(`${path}.z_index`, `z_index ${zIndex} 已被 ${taken} 占用；重复会让绘制顺序不确定`);
      } else {
        seenZ.set(zIndex, id ?? path);
      }
    }

    const closeupRaw = slot.closeup;
    const closeup = closeupRaw === undefined ? undefined : parseCloseup(closeupRaw, `${path}.closeup`, sink, canvas) ?? undefined;
    const variantsRaw = slot.variants;
    const variants = variantsRaw === undefined ? undefined : parseVariants(variantsRaw, `${path}.variants`, sink, canvas);
    const fallbacks = parseFallbacks(slot.fallbacks, `${path}.fallbacks`, sink);
    const sourceSelection = parseSourceSelection(slot.source_selection, `${path}.source_selection`, sink);

    const hasCloseup = closeup !== undefined;
    const hasVariants = (variants?.length ?? 0) > 0;
    if (!hasCloseup && !hasVariants) {
      sink.error(path, '槽位必须声明 closeup 或 variants 才能产出几何；只有 fallbacks 无法摆放');
      return;
    }
    if (role === 'hero' && !hasCloseup) {
      sink.error(path, '角色为 hero 的槽位需要 closeup（取景 + 缩放规则）');
      return;
    }

    if (!id || !role || maxItems === null || zIndex === null) return;
    slots.push({
      id,
      role,
      required,
      maxItems,
      zIndex,
      closeup,
      variants,
      fallbacks,
      ...(sourceSelection ? { sourceSelection } : {}),
    });
  });

  if (list.length > 0 && slots.length === 0) {
    sink.error('slots', '没有任何槽位通过校验，模板无法使用');
  }
  return slots;
}

// ---------------------------------------------------------------- rules

function parseRules(raw: unknown, sink: Sink): TemplateRules | null {
  const rules = readRecord(raw, 'rules', sink);
  if (!rules) return null;

  const dominanceRaw = readRecord(rules.hero_dominance, 'rules.hero_dominance', sink);
  let heroDominance: HeroDominanceRule | null = null;
  if (dominanceRaw) {
    const min = readRange(dominanceRaw.min_canvas_occupancy, 'rules.hero_dominance.min_canvas_occupancy', sink, 0, 1);
    const targetRaw = readArray(dominanceRaw.target_canvas_occupancy, 'rules.hero_dominance.target_canvas_occupancy', sink);
    let target: [number, number] | null = null;
    if (targetRaw && targetRaw.length === 2) {
      const low = readRange(targetRaw[0], 'rules.hero_dominance.target_canvas_occupancy[0]', sink, 0, 1);
      const high = readRange(targetRaw[1], 'rules.hero_dominance.target_canvas_occupancy[1]', sink, 0, 1);
      if (low !== null && high !== null) {
        if (low > high) {
          sink.error('rules.hero_dominance.target_canvas_occupancy', `区间必须是 [小, 大]，实际是 [${low}, ${high}]`);
        } else if (min !== null && min > high) {
          sink.error('rules.hero_dominance', `下限 ${min} 高于目标区间上限 ${high}，永远无法同时满足`);
        } else {
          target = [low, high];
        }
      }
    } else if (targetRaw) {
      sink.error('rules.hero_dominance.target_canvas_occupancy', `需要两个数字，实际 ${targetRaw.length} 个`);
    }
    if (min !== null && target) heroDominance = { minCanvasOccupancy: min, targetCanvasOccupancy: target };
  }

  // Two spellings of the same rule: `collision.prevent_alpha_overlap` and
  // `collage.allow_alpha_overlap` (the inverse). Both are accepted because the
  // collage dialect states it the positive way —「允许重叠」— and rewriting a
  // template just to flip a boolean invites getting the meaning wrong.
  const collisionKey = rules.collision !== undefined ? 'rules.collision' : 'rules.collage';
  const collisionRaw = readRecord(rules.collision ?? rules.collage, collisionKey, sink);
  let collision: CollisionRule | null = null;
  if (collisionRaw) {
    const prevent =
      collisionRaw.allow_alpha_overlap !== undefined
        ? !readBoolean(collisionRaw.allow_alpha_overlap, `${collisionKey}.allow_alpha_overlap`, sink, true)
        : readBoolean(collisionRaw.prevent_alpha_overlap, `${collisionKey}.prevent_alpha_overlap`, sink, false);
    const gap = readRange(collisionRaw.min_gap_px, `${collisionKey}.min_gap_px`, sink, 0, Number.MAX_SAFE_INTEGER);
    if (gap !== null) collision = { preventAlphaOverlap: prevent, minGapPx: gap };
  }

  // Only read the record when it exists: `readRecord(undefined, …)` records a
  // "missing" error, and a rule that has a default must not report one.
  const shadowRaw = rules.shadow === undefined ? null : readRecord(rules.shadow, 'rules.shadow', sink);
  let shadow: ShadowRule | null = null;
  if (rules.shadow === undefined) {
    // A collage has no package and no drop shadow; making it restate the two
    // package-era rules just to get through the parser would be noise. Absent
    // means "off", and the warning says so out loud.
    sink.warn('rules.shadow', '未声明，按「不投影」处理（图片图层目前也不渲染阴影）');
    shadow = { enabled: false, opacity: 40, blur: 5, offset: [4, 6] };
  } else if (shadowRaw) {
    const enabled = readBoolean(shadowRaw.enabled, 'rules.shadow.enabled', sink, false);
    const opacity = readRange(shadowRaw.opacity, 'rules.shadow.opacity', sink, 0, 100);
    const blur = readRange(shadowRaw.blur, 'rules.shadow.blur', sink, 0, 200);
    const offset = readPoint(shadowRaw.offset, 'rules.shadow.offset', sink);
    if (opacity !== null && blur !== null && offset) {
      shadow = { enabled, opacity, blur, offset };
      if (enabled) {
        // Kept as a warning, not an error: the geometry is unaffected, only the
        // look. `emit-layers` currently has no shadow support on image layers.
        sink.warn('rules.shadow.enabled', '模板启用了阴影，但图片图层目前不渲染阴影，本次会被忽略');
      }
    }
  }

  const readabilityRaw =
    rules.package_readability === undefined
      ? null
      : readRecord(rules.package_readability, 'rules.package_readability', sink);
  let packageReadability: TemplateRules['packageReadability'] | null = null;
  if (rules.package_readability === undefined) {
    // No box slot → nothing to read. Default to "not required" and skip the
    // per-field warning; the missing block is the statement.
    packageReadability = { required: false, minVisibleRatio: DEFAULT_PACKAGE_VISIBLE_RATIO };
  } else if (readabilityRaw) {
    const required = readBoolean(readabilityRaw.required, 'rules.package_readability.required', sink, false);
    let minVisibleRatio = DEFAULT_PACKAGE_VISIBLE_RATIO;
    if (readabilityRaw.min_visible_ratio === undefined) {
      sink.warn(
        'rules.package_readability.min_visible_ratio',
        `未声明，使用默认 ${DEFAULT_PACKAGE_VISIBLE_RATIO}（可在模板里覆盖）`,
      );
    } else {
      const parsed = readRange(readabilityRaw.min_visible_ratio, 'rules.package_readability.min_visible_ratio', sink, 0, 1);
      if (parsed === null) return null;
      minVisibleRatio = parsed;
    }
    packageReadability = { required, minVisibleRatio };
  }

  const textRaw = rules.text === undefined ? null : readRecord(rules.text, 'rules.text', sink);
  let text: TemplateRules['text'] | null = null;
  if (rules.text === undefined) {
    sink.warn('rules.text', '未声明，按「文字不压主体、白底用黑字」处理');
    text = { keepClearOfHero: true, preferBlackOnWhite: true };
  } else if (textRaw) {
    text = {
      keepClearOfHero: readBoolean(textRaw.keep_clear_of_hero, 'rules.text.keep_clear_of_hero', sink, true),
      preferBlackOnWhite: readBoolean(textRaw.prefer_black_on_white, 'rules.text.prefer_black_on_white', sink, true),
    };
  }

  if (!heroDominance || !collision || !shadow || !packageReadability || !text) return null;
  const renderOrder = parseRenderOrder(rules.collision ?? rules.collage, collisionKey, sink);
  const cascade = parseCascade(rules.cascade, sink);
  return {
    heroDominance,
    collision,
    shadow,
    packageReadability,
    text,
    ...(renderOrder ? { renderOrder } : {}),
    ...(cascade ? { cascade } : {}),
  };
}

/**
 * `rules.cascade`: 谁挡谁、最大的站哪、留白齐不齐。
 *
 * 整块可选 —— 没有它的模板（hero/包装盒那套）行为一个字都不变。写了就必须四个字段都写全：
 * 这组规则直接决定三个姿态怎么叠，猜错一半会让"挡脸"时好时坏，比不写更难查。
 */
function parseCascade(raw: unknown, sink: Sink): TemplateRules['cascade'] {
  if (raw === undefined) return undefined;
  const record = readRecord(raw, 'rules.cascade', sink);
  if (!record) return undefined;
  const protectHead = readRange(record.protect_head, 'rules.cascade.protect_head', sink, 0, 1);
  const centerLargest = readBoolean(record.center_largest, 'rules.cascade.center_largest', sink, true);
  const balanceMargins = readBoolean(record.balance_margins, 'rules.cascade.balance_margins', sink, true);
  const maxShift = readRange(record.max_shift, 'rules.cascade.max_shift', sink, 0, 0.5);
  if (protectHead === null || maxShift === null) return undefined;
  return { protectHead, centerLargest, balanceMargins, maxShift };
}

/**
 * `rules.collage.render_order`: slot ids back to front.
 *
 * The planner uses it instead of `z_index` for the picture layers, so a designer
 * can reorder the collage in one list. Ids are checked against the template's
 * slots by `crossCheck` — a typo here would otherwise silently fall back to
 * `z_index` and look like the field is ignored.
 */
function parseRenderOrder(raw: unknown, path: string, sink: Sink): readonly string[] | undefined {
  const record = readRecord(raw, path, sink);
  if (!record || record.render_order === undefined) return undefined;
  const list = readArray(record.render_order, `${path}.render_order`, sink);
  if (!list) return undefined;
  const out: string[] = [];
  list.forEach((entry, index) => {
    const text = readString(entry, `${path}.render_order[${index}]`, sink);
    if (text && !out.includes(text)) out.push(text);
  });
  if (out.length === 0) {
    sink.error(`${path}.render_order`, 'render_order 不能为空数组；想按 z_index 排就不要写这个字段');
    return undefined;
  }
  return out;
}

// ---------------------------------------------------------------- cross checks

/**
 * Every rect a slot occupies when it is filled, at its most generous extent.
 *
 * For a `closeup` slot that is the viewport (the zoomed content spills past it,
 * but the viewport is the declared footprint); for a `variants` slot it is each
 * candidate box. Shared with the solver so template lint and runtime layout can
 * never disagree about "where does this slot live".
 */
export function slotFootprints(slot: TemplateSlot): Rect[] {
  const rects: Rect[] = [];
  if (slot.closeup) rects.push(slot.closeup.viewport);
  for (const variant of slot.variants ?? []) {
    rects.push(rectFromCenter(variant.center, variant.maxSize));
  }
  return rects;
}

function crossCheck(template: LayoutTemplate, sink: Sink): void {
  const { width, height, safeMargin, reservedZones } = template.canvas;
  const safe: Rect = [safeMargin, safeMargin, width - safeMargin, height - safeMargin];

  const renderOrder = template.rules.renderOrder;
  if (renderOrder) {
    const known = new Set(template.slots.map((slot) => slot.id));
    renderOrder.forEach((id, index) => {
      if (!known.has(id)) {
        sink.error(`rules.render_order[${index}]`, `没有 id 为 ${id} 的槽位（拼写错误会让排序悄悄退回 z_index）`);
      }
    });
  }

  for (const slot of template.slots) {
    const footprints = slotFootprints(slot);
    for (const rect of footprints) {
      if (rect[0] < safe[0] || rect[1] < safe[1] || rect[2] > safe[2] || rect[3] > safe[3]) {
        sink.error(
          `slots.${slot.id}`,
          `几何 ${formatRect(rect)} 超出安全边距 ${safeMargin}px（可用区 ${formatRect(safe)}）`,
        );
      }
    }
    for (const zone of reservedZones) {
      if (!zone.avoidFor.includes(slot.role)) continue;
      for (const rect of footprints) {
        if (rectsIntersect(rect, zone.box)) {
          sink.error(
            `slots.${slot.id}`,
            `与保留区 ${zone.id} ${formatRect(zone.box)} 重叠；该保留区的 avoid_for 包含 ${slot.role}`,
          );
        }
      }
    }
  }

  const hero = template.slots.find((slot) => slot.role === 'hero');
  if (hero?.closeup && template.rules.text.keepClearOfHero) {
    for (const zone of template.textZones) {
      if (rectsIntersect(zone.box, hero.closeup.viewport)) {
        sink.error(
          `text_zones.${zone.id}`,
          `与 hero 取景框 ${formatRect(hero.closeup.viewport)} 重叠，但 rules.text.keep_clear_of_hero 为 true`,
        );
      }
    }
  }

  // Warning rather than error: covering the model code with another image is a
  // bad idea, but it is a design choice the template author may want to test.
  for (const slot of template.slots) {
    if (slot.role === 'hero') continue;
    for (const rect of slotFootprints(slot)) {
      for (const zone of template.textZones) {
        if (rectsIntersect(rect, zone.box)) {
          sink.warn(
            `slots.${slot.id}`,
            `与文字区 ${zone.id} ${formatRect(zone.box)} 重叠，编号可能被盖住`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------- entry point

const KNOWN_ROOT_KEYS = new Set(['id', 'version', 'status', 'canvas', 'text_zones', 'slots', 'rules']);

export function parseLayoutTemplate(raw: unknown): TemplateParseResult {
  const sink = new Sink();

  if (!isRecord(raw)) {
    sink.error('', `模板根节点必须是对象，实际是${describe(raw)}`);
    return { template: null, issues: sink.issues, warnings: sink.warnings };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ROOT_KEYS.has(key)) {
      sink.warn(key, `未知顶层字段 ${key}，已忽略（拼写错误不会报错，请自行确认）`);
    }
  }

  const id = readString(raw.id, 'id', sink);
  const version = readString(raw.version, 'version', sink);

  let status: TemplateStatus = 'draft';
  const statusRaw = readString(raw.status, 'status', sink);
  if (statusRaw) {
    if (!TEMPLATE_STATUSES.includes(statusRaw as TemplateStatus)) {
      sink.error('status', `需要 ${TEMPLATE_STATUSES.join(' / ')}，实际是 ${statusRaw}`);
    } else {
      status = statusRaw as TemplateStatus;
      if (status === 'draft') {
        sink.warn('status', '模板 status=draft：可以生成，但版式还会变，不要当作稳定结果');
      }
    }
  }

  const canvas = parseCanvasScalars(raw.canvas, sink);
  const reservedZones = canvas ? parseReservedZones((raw.canvas as Record<string, unknown>).reserved_zones, sink, canvas) : [];
  const textZones = canvas ? parseTextZones(raw.text_zones, sink, canvas) : [];
  const slots = canvas ? parseSlots(raw.slots, sink, canvas) : [];
  const rules = parseRules(raw.rules, sink);

  if (!canvas || !rules || !id || !version || sink.failed) {
    return { template: null, issues: sink.issues, warnings: sink.warnings };
  }

  const template: LayoutTemplate = {
    id,
    version,
    status,
    canvas: {
      width: canvas.width,
      height: canvas.height,
      background: canvas.background,
      safeMargin: canvas.safeMargin,
      reservedZones,
    },
    textZones,
    slots,
    rules,
  };

  crossCheck(template, sink);
  if (sink.failed) return { template: null, issues: sink.issues, warnings: sink.warnings };

  return { template, issues: sink.issues, warnings: sink.warnings };
}

/** Throw on an invalid template — for call sites that cannot proceed with nothing. */
export function parseLayoutTemplateOrThrow(raw: unknown): LayoutTemplate {
  const result = parseLayoutTemplate(raw);
  if (!result.template) {
    const detail = result.issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ');
    throw new Error(`模板校验失败：${detail}`);
  }
  return result.template;
}
