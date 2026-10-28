export type BadgeKind = 'ok' | 'bad' | 'warn' | 'info' | 'idle';

const GLYPH: Record<BadgeKind, string> = {
  ok: '✓',
  bad: '!',
  warn: '!',
  info: 'i',
  idle: '·',
};

export interface StatusBadgeProps {
  kind: BadgeKind;
  label: string;
  title?: string;
}

/**
 * 紧凑状态标识。
 *
 * 图标是装饰（`aria-hidden`），状态靠**文字**表达——只变颜色的话，色觉差异或者
 * 打印出来就什么都没说。这也正好对上"状态不只靠颜色"那条要求。
 */
export function StatusBadge({ kind, label, title }: StatusBadgeProps): JSX.Element {
  return (
    <span className={`opt-badge opt-badge--${kind}`} title={title}>
      <span className="opt-badge__glyph" aria-hidden="true">
        {GLYPH[kind]}
      </span>
      {label}
    </span>
  );
}
