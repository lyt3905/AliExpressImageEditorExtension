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

### 页面门禁（这个标签页能不能扫）

判定逻辑只有一处：`src/shared/page-gate.ts`。

- `SELLER_HOST_PATTERN`（`(^|\.)aliexpress\.com$`）与 manifest 的 `content_scripts.matches` 是同一套规则，
  页面适配器的 `isSupportedPage()` 也引用它。这三处曾经各写一份，`host_permissions` 里的
  `aliexpress.us` 就是这样变成死授权的——权限授予了，但没有任何代码路径会接受它。
- `evaluatePageGate(rawUrl)` 不抛异常，而是返回带 `reason` 的判别联合，由调用方转成用户提示：

| `reason` | 触发条件 |
| --- | --- |
| `NO_TAB_URL` | 拿不到 URL（浏览器没给），**与用户当前在哪个网站无关** |
| `NOT_A_WEB_PAGE` | `chrome://` / `edge://` / `file://` / `about:` 等非 http(s) 页面，或地址无法解析 |
| `EXTENSION_PAGE` | 当前标签页是插件自己的编辑器 / 选项页 |
| `OTHER_LOCALE_HOST` | `aliexpress.us` / `.ru` 等地区站点（第一版不支持，但要说清楚是哪种情况） |
| `NOT_ALIEXPRESS` | 其他站点 |

被拒绝时 SW 会打印 `[AIEE] page gate rejected <reason> <url>`：徽标只能显示一行短提示，
真正的排查线索是这行日志（早期版本把五种情况合并成一句「请先在 AliExpress 商品编辑页点击插件图标」，
既误导用户，也丢掉了唯一的线索）。全部分支由 `tests/unit/page-gate.test.ts` 覆盖。

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
  **例外**：本地上传的图（`upload-` 前缀）blobId 就等于 imageId —— 它们没有 URL 可哈希。
- 会话元数据（轻量）另存 `chrome.storage.session`，key = `aiee:session:<sessionId>`。
  其中 `imageIds` 只是面包屑，编辑器重建素材一律读 `record.images`，所以两者必须同源。
- 编辑器画布文档存 `chrome.storage.local`，key = `aiee:doc:<sessionId>`（体积小，且需要跨刷新保留）。
- 第一版不做 TTL / 孤儿 GC / migration。

## 5. 自动抠图

```text
Editor 挂载
  → 读取会话 + 图片状态
  → 恢复规则：success 直接恢复；failed 保持失败；queued/uploading/processing 复位为 idle 重新入队
  → selected && idle 的图片 → 标为 queued → CutoutQueue.enqueue
  → CutoutQueue（并发 6）→ runCutout(imageId)
      → getBlob(原图) → HttpCutoutClient.cutout(blob) → putBlob(抠图) → 写状态 → 生成「已抠素材」
```

- **不阻塞编辑器**：原图素材在抠图开始前就已可用；某张完成后立即 push 进素材区，无需刷新。
- **不等于自动合成**：抠图完成只生成素材，绝不自动加入 Canvas。
- **原图始终保留**：抠图不替换原图，两类素材可同时使用。

### 5.1 本地来源（上传 / 粘贴）也走同一条队列

`src/services/upload-images.ts` + `src/editor/state/use-paste-images.ts`

```text
文件选择器 / Ctrl+V
  → collectPastedImages + namePastedFiles        （只做采集与命名，不做校验）
  → appendUploadedImages(record, candidates)     （纯函数式：给定 record 返回新 record）
      逐张校验：非空 → ≤20MB → mime（声明优先，否则嗅探前 16 字节）→ 能解出尺寸
      → putBlob(upload-xxx) → 追加 SessionImage{selected:true, cutoutStatus:'idle'}
      → putSession({...record, images, imageIds: images.map(id)})   ← 已落盘
  → useEditorSession.addUploadedImages()         （此后才是编辑器内存状态）
      → setMaterials(原图素材) + setStatusByImageId('queued')
      → setProgress(total + 1)                   ← 必须同步加，否则分母永远少一个
      → CutoutQueue.enqueue(imageId)             ← 复用 §5 的同一个队列与 runCutout
```

- **入口只做采集，校验只在 service 里**：`use-paste-images` 不碰 IndexedDB，
  因此 `collectPastedImages` / `namePastedFiles` 可以在 node 环境下单测。
- **粘贴不抢焦点**：剪贴板里没有图片时 handler 直接 return，不 `preventDefault`，
  往文字属性输入框粘文本照常工作。没有 `drop` 监听，也就不存在 paste / drop 双触发。
- **失败粒度是逐张的**：一张坏图只跳过它自己，同批其余照常入库；`describeUploadOutcome()`
  把「添加了几张 / 跳过了几张、为什么」拼成提示条。
- **写入顺序不可颠倒**：blob 与 record 先落盘，再改内存。落到内存那一步失败也不会丢数据 ——
  刷新后 `selected && idle` 会被恢复逻辑重新入队（见 §5 的恢复规则）。
- **`imagesRef` 用合并而不是整体替换**：`appendUploadedImages` 期间可能有别的图抠完并
  就地打了状态补丁，整体覆盖会把它们回滚。
- mime 判定放在 `src/shared/image-mime.ts`：`background/` 是 SW 专属，编辑器不能 import，
  而下载链路（§4）与上传链路必须用同一条规则。

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

### 水印框（锁定在最上层）

需求是「水印固定在最上面、不可编辑」。有两种实现方式：

| 做法 | 问题 |
| --- | --- |
| 当作普通图层放进 `EditorDocument.layers`，到处加 `if (layer.locked) return` | 每个操作点（删除 / 移动 / 拖拽 / 变换 / 选中）都要记得加守卫，漏一个就破防；`UNDO` 与 `CLEAR` 仍会把它撤掉 / 清掉 |
| **放进独立状态，不进图层文档**（采用） | 需要单独渲染一份；换来的是结构上不可能被破坏 |

采用的做法：

- 状态来自 `useWatermark()`（`src/editor/state/use-watermark.ts`），由 `App` 直接传给
  `EditorStage` / `LayerPanel` / `Toolbar`，**从不进入 `editorReducer`**。
  因此 `UNDO` / `REDO` / `CLEAR` 在原理上接触不到它 —— 不是靠判断绕开，而是它根本不在那份数据里。
- 渲染位置：`EditorStage` 的同一个 Konva `Layer` 内、所有用户图层**之后**、`Transformer` 之前，
  所以它永远盖在最上层，同时变换框仍画在它之上。
- 交互：节点 `listening={false}` —— 点不到、拖不动、没有 Transformer。
  另外 Transformer 的挂载逻辑会显式跳过 `name === WATERMARK_LAYER_ID` 的节点（双保险）。
- 尺寸：`fitWatermarkToCanvas()` 取 `scale = 800 / max(w, h)`，中心固定在 (400, 400)，
  即「长边铺满 800、居中」，等比不拉伸；`rotation` 恒为 0。
- 存储：图片本体复用 IndexedDB 的 `blobs` store（id 前缀 `watermark-`），元数据（名称 / 尺寸 / 是否默认）
  放 `chrome.storage.local` 的 `aiee:watermarks`。**DB 版本不升**，没有 migration。
- Options 页与编辑器同源，都直接读写该 store，因此**没有新增任何消息类型**，SW 完全不参与。
- 图层面板顶部固定显示一行「水印框 · 名称 / 锁定」，只作展示：无选中、无上下移、无删除。

### 文字图层（普通可编辑图层）

`EditorLayer` 现在是判别联合：

```ts
type EditorLayer = ImageLayer | TextLayer;
```

- `ImageLayer`（`original` / `cutout`）持有 `materialId` / `blobId` / `sourceWidth` / `sourceHeight`；
  `TextLayer`（`text`）完全没有这些字段，只带
  `text / width / fontSize / fontFamily / fill / fontStyle / align / stroke / strokeWidth / shadow*`。
- `WatermarkLayer` 是**第三个独立类型**，不属于 `EditorLayer`，所以水印「不进图层文档」的结论没有被削弱。
- `EditorStage` 按 `layer.kind` 分支渲染：文字走 `Konva.Text`，**永远不进 `imageForLayer`**（那条路径只认图片）。
- 文字与图片共用同一个 `Transformer` 和 `COMMIT_LAYER`，`scale` 仍是唯一缩放来源。
- `TextLayer` 的 `x / y` 同样是几何中心：`offsetX = width / 2`，`offsetY = 实测高度 / 2`。
  Konva.Text 的高度取决于自动换行，因此首帧用 `estimateTextHeight`（`fontSize × 行数`）估算，
  节点上屏后由 `EditorStage` 的 ref 测量并写回 state 校正。
- 属性修改走 `COMMIT_LAYER`，**不用 `UPDATE_LAYER`**：面板内部保留 draft，失焦时才提交一次。
  这不是偷懒 —— `UPDATE_LAYER` 会经 `replacePresent` 直接改掉 `present`，
  修改前的状态当场丢失，再 `COMMIT_LAYER` 压进去的就是新值，**Undo 会失效**。
  用 draft + 单次提交，才能保证「打字一次 = 一条 history」且能正确回退。
- 草稿恢复分两步：`restoreStoredLayer()` 按 `kind` 分别校验（文字逐字段补默认值，
  图片保持原有宽松形状），`keepLayerWithMaterials()` 只按 `materialId` 过滤图片层、
  **无条件保留文字层**。否则刷新一次，文字就会因为「没有 materialId」被整批过滤掉。

#### 描边与阴影（都是 `Konva.Text` 的原生属性）

- 字段扁平化存在 `TextLayer` 上，不进嵌套对象：这样 `LayerPatch = Partial<TextLayer>` 与
  `restoreTextLayer` 的「逐字段补默认值」两条既有机制都不用改，恢复时按
  `MIN/MAX_STROKE_WIDTH`、`MAX_SHADOW_BLUR`、`MIN/MAX_SHADOW_OFFSET`、`shadowOpacity ∈ [0,1]` 夹取。
- **关闭态即默认态**：`strokeWidth = 0`、`shadowBlur = 0` 且两个偏移为 0，
  所以新增字段不会让任何已有草稿的渲染结果发生变化。
- `shadowEnabled` 要显式传：Konva 的 `Shape._hasShadow()` 只要 `shadowColor` 非空就返回 true
  （`Shape.js:94`），模糊和偏移都为 0 时会白建一块 buffer canvas 去画一个看不见的阴影。
- 文字描边要配 `fillAfterStrokeEnabled`：Konva 以字形轮廓为中心画描边，不配的话半个描边压在字身上，
  字反而变细。
- 描边与阴影都在节点自身坐标系绘制，随 `scale` 一起放大（这是特性，不是 bug）。
- **不会撑大 Transformer 选框**：Konva 的 `Transformer.__getNodeShape()` 硬编码
  `skipShadow: true`，stroke 则看 `ignoreStroke`（本项目已开启）。

#### 样式记忆（偏好，不是文档状态）

`TextLayer` 的 12 个样式字段会被记住，下一个新建的文字图层直接沿用。

- 权威字段清单只有一处：`src/shared/constants.ts` 的 `TEXT_STYLE_KEYS`。
  `TextStyleDefaults` 类型、`DEFAULT_TEXT_STYLE`、`pickTextStyle()`、`restore`/`create` 都从它派生，
  因此「提交时抽取」和「新建时合并」不可能错位。
- `sanitizeTextStyle()` 同时用于**读**和**写**，坏数据进不了画布。
  它和 `restoreTextLayer()` 共用 `finiteNumber` / `clampNumber` / `pickColor` / `pickAlign` /
  `pickFontStyle`（都在 `src/shared/text-style.ts`），但**夹取范围不同**：
  偏好按面板范围夹（字号 12–200），文档恢复仍用原来的宽松规则，
  以免旧版/新版文档里的大字号被静默改小。
- 为什么放 `src/shared/`：`editor/state` 和 `services` 都要用，而 `services` 不依赖 `editor/`，这条分层不能破。
- 存储：`chrome.storage.local` 的 `aiee:text-defaults`（`src/services/text-defaults.ts`）。
  **整对象覆盖写**，不做 `load → merge → set`，避免两次快速提交交错读写。
- 生命周期独立于文档：加载偏好不 dispatch 任何 action，hydrate 仍只产生 1 条历史记录；
  偏好也从不进入 `EditorDocument`，所以 undo / redo / clear 碰不到它。
- `createTextLayer(defaults)` 会把入参再过滤一遍 `pickTextStyle()`，
  即便调用方塞进 `text` / `x` / `scale` 也不会泄漏到新图层上。

## 7. 撤销 / 重做

`src/editor/state/history.ts`：`{ past, present, future }` 快照栈，最多 50 条。

- 只有**已提交**的操作进历史：`ADD_LAYER` / `DELETE_LAYER` / `COMMIT_LAYER`（dragEnd、transformEnd、文字属性提交）/ `MOVE_LAYER` / `CLEAR`。
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
