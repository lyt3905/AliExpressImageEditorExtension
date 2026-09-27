import type { CutoutStatus, EditorMaterial } from '../../shared/types';

const STATUS_LABEL: Record<CutoutStatus, string> = {
  idle: '等待抠图',
  queued: '排队中',
  uploading: '上传中',
  processing: '处理中',
  success: '抠图完成',
  failed: '抠图失败',
};

const STATUS_CLASS: Partial<Record<CutoutStatus, string>> = {
  success: 'material-card__status--success',
  failed: 'material-card__status--failed',
};

export interface MaterialCardProps {
  material: EditorMaterial;
  status?: CutoutStatus;
  error?: string;
  onAdd: (material: EditorMaterial) => void;
  onRetry?: (imageId: string) => void;
}

export function MaterialCard({ material, status, error, onAdd, onRetry }: MaterialCardProps): JSX.Element {
  const label = STATUS_LABEL[status ?? 'success'];

  return (
    <div className="material-card">
      <div
        className="material-card__thumb"
        role="button"
        tabIndex={0}
        title="点击加入画布"
        onClick={() => onAdd(material)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onAdd(material);
        }}
      >
        <img src={material.url} alt={material.label} draggable={false} />
      </div>
      <div className="material-card__meta">
        <span>{material.label}</span>
        {status ? <span className={STATUS_CLASS[status] ?? ''}>{label}</span> : null}
      </div>
      {status === 'failed' ? (
        <div className="material-card__error">
          <div>{error ?? '抠图失败'}</div>
          {onRetry ? (
            <button type="button" onClick={() => onRetry(material.imageId)}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
