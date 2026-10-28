import { DEFAULT_VISION_BASE_URL, DEFAULT_VISION_MODEL, MAX_VISION_ENDPOINTS } from '../../shared/constants';
import type { VisionEndpoint } from '../../services/settings';
import { Card } from '../components/Card';
import { Drawer } from '../components/Drawer';
import { Notice } from '../components/Notice';
import { StatusBadge } from '../components/StatusBadge';
import { endpointHost, endpointLabel } from '../helpers';

export interface VisionTestResult {
  kind: 'ok' | 'bad';
  text: string;
  at: number;
}

export interface VisionSectionProps {
  endpoints: readonly VisionEndpoint[];
  editingIndex: number | null;
  editing: VisionEndpoint | null;
  busy: boolean;
  dirty: boolean;
  testingIndex: number | null;
  testResults: Readonly<Record<number, VisionTestResult>>;
  status: { kind: 'ok' | 'bad' | 'idle'; text: string } | null;
  onEdit: (index: number | null) => void;
  onUpdate: (index: number, patch: Partial<VisionEndpoint>) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onTest: (index: number) => void;
  onSave: () => void;
}

/**
 * AI 视觉接口。
 *
 * 列表本体只回答三件事：这条是谁（主/备 + 主机名）、它现在能不能用（上次测试结果）、
 * 怎么改（编辑抽屉）。地址、模型、Key 这些"填的时候才关心"的东西全部收进抽屉——
 * 三个网关的九个输入框常驻在页面上，会让这份一年改两次的配置看起来像必须填的表。
 */
export function VisionSection({
  endpoints,
  editingIndex,
  editing,
  busy,
  dirty,
  testingIndex,
  testResults,
  status,
  onEdit,
  onUpdate,
  onAdd,
  onRemove,
  onTest,
  onSave,
}: VisionSectionProps): JSX.Element {
  const order = endpoints.map((endpoint, index) => endpointLabel(endpoint, index)).join(' → ');

  return (
    <Card
      title="AI 视觉接口"
      summary={
        <>
          <span>
            {endpoints.length} 个接口 · {order}
          </span>
        </>
      }
      actions={
        <button type="button" disabled={busy || endpoints.length >= MAX_VISION_ENDPOINTS} onClick={onAdd}>
          + 添加接口
        </button>
      }
    >
      {endpoints.length === 0 ? (
        <div className="opt-empty">还没有配置接口。点右上角「+ 添加接口」填一个地址即可。</div>
      ) : (
        <div className="opt-list">
          {endpoints.map((endpoint, index) => {
            const result = testResults[index];
            const empty = endpoint.baseUrl.trim().length === 0;
            return (
              <div className="opt-endpoint" key={index}>
                <span className="opt-endpoint__index">{index === 0 ? '主' : `备${index + 1}`}</span>
                <div className="opt-endpoint__main">
                  <span className="opt-endpoint__host">{endpointHost(endpoint)}</span>
                  <span className="opt-hint opt-hint--tight">
                    {empty
                      ? '还没填地址，保存时会被丢掉'
                      : `${endpoint.model.trim() ? `模型 ${endpoint.model.trim()}` : '模型继承主接口'} · ${
                          endpoint.apiKey.trim() ? '自带 Key' : 'Key 继承主接口'
                        }`}
                  </span>
                </div>
                {result ? (
                  <StatusBadge
                    kind={result.kind === 'ok' ? 'ok' : 'bad'}
                    label={result.text}
                    title={new Date(result.at).toLocaleString()}
                  />
                ) : (
                  <StatusBadge kind="idle" label="未测试" />
                )}
                <button type="button" disabled={busy || testingIndex !== null || empty} onClick={() => onTest(index)}>
                  {testingIndex === index ? '测试中…' : '测试'}
                </button>
                <button type="button" disabled={busy} onClick={() => onEdit(index)}>
                  编辑
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="opt-hint">
        编辑器里点「AI 识别素材角色」时会按这个顺序逐个尝试：连不上、超时、鉴权失败、返回不是
        JSON 都算失败，自动换下一个；全部失败才回退到标题关键词匹配，不影响其他功能。
      </p>

      {status ? (
        <Notice
          kind={status.kind === 'bad' ? 'error' : 'ok'}
          summary={status.text}
          details={status.kind === 'bad' ? '详细原因见浏览器控制台，或到「账号连接 → 技术说明」核对接口地址。' : null}
        />
      ) : null}

      <Drawer
        open={editingIndex !== null && editing !== null}
        title={editingIndex === null ? '编辑接口' : endpointLabel(editing ?? { baseUrl: '', model: '', apiKey: '' }, editingIndex)}
        onClose={() => onEdit(null)}
        footer={
          <>
            <button
              type="button"
              disabled={busy || editingIndex === null || (editing?.baseUrl.trim().length ?? 0) === 0}
              onClick={() => {
                if (editingIndex !== null) onTest(editingIndex);
              }}
            >
              {testingIndex !== null ? '测试中…' : '测试连接'}
            </button>
            <span className="opt-spacer" />
            {endpoints.length > 1 && editingIndex !== null ? (
              <button
                type="button"
                className="opt-link opt-link--danger"
                disabled={busy}
                onClick={() => onRemove(editingIndex)}
                title="从链里移除这个接口"
              >
                移除
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => onEdit(null)}>
              关闭
            </button>
            <button type="button" className="primary" disabled={busy || !dirty} onClick={onSave}>
              保存视觉设置
            </button>
          </>
        }
      >
        {editing !== null && editingIndex !== null ? (
          <>
            <div className="opt-field">
              <label htmlFor="vision-base-url">接口地址</label>
              <input
                id="vision-base-url"
                value={editing.baseUrl}
                spellCheck={false}
                onChange={(event) => onUpdate(editingIndex, { baseUrl: event.target.value })}
                placeholder={
                  editingIndex === 0
                    ? DEFAULT_VISION_BASE_URL
                    : 'http://127.0.0.1:8788/v1（另一台机器 / 备用网关）'
                }
              />
              <small>OpenAI 兼容的 /v1 地址；请求会打到它的 /chat/completions。</small>
            </div>

            <div className="opt-field">
              <label htmlFor="vision-model">视觉模型</label>
              <input
                id="vision-model"
                value={editing.model}
                spellCheck={false}
                onChange={(event) => onUpdate(editingIndex, { model: event.target.value })}
                placeholder={
                  editingIndex === 0
                    ? DEFAULT_VISION_MODEL
                    : `留空 = 继承主接口（${endpoints[0]?.model.trim() || DEFAULT_VISION_MODEL}）`
                }
              />
              <small>需要支持多图输入与 JSON 输出。留空就用主接口的模型。</small>
            </div>

            <div className="opt-field">
              <label htmlFor="vision-api-key">接口 Key</label>
              <input
                id="vision-api-key"
                type="password"
                value={editing.apiKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => onUpdate(editingIndex, { apiKey: event.target.value })}
                placeholder={
                  editingIndex === 0 ? '留空 = 使用构建期内置的默认 Key' : '留空 = 继承主接口的 Key'
                }
              />
              <small>
                只在这里输入，页面其它地方不会显示。本地网关不校验 Key 时留空即可。
              </small>
            </div>

            <p className="opt-hint">
              这里改的是草稿：点下面的「保存视觉设置」或页面底部的「保存更改」才会写进存储。
              「测试连接」会真发一条很短的请求，会消耗一次 token。
            </p>
          </>
        ) : null}
      </Drawer>
    </Card>
  );
}
