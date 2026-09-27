import type { CutoutStatus, EditorMaterial } from '../../shared/types';
import { MaterialCard } from './MaterialCard';

export interface MaterialPanelProps {
  materials: EditorMaterial[];
  statusByImageId: Record<string, { status: CutoutStatus; error?: string }>;
  onAdd: (material: EditorMaterial) => void;
  onRetry: (imageId: string) => void;
}

export function MaterialPanel({ materials, statusByImageId, onAdd, onRetry }: MaterialPanelProps): JSX.Element {
  const originals = materials.filter((material) => material.kind === 'original');
  const cutouts = materials.filter((material) => material.kind === 'cutout');

  return (
    <aside className="panel">
      <div className="panel__title">
        <span>素材</span>
        <span className="toolbar__hint">点击加入画布</span>
      </div>
      <div className="panel__body">
        <section className="panel__group">
          <h3 className="panel__group-title">
            <span>原始素材</span>
            <span>{originals.length}</span>
          </h3>
          {originals.length === 0 ? (
            <div className="empty">暂无素材：可点「上传图片」，或直接 Ctrl+V 粘贴截图</div>
          ) : (
            <div className="material-grid">
              {originals.map((material) => (
                <MaterialCard key={material.id} material={material} onAdd={onAdd} />
              ))}
            </div>
          )}
        </section>

        <section className="panel__group">
          <h3 className="panel__group-title">
            <span>已抠素材</span>
            <span>{cutouts.length}</span>
          </h3>
          {cutouts.length === 0 ? (
            <div className="empty">抠图完成后会自动出现在这里</div>
          ) : (
            <div className="material-grid">
              {cutouts.map((material) => (
                <MaterialCard key={material.id} material={material} onAdd={onAdd} />
              ))}
            </div>
          )}
        </section>

        <PendingList materials={materials} statusByImageId={statusByImageId} onRetry={onRetry} />
      </div>
    </aside>
  );
}

function PendingList({
  materials,
  statusByImageId,
  onRetry,
}: {
  materials: EditorMaterial[];
  statusByImageId: Record<string, { status: CutoutStatus; error?: string }>;
  onRetry: (imageId: string) => void;
}): JSX.Element | null {
  const pending = materials
    .filter((material) => material.kind === 'original')
    .map((material) => ({ material, entry: statusByImageId[material.imageId] }))
    .filter(({ entry }) => entry && (entry.status !== 'success' || false));

  const inProgress = pending.filter(({ entry }) => entry.status === 'queued' || entry.status === 'uploading' || entry.status === 'processing');
  const failed = pending.filter(({ entry }) => entry.status === 'failed');
  const idle = pending.filter(({ entry }) => entry.status === 'idle');

  if (inProgress.length === 0 && failed.length === 0 && idle.length === 0) return null;

  return (
    <section className="panel__group">
      <h3 className="panel__group-title">
        <span>抠图任务</span>
        <span>{inProgress.length} 进行中</span>
      </h3>
      {inProgress.map(({ material, entry }) => (
        <MaterialCard
          key={`pending-${material.id}`}
          material={material}
          status={entry.status}
          error={entry.error}
          onAdd={() => undefined}
        />
      ))}
      {failed.map(({ material, entry }) => (
        <MaterialCard
          key={`failed-${material.id}`}
          material={material}
          status="failed"
          error={entry.error}
          onAdd={() => undefined}
          onRetry={onRetry}
        />
      ))}
      {idle.map(({ material, entry }) => (
        <MaterialCard
          key={`idle-${material.id}`}
          material={material}
          status="idle"
          error={entry.error}
          onAdd={() => undefined}
        />
      ))}
    </section>
  );
}
