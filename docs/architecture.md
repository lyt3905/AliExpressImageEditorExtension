# 架构说明

## 1. 三个运行上下文

| 上下文 | 入口 | 职责 |
| --- | --- | --- |
| Service Worker | `src/background/service-worker.ts` | 编排：扫描 → 下载 → 存库 → 开会话 → 打开编辑器；消息路由；`chrome.downloads` |
| Content Script | `src/content/content-script.ts` | 只回答 `SCAN_ACTIVE_TAB`，用 `AliExpressPageAdapter` 扫描页面 |
| Editor / Options 页面 | `src/editor/*`、`src/options/*` | 素材展示、自动抠图、Konva 编辑、导出 |

抠图**不在 Service Worker 里**跑：SW 随时可能被回收，把长任务放在编辑器页面里，SW 生命周期不影响任务。

## 2. 消息协议

统一定义在 `src/shared/messages.ts`，不走复杂 RPC：

```ts
type ExtensionMessage =
  | { type: 'SCAN_ACTIVE_TAB';        requestId: string }
  | { type: 'CREATE_EDITOR_SESSION';  requestId: string; payload: SessionInput }
  | { type: 'DOWNLOAD_COMPOSITE';     requestId: string; payload: ExportInput }
  | { type: 'GET_SETTINGS' | 'SAVE_SETTINGS' | 'GET_AUTH_STATE' | 'LOGIN' | 'LOGOUT' | 'PING'; ... }
```

一律返回：

```ts
interface MessageResponse<T> { requestId: string; ok: boolean; data?: T; error?: { code: string; message: string } }
```

- 路由：`src/background/message-router.ts`（`dispatchMessage` 可单测，异常统一转成错误信封，不泄漏堆栈）。
- **不传 Blob**：`chrome.runtime.sendMessage` 走 JSON 序列化，Blob 会丢失。
  导出时编辑器把 PNG 转成 data URL 传给 SW，由 SW 调用 `chrome.downloads.download`。

## 3. 图片扫描

`src/content/url-normalizer.ts`

- `normalizeImageUrl`：在文件名中**第一个图片扩展名处截断**，
  于是 `S1.jpg` / `S1.jpg_220x220.jpg` / `S1.jpg_Q90.jpg` / `S1.jpg_.webp` 归一到同一个 key，去重才有效。
- 过滤：`data:` / `blob:` / `chrome-extension:` / 非 http(s) / `.svg` / `.gif` / icon·logo·avatar·placeholder·qrcode 等关键词。

`src/content/image-scanner.ts`

1. **`seller-widget`（精确匹配，首选）**：定位卖家控件根节点 `.imageUploadWrap` / `.mainImageSection` / `.moreImagesSection`
   （多个根取**并集**，并剔除被其它根包含的根），只取其中的 `.sell-o-image-item` **占满槽位**。
   - 原图优先读 `.image-card img`，兜底 `.sell-o-image-item-preview img`；
   - 跳过 `.ait-tooltip` / `.ae-image-hover` 内的悬浮预览副本（否则每张图被数两次）；
   - 槽位标签取 `.header-text`（商品正面图 …），随会话传给编辑器作为素材名；
   - 顺序优先 `data-index`（全部槽位都有且互不相同时），否则退回 DOM 顺序；
   - 这里**不做尺寸 / CDN 猜测**——控件内的槽位按定义就是商品图。
2. `container:<选择器>`：通用主图容器（`.sell-o-image-item`、`[class*="main-image"]`、`.image-uploader` …），兼容旧布局。
3. `document:product-cdn`：全页兜底，仅保留商品 CDN（`alicdn.com` / `aliexpress-media.com`）上的图片。
4. 兜底两层里：尺寸未知时必须有商品 CDN 特征；已知尺寸小于 80px 直接丢弃。
5. 单个节点异常只跳过该节点（每次 `toRawCandidate` 都被 try/catch 包裹）。
5. `readImageUrl` 只接受 http(s) 候选，并跳过「浏览器把 `src=""` 解析成文档 URL」这种伪候选。

`src/content/aliexpress-page-adapter.ts` 实现 `PageImageAdapter`，负责页面判定。

## 4. 下载与存储

`src/background/download-manager.ts`

- 并发 4（`IMAGE_DOWNLOAD_CONCURRENCY`），单张 20s 超时。
- 校验：非 2xx、空 Blob、content-type 不在白名单且魔数嗅探失败 → 判定失败。
- `application/octet-stream` 允许，通过 PNG/JPEG/WebP 魔数补正 MIME。
- `runWithConcurrency` 返回 `SettledResult[]`，**单张失败不影响整批**。
- 尺寸用 `createImageBitmap(blob)` 读取（服务端不可用则回退 0）。

IndexedDB（`src/services/indexed-db.ts`，`DB_VERSION = 1`）

```text
blobs  { id, blob, mimeType, createdAt }          keyPath: id
images { sessionId, record, updatedAt }           keyPath: sessionId, index: updatedAt
```

- 原图 blobId = `blob-<imageId>`；抠图 blobId = `blob-<imageId>-cutout`，都是确定性的，刷新后可直接命中。
- 会话元数据（轻量）另存 `chrome.storage.session`，key = `aiee:session:<sessionId>`。
- 编辑器画布文档存 `chrome.storage.local`，key = `aiee:doc:<sessionId>`（体积小，且需要跨刷新保留）。
- 第一版不做 TTL / 孤儿 GC / migration。

## 5. 自动抠图

```text
Editor 挂载
  → 读取会话 + 图片状态
  → 恢复规则：success 直接恢复；failed 保持失败；queued/uploading/processing 复位为 idle 重新入队
  → selected && idle 的图片 → 标为 queued → CutoutQueue.enqueue
  → CutoutQueue（并发 2）→ runCutout(imageId)
      → getBlob(原图) → HttpCutoutClient.cutout(blob) → putBlob(抠图) → 写状态 → 生成「已抠素材」
```

- **不阻塞编辑器**：原图素材在抠图开始前就已可用；某张完成后立即 push 进素材区，无需刷新。
- **不等于自动合成**：抠图完成只生成素材，绝不自动加入 Canvas。
- **原图始终保留**：抠图不替换原图，两类素材可同时使用。

`HttpCutoutClient`（`src/services/cutout-client.ts`）

```text
ensureLoggedIn()  → GET /api/auth/me（已登录则跳过）
                  → 否则用 chrome.storage.session 里的凭据 POST /api/auth/login
uploadImage(blob) → POST /api/admin/uploads/images（multipart，字段 file）→ 服务端对象存储 URL
removeBackground  → POST /api/public/toy-image/v1/background/remove（JSON {input_url, max_size:1600}）
                    ← 平铺 {job, asset}（**不是** {success,data} 信封，见下）
fetchImageBlob    → GET asset.url → Blob（校验 PNG 魔数）
```

### 响应结构不一致（真实踩坑）

同一台服务端对两族接口用了不同的包装：

| 接口族 | 结构 |
| --- | --- |
| `/api/auth/*`、`/api/admin/uploads/images` | `{success:true,data:{…}}` |
| `/api/public/toy-image/v1/background/remove` | 平铺 `{job,asset}`，**没有 `data` 字段** |
| 抠图失败时 | 平铺 `{error:"internal_error",message:"…"}`，**没有 `success` 字段** |

按信封读 `data.asset.url` 会让**每一次抠图**都失败（报 `抠图响应缺少结果图片地址`），
而服务端其实已正确返回结果。`readRemoveBackgroundPayload()` 现在同时接受两种结构，
并把服务端的 `message` 透出为错误原因。

**这正说明单元测试的边界**：所有 87 个单测都通过，因为 mock 用的就是我错误假设的结构。
防回归靠 `tests/live/server-api.live.test.ts`（真实调用线上接口，默认跳过）：
`AIEE_LIVE=1 AIEE_USERNAME=… AIEE_PASSWORD=… npm run test:live`。

- 登录使用单飞（single-flight）Promise，2 张并发图片不会重复登录。
- 每次 `cutout` 有独立超时；`AbortController` 中断。
- 不打印凭据，凭据不进 URL。

`CutoutQueue`（`src/services/cutout-queue.ts`）

- 硬上限并发；`dispatched` 集合保证同一 imageId 在被 `retry` 之前只派发一次
  （React 重渲染、`queued/uploading/processing` 状态都不会重复提交）。
- 回调链 `.catch(onError).finally(pump)`，单个任务失败不会中断队列。
- `whenIdle()` 便于测试与调度。

## 6. 画布与导出

- Stage 视觉尺寸 `stageSize = clamp(min(容器宽, 容器高, 640))`，取偶数。
- 所有业务坐标都在 **800×800 逻辑坐标系**内；根 `Layer` 施加 `scale = stageSize / 800`。
  Konva 的拖动/变换使用节点父级的逆变换，因此缩放层下坐标依然正确。
- Transformer 只开放四角 anchor + rotation，`keepRatio` 为真、`flipEnabled` 为假；
  `boundBoxFunc` 阻止负向/过小的 box。锚点尺寸按 `1/previewScale` 补偿，视觉大小恒定。
- 图层以「中心点」定位：`offsetX = sourceWidth/2, offsetY = sourceHeight/2`，新图层默认落在 (400, 400)，
  最长边缩放到约 480 逻辑像素（`INSERT_MAX_SIDE`），统一缩放、等比、不拉伸。
- 预览背景：透明棋盘格 / 白底由**容器 CSS** 表现，Stage 本身保持透明。

导出（`src/services/exporter.ts`）：

1. `handle.setChromeVisible(false)`：隐藏 Transformer，并把名为 `export-background` 的白色矩形设为可见。
2. `stage.toCanvas({ x:0, y:0, width:stageSize, height:stageSize, pixelRatio: 1 / previewScale })`
   → 视觉层缩放被 `pixelRatio` 精确抵消，得到 **恰好 800×800** 的画布（导出前断言校验）。
3. `canvas.toBlob('image/png')` → data URL → `DOWNLOAD_COMPOSITE` → SW `chrome.downloads.download`。
4. `finally` 中恢复 UI（Transformer 可见、白底矩形隐藏）。
5. SW 路径失败时回退到页面内 `URL.createObjectURL` 下载；**任何情况下都不清空画布**。

文件名：`aliexpress-composite-YYYYMMDD-HHmmss.png`。

## 7. 撤销 / 重做

`src/editor/state/history.ts`：`{ past, present, future }` 快照栈，最多 50 条。

- 只有**已提交**的操作进历史：`ADD_LAYER` / `DELETE_LAYER` / `COMMIT_LAYER`（dragEnd、transformEnd）/ `MOVE_LAYER` / `CLEAR`。
- `UPDATE_LAYER` 只替换 present（拖动、变换过程中的每一帧），不产生历史条目。
- `UNDO` / `REDO` 后若选中图层已不存在会自动取消选中。

## 8. 安全

- Manifest V3；无 `eval`、无 `new Function`、不加载远程 JavaScript、无 `<all_urls>`。
- 服务地址来自 `chrome.storage.local` 设置，**不受页面内容控制**；内部扩展 URL 由 SW 生成，页面无法影响。
- Content Script 不接触任何凭据，只做 DOM 扫描。
- 唯一需要的凭据（密码）仅存于 `chrome.storage.session`，不落盘、不打印、不进 URL。

## 9. 目录与构建

- `vite.config.ts`：`root = src`，`publicDir = public`，输出 `editor/` `options/` 到 `dist`，`emptyOutDir: true`。
- `vite.sw.config.ts` / `vite.content.config.ts`：`emptyOutDir: false`，分别产出单文件 ESM 与单文件 IIFE
  （content script 不支持 ESM，必须 IIFE）。
- `npm run build` 依次执行三次构建。顺序不可调换：UI 构建负责清空 `dist` 并复制 `public/`。
