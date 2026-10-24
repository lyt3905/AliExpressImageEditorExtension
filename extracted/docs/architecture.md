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
- **路由查不到时必须自报身份**：路由表里没有 `message.type` 时，错误文案带上**正在运行的扩展版本号、路由条数、刷新指引**。
  这不是装饰。MV3 的 Service Worker 不会因为 `dist/` 变了就自动换新，而「未知消息类型：X」这种报错看起来完全像消息拼装写错了，
  会把人引向查通道、打错字、大小写、白名单——全是错的方向。带上版本号，一眼就能分辨「代码旧」还是「代码错」。
  同理，SW 启动时会打一条 `[AIEE] service worker 已启动：vX.Y.Z`，SW 自己的 Console 就能回答「现在跑的是哪一版」。
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
- 文字与图片共用同一个 `Transformer` 和 `COMMIT_LAYER`。图片的可见大小就是 `scale`；
  文字的可见大小是 `fontSize × scale`，而手柄只动 `scale`，所以文字松手时要折算一次字号（见下「样式记忆」）。
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
- **文字缩放被折算成字号**（`bakeTextScale()`，同在 `transform.ts`）。
  `TEXT_STYLE_KEYS` 里没有 `scale`，所以用手柄把文字拉大本来是「变换」，不会被记住 ——
  于是右栏「字号」在拖到 3 倍后仍写 48（面板与画布说法不一致），新建的文字也回到 48。
  松手时把 `fontSize × scale` 折成新的 `fontSize`、`scale` 归 1，同时解决这两件事。
  夹取在 12–200，装不下的部分**留在 `scale` 里**（否则超限的拖拽会把文字缩回去），
  因此记忆只能带走 200。折算保持乘积不变，所以松手瞬间画面不跳。
  这也是**唯一**一条「变换补丁带样式字段」的路径：`EditorStage` 把 `fontSize` 塞进
  `transformEnd` 的补丁，`pickTextStyle()` 随之认出它是一次样式改动 ——
  变换路径因此不需要任何特例，它和属性面板走同一个 `handleCommitLayer`（提交 + 记忆）。

#### 镜像 / 旋转（文档存布尔标志，节点才是带符号缩放）

镜像存成 `BaseLayer.flipX` / `flipY` 两个布尔字段，**不是负的 `scale`**。
两个方向的换算各只有一个入口：`axisScale()`（文档 → 节点）与 `splitSignedScale()`（节点 → 文档），
都在 `src/editor/state/transform.ts`。

- Konva 的 Transformer 在 `_fitNodesInto()` 里把新包围盒乘进节点自身的局部变换再 `decompose()`，
  所以一次缩放**不会**抹掉镜像，但它会把 `scaleX` 交回来成负数。直接写进文档的话，
  右栏读数、镜像按钮的点亮判断都会开始见到负值。
- 于是 `transformEnd` 走 `splitSignedScale(scaleX, scaleY)`：幅度取绝对值，符号各自变成镜像标志。
  两条函数互为严格逆运算 —— 这条逆运算有单测钉住，否则每次缩放都会把镜像状态翻一次。
- 旧文档里这两个字段不存在（类型上是 `optional`），读取一律按 `false` 处理，
  所以「镜像」上线前的草稿不会被判成损坏。文字图层的 `restoreTextLayer()` 会把它补成显式 `false`，
  与工厂 `createTextLayer()` / `createLayerFromMaterial()` 产出的形状保持一致。

旋钮拖动中的角度**直接画在 Konva 节点上**（`EditorStageHandle.setLayerRotation`），刻意不走 `UPDATE_LAYER`：

- 走 `UPDATE_LAYER` 会让「预览后的文档」成为 `history.present`，随后那次 `COMMIT_LAYER` 把它压进
  `past` 栈（`pushHistory()` 记录的是**当时的 present**）—— 撤销于是回到「刚拖到的那个角度」，
  表现为撤销没反应。
- 顺带也省掉每帧一次整棵树的重渲染。代价与 Transformer 自己的拖拽完全一致：
  节点在拖动期间处于「状态之外」，松手时用一次 `COMMIT_LAYER` 收口。
- 因此旋钮自己持有拖动中的显示值（`rotation` prop 在松手前不变），并且在**没有真正转动**时
  既不提交也不改动节点 —— 否则点一下旋钮就会多出一条空撤销记录。`rotationCommit()` 返回 `null`
  就是这道闸。

## 6.5 回填到商品页（往图片区放一张新图，默认先删第 1 张）

把合成好的 800×800 白底 PNG 送回商品页的图片区。命令行：编辑器「回填到商品页」→ `REPLACE_PAGE_IMAGE`
→ `src/background/page-filler.ts` → 注入 `public/vendor/aeiir/*` → `chrome.tabs.sendMessage({frameId})`。

### 为什么原样复用姊妹项目的库

`public/vendor/aeiir/` 下的 6 个文件来自姊妹扩展 `aliexpress-image-replace-test-extension` v0.5.1，
**未移植成 TS、未改写**。那套代码已经用真实卖家后台跑通了「图标 / 拖拽区 / 文件输入框 / 确认按钮」
的定位与「注入后自证」，重写一遍只会引入新的偏差。

它们是**经典脚本**（不是 ESM），每个文件把导出挂到 `globalThis.AEIIR.*`，靠 `manifest` 顺序解决依赖
（文件里没有 `import`）。因此只能用 `chrome.scripting.executeScript({ files })` 注入 ——
这也是唯一能把经典脚本注入到**非顶层 frame** 的方式。`bridge.js` 是第 7 个文件，是本项目自己写的
页面侧驱动。

### 与姊妹项目的三点差异

1. **追加语义**（`chooseUploadButton`）：面板绑定在「从哪个槽位的入口打开」上，「确认上传」就把
   新图放进那个槽位 —— 所以只在**空槽位**的入口里挑，并且挑**最后一个**（新图追加到末尾）。
   空槽判据与 `content/image-scanner.ts` 的 `isFilledSlot` 一致（`has-url` 类，或槽内有带 URL 的
   `<img>`），这样「扫描到的图」和「判定为空槽」不会互相矛盾。入口本身是
   `div.upload-content`（真机 2026-09-28 确认；旧快照里包在 `div.image-upload-btn` 内，
   两个选择器都扫、嵌套去重）。一个空槽入口都没有时**直接返回 null 拒绝** ——
   绝不点击已占用槽位上的入口，那会让「确认上传」覆盖旧图（真机踩过，2026-09-28 修复时
   删掉了旧的「降级到第 0 个按钮」路径）。
   另有两道「宁可少点、不可点错」的排除（`partitionEntries`）：文本含**「视频」**的入口跳过
   （真机点错入口会弹出视频上传窗口）；槽位不在 `.imageUploadWrap` 内的入口跳过
   （页面别处如 SKU 模块也有 `.sell-o-image-item`，光看「祖先链上有槽位」信不过）。
   被排除的入口会记进 `skippedEntries` 诊断 —— 否则真机上「明明有入口却不点」没法从日志看出原因。
2. **可选删图**（`removeFirstImage`）：6 个图片位常是满的，没有空位就无处可放。所以
   `payload.removeFirstImage` 为真时，先删掉第 1 张（原主图）腾出空位 —— **这是全流程唯一一处
   改动商品页数据的动作**，因此默认由调用方显式开启（编辑器勾选框默认勾选、可关），且只有第一次
   尝试才带这个标志。详见下面单独一节。
3. **跨 frame 重试**：上传面板可能不在持有商品表单的那个 frame 里。此时桥回报
   `UPLOAD_PANEL_NOT_FOUND`，由 SW 换 frame 再执行一次，且第二次必须是 `openPanel: false` ——
   面板已经开着，再点一次上传按钮会把它关掉。

### 删掉第 1 张旧图（`removeFirstImage`）

三个阶段：`FIND_DELETE_BUTTON` → `DELETE_IMAGE` → `WAIT_IMAGE_REMOVED`。

**顺序刻意的：删图在 `OPEN_PANEL` 之前。** 删除图标就在商品页的槽位上（不需要面板），而删除会让
图片区重排、空槽位的上传按钮跟着换位置 —— 先删再选槽位才选得准。单测直接断言
`order.indexOf('DELETE_IMAGE') < order.indexOf('OPEN_PANEL')`。

**删哪一张**：`imageAreaOf(doc)` 先收敛到 `.imageUploadWrap`（找不到就是 `IMAGE_AREA_NOT_FOUND`，
**不回退到整个文档** —— 页面别处也有 `.sell-o-image-item` 同名节点），再取**第一个已占用的槽位**，
只在这个槽位内部找删除图标。所以永远不会误点到别的图片的删除图标。

**怎么找删除图标**：先 `slot.querySelector('.image-upload-remove')`；改版把类名换掉时，兜底遍历
槽内的 `svg path`，`d` 以 `M601.344 73.984` 开头（真机抓到的特征）的即为删除图标，再往上找到
`<svg>` 或 `.anticon` 作为点击目标。找不到就报 `DELETE_BUTTON_NOT_FOUND` 并**停下**，
绝不退化成「点别的按钮试试」。

**删掉了没有**：判据是**占用数变少**（`filled` 减少），不是「第 0 槽变空」—— 真机上后面的图会前移，
按「第 0 槽变空」判会永远不成立。超时报 `DELETE_TIMEOUT` 并提示「可能弹了二次确认框」，
**不会自己去点那个确认**。

**重试绝不删第二次**：`removeFirstImage: attempt === 1 && input.removeFirstImage === true`。
第一次尝试已经删过第 1 张，再删一次就轮到第 2 张。

**位置要说清楚**：速卖通删掉第 1 张后后面的图**自动前移**，所以空出来的是**最后一个**槽位 ——
新图落在最末尾，不会自动成为第 1 张。本项目不做拖拽排序（用户明确接受「落在哪都行」），
但单测用两种页面行为（前移 / 原地变空）分别断言，**不假设位置**。

**`clickElement` 的 view 陷阱（真实踩坑）**：`SVGElement` 没有 `click()`（`click()` 只定义在
`HTMLElement` 上），所以 path 兜底找到的 `<svg>` 必须走「派发指针序列」那条路。而
`MouseEventInit.view` 的类型是 `Window?` —— 塞进去的对象只要不是真正的 window 就会抛
`member view is not of type Window`（jsdom 更严格：只认 window 的 global proxy），
**一次本来能成功的点击会因此整个失败**。所以 `clickElement` 先试构造一个带 `view` 的事件，
不成就整体退到不带 `view` 的形态。`view` 只是个便利字段，没有它浏览器照样派发、页面照样响应。

### frame 选择（不依赖 `webNavigation`）

`probeFrameSignals` 用 `executeScript({ target: { allFrames: true }, func })` 在每个 frame 里跑一遍
只读探测，**每个结果自带 `frameId`** —— 所以既不需要 `webNavigation` 权限，也不需要
`all_frames: true`。打分（`scoreSignals`）按阶段取不同权重：

- `form` 阶段：`.imageUploadWrap` > `.sell-o-image-item` / `.image-upload-btn` > 上传文案 > 图片输入框。
- `panel` 阶段：拖拽区 > 上传文案 > 图片输入框 > 上传按钮（面板开着时拖拽区是最强信号）。

同分时先偏向主 frame、再偏向更小的 `frameId`，这样结果与 `executeScript` 返回 frame 的顺序无关。
一个 frame 都没得分就直接放弃重试，而不是空等 —— 再试也只是多花 900ms。

### 面板关闭判定（真实踩坑）

判断「面板还开着吗」**不能**每次重新跑一遍 `findDropZone`。面板关闭后，它会继续往下试
`[class*="uploader"]` 这个兜底选择器，而它正好命中商品表单自己的 `.image-uploader` 包裹层：
结果是「可见拖拽区有 5 个」（`DROP_ZONE_AMBIGUOUS`）而不是「没有拖拽区」（`DROP_ZONE_NOT_FOUND`），
关闭判定永远不成立，每次回填都要白等满 8 秒并报一条假警告。

因此 `makePanelProbe` 用**双锚点**：已经解析出的那个拖拽区元素 + 弹层根元素（`findModalScope`），
任一仍 `isConnected` 就算面板开着。锚点也显式拒绝 `document.body` / `documentElement`
这种永远 `isConnected` 的节点 —— `findDropZone` 失败时返回的报告**根本不含 `element`**，
调用方一旦用 `body` 兜底就会踩到。

第二个锚点是真机踩坑（2026-09-28 截图）补上的：上传完成后面板切到「已添加图片」列表态，
**拖拽区会从 DOM 里被移除**，只锚拖拽区的探针于是误报「面板已关」，流程按「投进去即生效」
跳过「确认上传」直接结束 —— 弹层永远留在屏幕上。弹层根还在，就必须继续等确认按钮。

**两个锚点都断开时的重扫不能再依赖拖拽区**（2026-09-28 第二次真机）：面板重渲染会换掉弹层节点，
同时列表态里根本没有拖拽区 —— 拿「先找到拖拽区」当重扫的前提，等于在这个最关键的时刻必然得出
「面板已关」。所以重扫走 `uploadLocator.findOpenPanelScopes(doc, win)`：按 `PANEL_SELECTORS`
直接扫全文档找可见弹层，并且只认**像上传面板**的（`looksLikeUploadPanel` —— 内部有文件输入框 /
`upload` 类节点 / 「确认上传」按钮 / 上传提示文案之一），否则页面上任意一个 `dialog` 都会让
「面板还开着」永远成立，还会把别处的按钮当成我们这一个。

### 「确认上传」必须等到上传真的结束（真实踩坑）

`waitForUploadResult` 的判据之一是**缩略图数量增加**，而缩略图是本地渲染的 —— 它一出现就算
「上传完成」，此时服务端往往还在传。真机（2026-09-28）那张 800×800 的 PNG 要传十几秒，期间
「确认上传」一直是灰的（或压根还没渲染）。旧的 8 秒上限在上传刚过半时就放弃，等用户看到图传完，
扩展早已经收工 —— 屏幕上的面板于是永远没人点。

所以：

- 等待「确认上传」可点击的上限抬到 **25 秒**（`CONFIRM_TIMEOUT_MS` / `DEFAULT_CONFIRM_TIMEOUT`），
  与上传预算同量级。面板真的关了会立刻退出，放宽上限只影响失败场景的等待时长。
- 按钮**存在但灰着**（`CONFIRM_UPLOAD_BUTTON_DISABLED`）说明上传还在跑，继续等，
  **不做整页扫描兜底** —— 否则会点中页面里另一个弹层的「确认上传」。
- 整页扫描只在「面板作用域里压根没有这个按钮」且**页面上最多一个上传面板**时才采信。
- 每轮轮询都重新解析一次按钮作用域（`resolveScope`）：上传前拿到的弹层节点可能已被重渲染换掉。

点击后等待面板关闭用另一个更短的预算（`DEFAULT_PANEL_CLOSE_TIMEOUT` = 8 秒）：
关闭是「已应用到商品」的旁证，等太久没有意义。

### 慢在哪里必须能测出来，而不是靠猜

**超时上限 ≠ 实际等待时长。** `domWait.waitFor` 一旦 `check()` 成立就立刻 resolve，25 秒只是上限；
所以「等了 N 秒」意味着**条件在第 N 秒才成立**，是页面慢，不是超时设长了。这两件事很容易混为一谈，
一混就开始瞎调超时值。

原先结果里只有**一个总 `elapsedMs`**，「上传慢」和「等确认按钮慢」从外面看完全一样，没法定位。现在：

- 每条阶段日志都带 `elapsedMs`（相对 runFill 起点的偏移，相邻两条相减即该段自身耗时）；
- 结果里另有 `timings`，把总耗时拆成 `waitUploadMs` / `waitConfirmButtonMs` / `waitPanelCloseMs`；
- `confirmUpload.waitedMs` 单独给出「等按钮变黑」的耗时 —— 这段通常是大头。

### 轮询节流：别让自己把宿主页面拖慢

`waitFor` 的 MutationObserver 挂在 `document` 上，监听 `childList / attributes / characterData / subtree`。
速卖通后台 DOM 很重，**每一次页面重排都会回调一次**，而每次回调都要跑一遍全文档查询
（`findConfirmUploadButton` 内部的 `surveyPanelButtons`、`countProgressElements`、`findOpenPanelScopes`）。
风暴期间这些扫描能被触发几十上百次，造成主线程抖动 —— **反而让「确认上传」按钮变黑得更慢**：
我们等的东西，有一部分是我们自己拖慢的。

所以 `waitFor` 增加了 `throttleMs`：两次 `check()` 之间的最小间隔。风暴期间的 N 次回调被压成 1 次
（只保留一个待执行的 redo），代价是最多晚 `throttleMs` 毫秒发现条件成立。默认 0 = 不节流，
保持原行为；bridge 的关键等待显式传 40ms，并把探测粒度收紧（确认等待 150ms → 60ms，
上传结果 300ms → 80ms）—— 按钮由灰变黑只是一瞬间的事，150ms 的粒度意味着最坏白等 150ms 才发现。

### 进度只认上传面板里的

`countProgressElements` 扫的是**整个文档**，而商品页其它模块常驻着进度条节点。用它判断
「上传还在进行中」会得到永远为真的结论 —— 恰好把「按钮一直灰着、但页面上并没有在传」
这个唯一有用的信号盖掉。

所以确认等待里的进度探测收敛到**当前面板作用域**（`countProgressElements(scopeNow || doc)`），
并把「按钮灰着且面板内无进度」持续了多久记进 `lastSnapshot.disabledStalledMs`。
这样事后能分清两种等待：**页面真在传**（有进度，继续等是对的）vs **我们压根没找对按钮**
（一直灰着且无进度，再等也不会变黑）。目前这项只做诊断、不改变行为 ——
提前放弃比多等一会儿更容易误伤。

### 「一个可见上传按钮都没有」的两种原因（不能都报同一句话）

真实页面**只在空槽位上**渲染上传入口（`div.upload-content` / `div.image-upload-btn`）：已占用的槽位里只有
`image-upload-edit` / `image-upload-remove` 两个 SVG 图标，没有入口节点。所以「一个可见入口都没有」
至少有两种互不相干的原因，而用户要做的事完全不同：

| 原因 | 用户该做什么 |
| --- | --- |
| 6 个槽位全满 | 去商品页**删掉一张**腾出空位 |
| 页面改版 / 组件尚未渲染 | **手动打开**上传面板 |

原先只有后者那句话，于是「图片位满了」的报错把用户支去找一个**页面上根本不存在**的按钮。
`surveySlots(doc)` 负责分流：统计范围收敛到 `.imageUploadWrap`（页面别处 —— 例如 SKU 模块 ——
也有 `.sell-o-image-item` 同名节点，不收敛就永远判不出「满」），按 `slots.filled === slots.total`
选文案，并把 `slotCount` / `filledSlotCount` / `allSlotsFull` 一并记进诊断，事后能分清是哪一种。

同时允许**复用已经开着的面板**，但判据收紧为「拖拽区已经存在**且真的在弹层里**」：
`findDropZone(doc, win).ok` **且** `findModalScope(doc, dropZone.element, win)` 命中。只看前者的话，
商品表单自己的 `.image-uploader` 包裹层（`[class*="uploader"]` 兜底选择器的命中项）会把一个
根本没开面板的页面谎报成「面板已开」，文件就被注进错误的面板 —— 真机踩过：确认上传后覆盖了
第 1 张图（2026-09-28 修复）。反过来，不认真正开着的面板也不行：我们给的
「请先手动打开上传面板」就是一句**死循环指引** —— 用户照做、再点一次回填，仍然会因为「没有按钮」
报同一个错。复用走的是 `ok` 而不是 `notice` —— `notice` 会被提成用户眼前的「需确认」红色警告，
而这条纯属审计信息，没有可执行含义。

### 警告通道（为什么不能只报「成功」）

桥在自己的阶段日志里记 `notice`。这些提示如果只留在 `stages` 里，**回填成功时用户只会看到成功文案**，
「已点击『确认上传』，但上传面板仍未关闭」这类信息就永远没人看见。所以 `page-filler.ts` 把它提成
`PageFillResult.warnings`（只在**已确认成功**时提取；`unconfirmed` 本身已经让人去人工核对），
编辑器拿到后把提示条渲染成红色，而不是绿色成功。

### 红线

只点上传面板内部的「上传图片」与「确认上传」，以及（用户勾选删除时）第 1 张图上的那一个删除图标。
**绝不**点商品级「保存 / 发布 / 提交」，所以最后保存与否始终由卖家决定。

删图是这条红线上唯一的例外，所以它被约束到最小的活动范围：默认由调用方显式开启（编辑器勾选框）、
只作用于第一个已占用槽位内部、找不到图标就停下、点了之后必须**确认占用数真的减少**才算成功、
且**只有第一次尝试才带这个标志**。删图失败时如实告知净损失（「已先删除了原来的第 1 张图…若新图
没上传成功需要你手动补回」），而不是只报一个成功/失败。

### 体积上限

`PAGE_FILL_MAX_BYTES`（5MB）**故意不等于** `MAX_UPLOAD_BYTES`：真正执行上传的
`vendor/aeiir/shared/validation.js` 有自己的 `MAX_FILE_BYTES`，超了会在流程中途失败。
`tests/unit/page-filler.test.ts` 直接读 vendored 源码把这个数字钉住；编辑器侧则先比
`blob.size` 再发消息，保证**面板还没被打开**就拦下来。

## 7. 撤销 / 重做

`src/editor/state/history.ts`：`{ past, present, future }` 快照栈，最多 50 条。

- 只有**已提交**的操作进历史：`ADD_LAYER` / `DELETE_LAYER` / `COMMIT_LAYER`（dragEnd、transformEnd、文字属性提交、90° 与镜像按钮、旋钮松手）/ `MOVE_LAYER` / `CLEAR`。
  文字的 `transformEnd` 也算一条 —— 它同时把缩放折算成字号，但整体只提交一次，所以一次拖拽撤销一次就够。
- `UPDATE_LAYER` 只替换 present（拖动、变换过程中的每一帧），不产生历史条目。旋钮拖动**不走**这条路：预览直接画在节点上，松手才提交，理由见 §6「镜像 / 旋转」。
- `UNDO` / `REDO` 后若选中图层已不存在会自动取消选中。

## 8. 安全

- Manifest V3；无 `eval`、无 `new Function`、不加载远程 JavaScript、无 `<all_urls>`。
- 服务地址来自 `chrome.storage.local` 设置，**不受页面内容控制**；内部扩展 URL 由 SW 生成，页面无法影响。
- Content Script 不接触任何凭据，只做 DOM 扫描。
- 唯一需要的凭据（密码）仅存于 `chrome.storage.session`，不落盘、不打印、不进 URL。
- 回填（§6.5）是唯一会主动操作页面的功能，且**只在用户点击按钮时**触发：只点上传面板内的按钮，
  从不点商品级保存 / 发布。它对商品页数据的改动只有一处 —— 用户勾选「回填前删第 1 张」时删掉
  第 1 张图（勾选框默认开、可关），其余一律只新增。
- 注入的 7 个脚本全部来自扩展包自身的 `dist/vendor/aeiir/`，不加载任何远程 JS。
- 不使用 `web_accessible_resources` —— 靠 `executeScript` 注入，不需要把文件暴露给页面。

## 9. 目录与构建

- `vite.config.ts`：`root = src`，`publicDir = public`，输出 `editor/` `options/` 到 `dist`，`emptyOutDir: true`。
- `vite.sw.config.ts` / `vite.content.config.ts`：`emptyOutDir: false`，分别产出单文件 ESM 与单文件 IIFE
  （content script 不支持 ESM，必须 IIFE）。
- `npm run build` 依次执行三次构建。顺序不可调换：UI 构建负责清空 `dist` 并复制 `public/`。
- `public/vendor/aeiir/**` 由 `publicDir` 原样拷进 `dist/vendor/aeiir/**`（Vite 不加工 public 目录内容，
  经典脚本因此保持原样）。
- `scripts/check-dist.mjs` 会**从 `src/background/page-filler.ts` 里解析 `BRIDGE_FILES`**
  （而不是抄一份），逐个确认它们已在 `dist/` 中、且能按经典脚本解析。这几个文件在 manifest 与任何 HTML 里
  **都不被引用**，只有这条校验盯得住它们：一旦缺失，症状只会是运行时的「回填脚本无响应」。


## 10. 成品图工坊（`src/services/showcase/`）

把一张抠图做成一张成品展示图。**商品像素零重绘**：只有背景是合成的，商品是抠图原样绘制，
因此成品不可能与实物有出入。

### 10.1 为什么是「参数化背景」而不是「AI 生成整图」

| 做法 | 问题 |
| --- | --- |
| 文生图重绘整张图 | 模型会重画商品本身。同一款玩具换个模具细节就变成「描述不符」，跨境纠纷成本远高于图片收益 |
| 背景图库 + 抠图合成 | 需要打包并维护素材；不同尺寸要准备多套；六张图很难保证同一风格 |
| **参数化背景 + 原图合成**（采用） | 任意尺寸清晰、六张风格统一、可复现、零资源体积、商品像素不动 |

模板因此只是一组**数字**（渐变角度、地面线比例、阴影椭圆、边缘光色、暗角强度），
渲染时乘以画布尺寸。同一套参数在 800 与 1200 下是同一张图的不同分辨率。

`promptFragment` 已经写在每个模板上但**没有任何调用方**：将来接文生图供应商时，
它需要同一批「场景描述 + 风格约束」，事后从绘制参数反推必然与模板漂移。

### 10.2 分层（为什么拆成四个文件）

| 文件 | 职责 | 能否单测 |
| --- | --- | --- |
| `layout.ts` | 商品落位、阴影几何、地面线、文件名 | 是（纯函数） |
| `enhance.ts` | 边缘净化的像素算法（`Uint8ClampedArray`） | 是（纯函数） |
| `render.ts` | Canvas 2D 绘制 | 否（需要 canvas） |
| `compose.ts` | 解码 → 净化 → 裁剪 → 布局 → 渲染 → PNG | 否（DOM 胶水） |

把「画布上该多大、阴影多软」变成可断言的数字，是这个拆分唯一的理由。

### 10.3 边缘净化：两种毛病，缺一不可

抠图输出的边缘像素是**直通 alpha** 的混合值：

```text
stored = 商品色 × α + 原背景色 × (1 − α)
```

在白底上看不出来；贴到深色模板上就是一圈白边。但实际有两类叠加的伪影：

1. **颜色污染** —— 上面这条公式。用反混合还原真实颜色，并按通道限制修正幅度
   （背景色是假设值，猜错了也只应让边缘略偏，而不是把商品毁掉）。
2. **多余的 alpha** —— 剪裁蒙版比物体大一圈时，外圈是**半透明白色**。
   这些像素本来就是白的，反混合会正确地还原出白色 —— 也就是说救不了。
   只能靠 alpha 腐蚀（min 滤波）把这圈收掉。

**这个结论是渲染出对照图才发现的**：只做颜色去污时，深色模板上的白圈几乎没变化。
`stripMattingHalo` 因此最后多加了一步 `erodeAlpha`（默认半径 1，在 1600px 处理上限下
远小于一个输出像素，不会啃掉天线和手指）。

腐蚀**不能在原地做**：min 滤波若读到刚被自己缩小的像素，结果会依赖扫描顺序，
3×3 的实心块会被整块吃掉而不是留下一个像素。`enhance.ts` 先复制 alpha 再算，
`tests/unit/showcase-enhance.test.ts` 有一条专门钉这个。

处理是**单趟**的：它假设输入仍是未处理过的混合值。拿处理结果再跑一次会过度修正，
所以 `compose.ts` 每次都从原始 Blob 重新解码，绝不喂上一次的产物。

### 10.4 布局必须按 alpha 包围盒，不能按图片尺寸

抠图 PNG 四周经常有透明留白。按图片尺寸算布局，投影会落在**留白边缘**而不是商品底部，
成品看起来是悬浮的 —— 渲染出来第一眼就能看到。

所以 `prepareProduct` 在合成前先 `trimTransparentBounds()` 裁掉留白，再用裁剪后的尺寸
规划落位。这不是优化项：少了它，阴影和商品永远差一段距离。

### 10.5 解码超时与 `createImageBitmap`

`createImageBitmap` 更快、能关掉，但它**既可能不 resolve 也可能不 reject**。
在无头环境里实测就是永远 pending —— 界面会一直停在「合成中…」，没有任何出口。

所以 `compose.ts` 给它 2 秒预算，超时就退回 `HTMLImageElement` 解码（慢，但不会挂）。
两条路产出的像素一致，只是路径不同。

### 10.6 已知边界

- 只输出图片，不自动加文字 / 水印（速卖通对主图文字敏感）。
- 不自动回填：成品是 1000×1000，而回填链路按 800×800 组织；接回填要单独处理尺寸与 5 MB 上限。
- 首图位改不了：现有回填只能追加到末尾空槽（§6.5），换掉第 1 张需要拖拽排序。
- 模板的 `firstSlotSafe` 只用于提示，**不阻止**用户选深色模板；真正的拦截应该在回填阶段。

## 11. 大头照主图（`src/services/poster/`）

信息型主图的版式合成：包装图 + 大头照 + 型号 + 发货徽章 + 店铺条。输出 800×800，
与回填链路同尺寸。

**外框不在这里画，也不为它预留边距**：蓝色边框是店铺的固定模板，后期直接覆盖在成品 PNG 上。
版式因此按满幅铺排（徽章贴左边缘、店铺条贴右边缘），少留一圈反而让画面更满。

### 11.1 与 §10 的分工

| | 成品图工坊（§10） | 大头照主图（本节） |
| --- | --- | --- |
| 卖什么 | 「这东西长什么样」 | 「这是什么、多久发货」 |
| 画面 | 一个商品 + 场景 | 多个区块 + 文案 |
| 共用 | 抠图预处理（`showcase/prepare.ts`）、解码（`decode.ts`）、编码（`output.ts`） | 同左 |

两个合成器共用预处理是有意的：**边缘净化和留白裁剪的 bug 只该修一次**。
`prepare.ts` 的 `alpha 包围盒裁剪`尤其如此 —— 少了它，主图里的大头照会带着一圈透明留白，
取景比例算得再准也白搭。

### 11.2 「大头照」= 取景 + 出血，不是放大整张图

```text
源图（裁剪后 W×H）
  → 取景：顶部 headRatio（默认 42%）那一段，宽度取满
  → cover：scale = max(盒宽/源宽, 盒高/取景高) × headZoom
  → 落位：水平居中 + offsetX，垂直贴盒顶
  → 盒本身超出画布右下（x+w>size, y+h>size），因此右下自然出血
```

放大整张图得到的是「更大的全身照」；取景 + 出血才有推近镜头的效果。这两个词看着接近，
结果完全不同 —— 渲染出来一眼就能分辨。

### 11.3 字号必须二次收缩

`layout.ts` 用的是「样本文本」算初始字号，但四个文案字段都是用户可编辑的。
所以 `render.ts` 的 `drawText` 会再按 `slot.maxWidth` 做一次二分收缩：
**布局给上限，渲染给实际值**。少了这一步，换一个长一点的发货承诺就会撑出徽章
（第一版渲染就是这样，字号 52 的 `SHIP WITHIN` 直接溢出黄色圆角框）。

### 11.4 层叠顺序

```text
白底 → 包装图 → 大头照 → 型号 → 店铺条 → 徽章
```

- 大头照必须压在包装图上：否则两者相交处会出现「盒子浮在人像上」的错觉。
- 店铺条先画、徽章后画：两者在横向留一道细缝（< 2% 画布），贴在一起会糊成一个形状。
- 没有外框层：边框由外部模板叠加，画布里不该出现它。

### 11.5 已知边界

- 只有平面旋转，没有透视（包装图斜放需要 3D 变换）。
- 字体只用本机字重，不内嵌商用字体。
- 文案是自由输入，没有长度上限校验 —— 超长时字号会被压到很小，而不是报错。

## 12. 识图（`src/services/vision/`）：只读型号，不生成

### 12.1 边界：模型只能「看」，不能「画」

本地网关（`http://127.0.0.1:8788/v1`）上 14 个模型全部 `text+image → text`，没有生图能力。
这不是遗憾，反而省掉了最大的风险：**商品像素永远不经过模型**。

AI 在这里只做一件有明确收益的事：把包装盒上的型号读成文本，填进主图面板的输入框。
写错型号会变成真实的纠纷订单，而读型号可核对、可回退、失败了手打一次就行。

### 12.2 三段拆分

| 文件 | 职责 | 可测 |
| --- | --- | --- |
| `prompt.ts` | 提示词 + 响应解析（纯函数） | 是 |
| `client.ts` | HTTP、超时、缓存、错误映射 | 否（网络） |
| `PosterPanel` | 只负责「点一下 → 填字段」 | — |

解析必须是纯函数：模型返回什么形状，只有在测试里穷举过才敢上线。

### 12.3 解析为什么要花括号配对

模型最常见的三种包装：

```text
```json
{"model_code":"FT-32C"}
```                                    ← 围栏
好的，这是识别结果：{…}。希望有帮助。   ← 前后夹字
{"note":"a } brace"}                   ← 字符串里有花括号
```

正则 `/\{[\s\S]*\}/` 会贪婪吞掉多余内容；`/\{[^}]*\}/` 会被字符串里的 `}` 骗停。
`extractJsonObject()` 逐字符走一遍、跟踪「是否在字符串内 / 是否被转义 / 花括号深度」，
深度回到 0 才收尾；**没闭合就返回 null**，绝不把半截 JSON 交给 `JSON.parse`。

### 12.4 半个结果也是结果

`parseVisionTags()` 只在「五个字段全空」时返回 `null`。只读到型号、没读到品类的回答，
仍然填进输入框 —— 那正是这个功能的全部意义。字段归一化规则：

- `model_code` / `modelCode` 都认，统一大写（`ft32c` → `FT32C`）
- `palette` 去重、最多三个、单项截断 24 字
- `confidence` 兼容 `0.95` / `95` / `"90%"`，>1 视为百分比，最后夹进 0–1

### 12.5 密钥与权限

- 密钥存 `chrome.storage.local`（要跨浏览器重启可用，所以不能用 `storage.session`），
  代码里没有默认值，仓库里没有痕迹。
- `manifest.host_permissions` 加了 `http://127.0.0.1/*` 与 `http://localhost/*`
  （端口不写死，网关换端口不用重新打包）。
- `chat/completions` 走 bearer header，密钥不进 URL。

### 12.6 失败不能挡路

识别是辅助步骤，任何失败都必须变成一句可读的提示，**不能拦住生成主图**：
密钥没配、服务没起、超时 15 秒、HTTP 401、模型没按格式回答 —— 全部落成 `visionError`，
按钮恢复可点，输入框里的旧值原样保留。缓存按 `model|baseUrl|blobId` 命中，
失败不入缓存（下次点击要能重试）。

## 13. 三图叠放（`src/services/stack/`）

主流程改成：全部素材抠图 → AI 分类 → 每类选一张 → 三格叠放 → 盖固定水印。

### 13.1 版式是被水印倒推出来的，不是凭感觉画的

`水印.png`（800×800 RGBA）实测：84% 像素透明，蓝框约 10px，**y ≥ 682 全宽**被店铺条与徽章占住。
可用内容区因此是 **780 × 665**，且左下有徽章。

所以：

- `second` / `third` 待在可用区内，绝不越界；
- `hero` 允许压到底部，被徽章盖住一角 —— 卖家明确要求这个层次感；
- 所有 `box` 用画布比例表达，800 与 1600 输出是同一张版式的两个分辨率。

### 13.2 两种裁切，不能混用

| crop | 算法 | 用在哪 | 为什么 |
| --- | --- | --- | --- |
| `contain` | 等比缩到**完整放下**，框内居中 | 盒子、变形图 | 盒子被裁掉一条边就不是盒子了 |
| `head` | 取顶部 `headRatio`，再**cover** 满框 | 主图 | 特写必须填满并出血；contain 会在两侧留白 |

`head` 的 box 故意超出画布（x+w>size、y+h>size），出血就是这样来的。

### 13.3 层与层必须重叠

`planStack` 按 `z` 排序（盒子 1 → 变形图 2 → 主图 3）。但光排序不够：`contain` 会让图形比
box 小一圈，两块之间就可能出现几十像素的空隙，视觉上"散了"。

`tests/unit/stack-layout.test.ts` 有一条专门断言**相邻两层在标准比例下确实相交**——
这条测试抓到过一次 50px 的缝，把 `box` 挪近后才过。

### 13.4 阴影是层次的必需品

每个槽位绘制时加一层柔和投影（`shadowBlur = 宽度 × 0.028`）。三张照片叠在一起时，
没有投影就是一块糊；有投影才读得出"谁在前面"。

### 13.5 水印是输入，不是输出

水印 PNG 作为 `composeStack` 的参数传入（复用设置页已有的「水印框」配置），
最后一步 `drawImage(watermark, 0, 0, size, size)` 铺满。

- **不生成、不重绘**：它是固定模板，重画只会产生偏差
- **不拉伸容错**：左右上下必须严丝合缝，所以按画布尺寸硬贴，不做 contain
- **画坏了不致命**：解码失败降级为"无叠加"，卖家一眼能看出来

### 13.6 分类 → 选图（`vision/classify.ts` + `stack/pick.ts`）

分类是**封闭选择题**：五个固定答案，不是「描述这张图」。描述每次都不一样，版式无法由散文驱动；
而 `{"role":"figure"}` 可以被规则消费。

`classifyBatch` 并发 3：六张图串行要 15 秒，长到人会以为卡死。单张失败被收集而不是抛出 ——
一张没分类成功的图，操作者还能手动指定角色；为一条格式错误的回复丢掉整批才是真的坏。

选图分两趟，顺序是硬的：

```text
1. 本职角色各就各位   figure→hero, alt→second, box→third   （各取分数最高）
2. 剩下的图补空缺     按 hero→second→third 的优先级顺序
```

**为什么不能一趟填完**：只有「人形 + 盒子」时，一趟填会把盒子塞进 second。
那是中间最大的辅助位，盒子放那儿看起来像第二个主图。先放本职，盒子就落到 third 的小角落，
second 留空由版式自动跳过（`planStack` 本来就只画有源的槽位）。

分数 `置信度 × 0.55 + 主体占比 × 0.45`：角色判断的可靠度高于画面占比。
测试里有一条专门钉住「高置信度的细节图不能抢走人形的主图位」。

### 13.7 自动构图（`stack/auto-layout.ts`）

原来的三格是**写死的 box**，等于假设所有商品图的宽高比一样。宽姿态人形一进来，
box 要求「92% 高」，宽度就溢出，`cover` 为了填满便裁掉一条手臂——「人形太靠右」的真正原因。

现在：**整张素材摆上去，画布边缘来裁**。

#### 13.7.0 只调用抠图 API，不做二次处理

`composeStack` 的 `enhanceEdges` **默认关闭**：主图底色是白的，白边在白底上看不见，
跑一遍去白边 + alpha 腐蚀只会啃掉边缘细节。

同理不做连通域裁剪、不去倒影、不换背景。**一个处理器，一个结果** —— 多一道处理就多一处
和抠图服务打架的地方，出了问题也分不清该找谁。

`showcase/`（场景图）仍然默认开启：深色背景上白边是第一眼就能看见的东西。两个合成器
对同一件事取不同默认值，是因为它们的背景不同，不是因为谁更"高级"。

唯一的例外是按 alpha 包围盒裁掉透明留白 —— 那不是改像素，是算布局尺寸。

#### 13.7.1 最重要的一条：不预裁切素材

早期把"大头照"实现成"取顶部 40% 再放大"，结果是"一个胸"而不是"一支擎天柱"。
买家要判断的商品已经不在画面里。

**"出血"和"裁素材"是两种操作**：

- 裁素材：在绘制前丢掉像素 —— 画面里再也看不到那只手。
- 出血：整张画上去，超出画布的部分被边界切掉 —— 素材是完整的，只是位置超了。

现在所有槽位的 `source` 恒等于整张图（`{0,0,w,h}`），`dest` 可以超出画布。
测试里有一条直接断言这个等式。

```text
hero:    高 = 画布高 × scale（0.9 / 0.64 / 0.46），宽按比例；宽度上限 62% 画布
second:  宽 = 可用宽 × scale，高按比例；底部对齐水印线上方
third:   高 = 可用高 × scale，高按比例；顶部对齐
```

三条硬约束，都由几何引擎管，AI 碰不到：

1. **不裁切**。宽了就把高度降下来，而不是裁掉两边。
2. **宽度上限 62%**。不设的话，宽姿态主图会吃掉 77% 宽度，另外两张无处可站。
3. **主图可以越过水印线**。它的高度基数用画布全高而不是安全区高——早期用安全区，
   「允许压住徽章一角」看着实现了，实际永远不会发生。

#### 取景窗口：1.15 : 1，从中间裁

早期取景是「整宽 × 顶部 headRatio」。宽姿态的图会得到 3.7:1 的横条，
缩进画布后人形变成一条带子、头贴边。改成固定比例的竖窗口后，头胸都在框内，
展开的手臂自然被裁掉——**特写本来就该裁掉手臂**。

这个 bug 只有在渲染出来、且素材是宽姿态时才会现形。单测抓不到，因为单测里没有「姿态」。

#### 三档构图强度（`LAYOUT_PROFILES`）

「有点丑」是审美判断，不是 bug。用固定系数猜一次，永远有一半商品不对味。

所以三个系数被暴露成下拉：

```text
主图优先  hero×1.05  second×0.84  third×0.84  宽上限 72%
均衡      ×1.00       ×1.00        ×1.00        宽上限 66%
细节优先  hero×0.85  second×1.24  third×1.24   宽上限 58%
```

几何规则一条没变，只是系数不同。这比逐次调参再发版，快得多。

#### 被盖太多就换边

主图与变形图重叠超过 45% 时，把变形图挪到主图空出的那一侧。

**为什么不是缩小**：躲在更大的图后面，缩到多小都还是看不见。位置比尺寸更决定"能不能被看到"。

#### AI 的两次调用各干什么

| 调用 | 输入 | 输出 | 失败时 |
| --- | --- | --- | --- |
| 分类 | 单张抠图 | `role / confidence / subject_ratio / facing` | 该卡片标红，可手选 |
| 构图 | 三张拼成的联络图 | `scale / anchor` × 3 | 退回默认意图 |

构图必须一次调用看三张：分别问三次，得到的是三个互不知情的意见，
那正好是「构图」的反面。联络图由 `stack/contact-sheet.ts` 在本地拼，带 ①②③ 标号。

## 14. 自动化：把点击从 4 次降到 1 次

原来的主图流程要点四下：打开面板 → 分类 → 生成预览 → 保存。

现在只剩**扫描**这一下，其余串成一条流水线：

```text
抠图全部完成 → 900ms 后自动打开面板 → 分类 → 构图建议 → 合成 → 自动保存
```

### 14.1 为什么用「返回值」而不是读 state

流水线里第二步要用第一步的结果，第三步要用第二步的结果。但 React 的 `setState` 是异步的：
`setSlots(x)` 之后立刻读 `slots` 拿到的是**上一轮**的值。

所以三个函数都改成通过返回值传递：

- `handleClassify(): Promise<slots | null>`
- `runLayoutAdvice(slots): Promise<LayoutIntents>`
- `handleCompose({slots, intents}): Promise<Blob | null>`

这比 `useEffect` 监听状态变化去驱动下一步更可靠 —— 后者会在依赖数组上打转，
而且很难表达"这一步失败就停"。

### 14.2 失败必须停，但不能死

每一步失败都 `return`，并把原因写进 `stage` 那一行。手动按钮始终可用：

| 失败点 | 停在哪 | 用户还能做什么 |
| --- | --- | --- |
| 没配识图服务 | 第 ① 步之前 | 手动给每张图选角色 → 生成 |
| 分类全失败 | 第 ① 步 | 同上 |
| 构图建议失败 | 退回默认构图，**继续** | 什么都不用做 |
| 合成失败 | 第 ③ 步 | 点「生成预览」重试 |

构图建议是唯一"失败也继续"的一步：它只是优化，不是必要条件。

### 14.3 自动打开面板的分寸

只在**抠图全部完成、且本次会话还没打开过**时自动弹，并延迟 900ms。

延迟不是装饰：页面还在加载就弹模态框，看起来像 bug。而只弹一次，是因为操作者
主动关掉它之后，再弹第二次就是骚扰。

#### 13.7.2 主图为什么需要宽度上限

只按高度缩放，遇到「素材旁边印着小图」的图就会出事：

```text
a70142e9.png 宽高比 0.69（含右侧三张头部特写）
按高度 102% 缩放 → 宽度 70% 画布 → 从 x≈190 起盖住盒子和摩托
```

这就是「三张混淆在一起」的成因：**不是叠放顺序错了，是主图太宽**。

加一条宽度硬上限（50% + 档位系数）之后，超宽的主图按比例回缩，变成一列窄图，
左半边留给另外两张。

**算法解决不了的部分**：它没法知道右侧那三块不是商品。所以另有
「主图只保留主体」开关（`keepLargestComponent`，4 邻域 flood fill），默认关，
素材带小图时由操作者打开。它只置 alpha，不改颜色，不算修图。

## 15. 构图自检（`vision/inspect.ts` + `stack/adjust.ts`）

### 15.1 它解决的是「盲拍」

让 AI 决定构图的结构性缺陷：它看的是三张**并排**的联络图，不知道叠在 800×800 上是什么样。
叠歪了、盖住了、留白空了——这些错误不会报错，只能靠眼睛发现。

自检把**成品图**发回模型。这是它第一次看到买家会看到的东西。

### 15.2 先报问题，也可以给动作

```json
{"ok":false,"issues":[{"slot":"second","problem":"covered","severity":"high"}],"note":"..."}
```

坐标是它测不出来的，但"这张被盖住了"是它看得见的。

所以分两层：`issues` 是观察，`fixes` 是它自己的建议（`shrink`/`grow`/`move-*` 五种枚举）。
**有 fixes 就用 fixes，没有就按 issues 的规则自动修** —— 前者更具体，后者更可靠。

动作仍然只有枚举、没有坐标。这是这条线的底线：一旦允许它输出数字，就会开始编。

### 15.2.1 必须告诉它当前状态

第一版没传当前布局，模型看到"变形形态被压"就建议 `move-left`——而它已经在最左。
观察是对的，指令是废的。

现在 prompt 末尾会附一句「当前构图：主图靠右占满；变形形态靠左占满；包装盒靠左占满」，
并要求「已经在那一边的不要再叫它过去」。

### 15.2.2 判断会波动，所以修复必须确定

同一张图两次自检，一次说"被遮挡"、一次说"被裁切"。这就是为什么：
意见可以变，**对意见的反应不能变**——`applyFixes` 和 `adjustIntents` 都是纯函数、有单测。

`adjust.ts` 的规则是确定性的、有单测的：同样的发现进来，同样的布局出去。批量 20 个商品时，
模型的意见可能每次不同，但对意见的**反应**是固定的——这是风格一致的唯一保证。

### 15.3 三条容易做错的细节

1. **被盖住时缩小的是前面那张**，不是被盖的那张。把被遮的图缩小只会让它更看不见。
2. **每个槽位每轮只动一档**。「被遮挡」和「太空」同时出现时，动两次会互相抵消。
3. **失败不丢图**。自检抛错就保留当前构图继续保存——它是优化，不是必要条件。

### 15.4 `scale` 终于接上了

之前 `scale` 字段被忽略（尺寸由档位统一管）。自检需要一个可调的维度，所以接上了：

```text
small ×0.72   medium ×0.86   large ×1.0
```

默认意图全部 `large`——基础系数已经是调过的值，`scale` 只会**往下调**，
要么是模型说"这张宽"，要么是自检要求。

### 15.5 三条防呆规则（都被实际成品打回来才加的）

**① 主图不倾斜、顶部 y=0。**
原来是 −3° 旋转 + 顶部出血 8px。两个叠加把头推出画布——成品只剩一个胸口。
旋转会抬起画框的一个角，而那个角正好是头顶。正面直拍比"优雅的斩首"好。

**② 盒子左边只出 8px（原 26px）。**
盒子的品牌名就排在边上，26px 足够把 "TRANSFORMERS" 切掉半个 S。
盒子是唯一必须"读作完整"的东西。

**③ 三张不能同侧（`balanceAnchors`）。**
模型被问"哪里有问题"，看到左边空就答 `move-right`。这个观察是对的，但答两次，
三张就全钉在右边，左边空出三分之一——正是它想解决的问题。

约束只在"三者全同侧"时介入：hero 保留给定的一侧，两张辅助图回落到左侧。
**不推翻刻意安排的布局**，只修病态情况。测试里有一条专门断言"已经分散的布局不动"。

### 15.6 位置固定：波动不是灵活，是漂移

某次成品里主图跑到了**左边**——不是 bug，是模型那一次答了 `anchor: "left"`。

AI 决定 anchor 的后果是：同一款商品跑两次，一次"人在右"、一次"人在左"，
买家看到的是两张构图不同的主图。这在批量场景里不可接受。

现在 `FIXED_ANCHORS` 写死在布局层（主图右、两张辅助图左），`intents.anchor` 被忽略：

- **尺寸**仍自适应（模型/自检可以缩放）
- **位置**不可变，模型也拿不到这个权力
- `applyFixes` 里的 `move-*` 动作保留解析但不再执行（旧缓存里可能还有）

构图是品牌风格，不该由一次推理决定。

### 16. 主图不要「拼图」：用宽高比投票

多角度拼图被选为主图时会占满整个画面，另外两张失去意义——成品看起来只有一张图。
一个 Ironhide 上架就是这样：主图是一张「人形 + 载具并排」的拼图，盖住了盒子和皮卡。

两道防线：

1. `vision/classify.ts` 的提示词明确要求「一张图里出现两种形态 → `other`」
2. `stack/pick.ts` 对主图候选按宽高比加减分：**竖构图 +0.12，横构图 −0.12**

第 2 条才是可靠的。模型判断「这是不是拼图」会漂，**宽高比不会**：单个人形照是竖的，
并排拼图是横的，这是几何事实。辅助槽位不加这个偏置——载具本来就该是横向的。

### 17. 主图：整图缩放，由画布出画裁切

卖家明确要求：**只缩放，不裁切素材**。放大后超出画布被切掉可以接受。

`crop: 'whole'` 就是这条：

```text
高度 = 画布 × box.height（1.4）
宽度 = 高度 × 素材宽高比
位置 = 右对齐、顶部对齐
```

图被完整 `drawImage` 一次，超出 800×800 的部分由画布边界裁掉。

**与旧实现（`crop: 'head'`）的区别**：旧的是先取「整宽 × 顶部 42%」一块再放大——
那块之外的像素根本没画，调小时也回不来。新的是整张画在那里，只是位置超出。

`heroZoom` 参数控制 `box.height`，滑杆 0.9–2.0 即时重排。

`crop: 'head'` 保留在代码里给测试用，正式版式不再引用。

### 18. 主图要的是「现成的特写」，不是放大的全身照

卖家给了新模板（BT-01）：右侧是一张**已经拍成半身特写**的图。而之前几轮我一直拿全身照
缩放去凑——两种做法视觉上永远差一截，因为全身照放大到能看清头胸时，腿部必然被裁掉。

分类因此多了一个维度 `framing = closeup | full | none`，选图时：

```text
主图:  closeup +0.25，full −0.10
辅助:  closeup −0.05，full +0.08
```

权重给到 0.25，是因为它是**唯一决定「能不能像模板」的信号**。同一支人形的两张照片，
模型给的置信度差异是噪音；而「这张是特写还是全身」是硬事实。

这一条把问题从"调构图参数"拉回到"选对素材"。**参数怎么调都救不了选错的图。**

### 19. 型号文字：read, never infer

分类的同一批输出里多了 `code` 字段：图上印刷的编号，只抄看得见的。

解析层做了三道过滤，都是为了防止「猜」：

```text
去空白 → 大写 → 长度 > 16 丢弃 → 非 [A-Z0-9-._/] 开头丢弃
```

一个中文句子（"这是一台挖掘机"）不满足字符集，直接变空字符串 —— **不画，比画错好**。

绘制在 `render.ts` 的 `paintCode`：右上角、`900` 字重、`Arial Black`，
字号从画布 10.5% 起，`measureText` 超宽就按 0.86 递减，最多试 6 次。
`BT-01` 和 `TF-RF-C01` 都能放下，后者小一号但不截断。

面板可以改：OCR 在弧面纸盒上不总是准。

### 20. 二次编辑交给画布，不重建一套

面板里做拖拽 = 把编辑器已有的拖动/缩放/旋转/层序/撤销/水印锁定全部抄一遍，还多一套交互要维护。
所以做成「送到画布编辑」：三个抠图作为 `ImageLayer` 加进去，位置来自 `composeStack` 返回的 `layout`。

```text
layer.x = dest.x + dest.width / 2      // BaseLayer 的 x/y 是中心点
layer.y = dest.y + dest.height / 2
layer.scale = dest.width / material.width
```

用预览那套布局而不是重算：两边必须落在同一个位置，否则「编辑」起始画面就和刚认可的不一样。

**水印不烧进去**。编辑器有锁定水印框，导出时叠；面板再叠一次就是两层。

已知差异：`crop:'head'` 的预览是截取区域，而图层只能是整张图。默认的 `whole` 模式一致。
