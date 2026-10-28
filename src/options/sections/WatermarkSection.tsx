import { useState } from 'react';
import type { RefObject } from 'react';
import type { WatermarkMeta } from '../../shared/types';
import { Card } from '../components/Card';
import { Notice } from '../components/Notice';
import { Pager } from '../components/Pager';
import { StatusBadge } from '../components/StatusBadge';

const PAGE_SIZE = 10;

export interface WatermarkSectionProps {
  watermarks: WatermarkMeta[];
  names: Record<string, string>;
  thumbs: Record<string, string>;
  busy: boolean;
  status: { kind: 'ok' | 'bad' | 'idle'; text: string } | null;
  sizeLimitMb: number;
  accept: string;
  fileInputRef: RefObject<HTMLInputElement>;
  onAdd: (file: File | undefined) => void;
  onNameChange: (id: string, value: string) => void;
  onRename: (id: string) => void;
  onSetDefault: (id: string) => void;
  onRemove: (meta: WatermarkMeta) => void;
}

/**
 * 水印框。
 *
 * 默认视图只有一句摘要加一张缩略图——"现在用的是哪个水印"是一眼的事，而上传/改名/
 * 设默认/删除是一年几次的事。列表折进「管理水印」，用原生 `<details>`（键盘可用、无 JS）。
 */
export function WatermarkSection({
  watermarks,
  names,
  thumbs,
  busy,
  status,
  sizeLimitMb,
  accept,
  fileInputRef,
  onAdd,
  onNameChange,
  onRename,
  onSetDefault,
  onRemove,
}: WatermarkSectionProps): JSX.Element {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(watermarks.length / PAGE_SIZE));
  // 删到当前页不存在时也不能渲染空页：夹一下，不额外存状态。
  const safePage = Math.min(page, pageCount - 1);
  const visible = watermarks.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const active = watermarks.find((meta) => meta.isDefault) ?? watermarks[0] ?? null;

  return (
    <Card
      title="水印框"
      summary={
        <>
          <span>{watermarks.length} 个</span>
          {active ? (
            <span style={{ marginLeft: 8 }}>
              默认：{active.name}（{active.width}×{active.height}）
            </span>
          ) : (
            <span style={{ marginLeft: 8 }}>还没有水印框</span>
          )}
        </>
      }
    >
      {active ? (
        <div className="opt-watermark">
          <span className="opt-row__thumb">
            {thumbs[active.id] ? (
              <img src={thumbs[active.id]} alt="" />
            ) : (
              <span className="opt-row__thumb-empty">无图</span>
            )}
          </span>
          <div className="opt-row__main">
            <span className="opt-row__title">{active.name}</span>
            <span className="opt-row__sub">
              {active.width}×{active.height} · 打开编辑器时作为锁定图层放在最上层
            </span>
          </div>
          <StatusBadge kind="ok" label="当前默认" />
        </div>
      ) : (
        <div className="opt-empty">还没有水印框。展开下面的「管理水印」上传一张即可，第一张会自动成为默认水印。</div>
      )}

      <details className="opt-details">
        <summary>管理水印（上传 / 改名 / 设默认 / 删除）</summary>
        <div className="opt-details__body">
          <div className="opt-field">
            <label htmlFor="watermark-file">添加水印框</label>
            <input
              id="watermark-file"
              ref={fileInputRef}
              type="file"
              accept={accept}
              disabled={busy}
              onChange={(event) => onAdd(event.target.files?.[0])}
            />
            <small>
              PNG（可带透明通道，推荐）／JPEG／WebP，单张上限 {sizeLimitMb}MB。图片按「长边铺满 800、
              居中」等比缩放，不拉伸；边框类水印请直接做成正方形。
            </small>
          </div>

          {watermarks.length === 0 ? null : (
            <div className="opt-list">
              {visible.map((meta) => (
                <div className="opt-watermark" key={meta.id}>
                  <span className="opt-row__thumb">
                    {thumbs[meta.id] ? (
                      <img src={thumbs[meta.id]} alt="" />
                    ) : (
                      <span className="opt-row__thumb-empty">无图</span>
                    )}
                  </span>
                  <input
                    className="opt-watermark__field"
                    aria-label={`水印「${meta.name}」的名称`}
                    value={names[meta.id] ?? meta.name}
                    spellCheck={false}
                    onChange={(event) => onNameChange(meta.id, event.target.value)}
                    onBlur={() => onRename(meta.id)}
                  />
                  <span className="opt-row__meta">
                    {meta.width}×{meta.height}
                  </span>
                  <label className="opt-watermark__radio" title="设为默认水印">
                    <input
                      type="radio"
                      name="watermark-default"
                      checked={meta.isDefault}
                      onChange={() => onSetDefault(meta.id)}
                    />
                    默认
                  </label>
                  <button type="button" className="opt-link opt-link--danger" onClick={() => onRemove(meta)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

          <Pager page={safePage} pageCount={pageCount} total={watermarks.length} unit="个水印" onChange={setPage} />
        </div>
      </details>

      {status ? (
        <Notice kind={status.kind === 'bad' ? 'error' : 'ok'} summary={status.text} />
      ) : null}
    </Card>
  );
}
