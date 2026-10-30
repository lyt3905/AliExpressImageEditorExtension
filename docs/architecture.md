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

### 3.1 商品编号：只认标题里的 `xx-xx`，认不到就留空

这串编号会被印在**主图**上，所以规则宁可空着也不能错：

- **唯一来源是「标题」输入框里的 `xx-xx` 形状文本**（`MTS-TF-SS86-0001`），且必须**含至少一个数字**。
- 没有数字的连字符词（`micro-scale` / `pre-order` / `high-quality`）是词，不是编号 —— 加这条之前，
  真机上出现过把这些词印到主图里的情况。
- 标题里第一个匹配不一定是编号（`Pre-order MTS-TF-0001`），所以**逐个匹配、取第一个含数字的**。
- **URL 的 `productId` 不再作为兜底**：那是阿里的 16 位 offer id，印在主图上是看得见的错误。
  页面文本里「商品编号：123…」同样不再采信，理由相同。

结果为空时：画布不加编号图层、预览与导出照常，只是少一行字。

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
2. `stage.toCanvas({ x:0, y:0, width:stageSize, height:stageSize, pixelRatio: 800 / stageSize })`
   → 视觉层缩放被 `pixelRatio` 抵消，得到 **恰好 800×800** 的画布。
3. `normaliseToCanvasSize()`：尺寸不是 800 时按下面的容差规则处理（不是简单 assert）。
4. `canvas.toBlob('image/png')` → data URL → `DOWNLOAD_COMPOSITE` → SW `chrome.downloads.download`。
5. `finally` 中恢复 UI（Transformer 可见、白底矩形隐藏）。
6. SW 路径失败时回退到页面内 `URL.createObjectURL` 下载；**任何情况下都不清空画布**。

文件名：`aliexpress-composite-YYYYMMDD-HHmmss.png`。

#### 799×799：导出尺寸取决于窗口大小（真实踩坑）

Konva 的 `Canvas.setWidth` 是 `canvas.width = width * pixelRatio`，**没有取整**；而 HTML canvas
给 `width` 赋值会**截断**小数。所以乘积必须正好落在 800，落到 799.9999 就变成 799。

旧公式是 `pixelRatio = 1 / previewScale`，而 `previewScale = stageSize / 800` 是更早算出来的——
先除再取倒数，两次舍入会丢 1 ulp：

| stageSize | `1/(S/800)` 的乘积 | 结果 |
| --- | --- | --- |
| 254 | 799.9999999999999 | **799** |
| 398 | 799.9999999999999 | **799** |
| 638 | 800.0000000000001 | 800 |
| 640 | 800（精确） | 800 |

240–640 之间的 201 个偶数预览尺寸里，**35 个**会中招。这正是它表现得"时好时坏"的原因：
预览尺寸跟着窗口走，坏的那批零散分布；点一次失败、点一次成功，往往只是因为状态条多了一行文字
把画布区挤小了几像素，落到了另一个尺寸上。而且**导出和回填走同一条路径**，所以"下载"其实
也会偶发失败，只是回填会明确报错。

修法两条：

1. 比例**直接从 stage 宽度算**（`800 / stageSize`，一次除法），35 个里的 27 个当场修好；
2. 剩下 8 个（322 / 334 / 386 / 388 / 390 / 398 / …）交给 `normaliseToCanvasSize`：差 1px 就
   重画到 800×800 的干净画布上（内容本来就是按 800 的分辨率渲染的，只丢了画布的一个像素），
   差得更多则**照旧报错**——真正的尺寸错乱不该被悄悄缩放掩盖。

同一类问题的通用教训：**别把一个已经取整/舍入过的值再反算回去**。

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
type EditorLayer = ImageLayer | TextLayer | PlateLayer;
```

- `ImageLayer`（`original` / `cutout`）持有 `materialId` / `blobId` / `sourceWidth` / `sourceHeight`；
  `TextLayer`（`text`）完全没有这些字段，只带
  `text / width / fontSize / fontFamily / fill / fontStyle / align / stroke / strokeWidth / shadow*`。
- `WatermarkLayer` 是**第三个独立类型**，不属于 `EditorLayer`，所以水印「不进图层文档」的结论没有被削弱。
- `EditorStage` 按 `layer.kind` 分支渲染：文字走 `Konva.Text`，**永远不进 `imageForLayer`**（那条路径只认图片）。
- 文字与图片共用同一个 `Transformer` 和 `COMMIT_LAYER`，但手柄的含义不同：图片四角手柄改 `scale`；
  文字只有左右两个手柄，拖它把 `scaleX` 折回 `width`（换行框），字形大小不变。
  所以「拖手柄」对文字来说是一次**样式**编辑，`width` 会跟着样式记忆走（见下「样式记忆」）。
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

`TextLayer` 的 13 个样式字段会被记住，下一个新建的文字图层直接沿用。

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
- **换行框宽度 `width` 也算样式**（10.5.4 起）。文字只有左右两个手柄，拖它改的是 `width`
  而不是字形：`EditorStage` 在 `transformEnd` 里把 `scaleX` 折回 `width`、`scale` 归 1，
  所以「把框拖宽」和「在右栏输入宽度」提交的是同一个字段。既然形态是用户调出来的，
  它就跟着样式一起被记住——否则每加一条文字都要重新拖一次框（这正是 10.5.4 修的那件事）。
  宽度夹在 `MIN_TEXT_WIDTH`(32)–`MAX_TEXT_WIDTH`(2000)，`sanitizeTextStyle()` 同时取整，
  因为只有 `layer.width × scale` 才会产出小数。
- **删掉了 `bakeTextScale()`**：它把文字缩放折算成字号，是「文字有角手柄」时代的解法。
  角手柄取消后（见上，文字只留左右锚点）它没有任何调用方，留着只会让文档说谎：
  README 一度写着「拖拽缩放会折算成字号」，而实际拖手柄根本不动字号。
  字号现在只由右栏输入框改，`scale` 对文字来说只剩「恢复的旧文档 / 商品码摆放」那些来源。

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
2. **可选删图**（`removeFirstImage`）：没有空位就无处可放，所以
   `payload.removeFirstImage` 为真时，先删掉第 1 张（原主图）腾出空位 —— **这是全流程唯一一处
   改动商品页数据的动作**，因此默认由调用方显式开启（编辑器勾选框默认勾选、可关），且只有第一次
   尝试才带这个标志。**但只有图片区真的满了才会删**，见下一节。
3. **跨 frame 重试**：上传面板可能不在持有商品表单的那个 frame 里。此时桥回报
   `UPLOAD_PANEL_NOT_FOUND`，由 SW 换 frame 再执行一次，且第二次必须是 `openPanel: false` ——
   面板已经开着，再点一次上传按钮会把它关掉。

### 删掉第 1 张旧图（`removeFirstImage`）

三个阶段：`FIND_DELETE_BUTTON` → `DELETE_IMAGE` → `WAIT_IMAGE_REMOVED`。

#### 只有满位才删（真实踩坑：5 张图的产品被误删）

第一版只要勾选就删。真机上遇到「主图只有 5 张」的商品时：本来就有空位，删除纯属损失——
删掉第 1 张后后面的图前移，图片区重排，紧接着的上传定位**反而找不到可点的入口**，回填直接失败。

所以 `removeFirstImage` 在 `FIND_DELETE_BUTTON` 阶段先 `surveySlots(doc)`：

| `filled` vs `total` | 行为 |
| --- | --- |
| `filled === total`（6/6） | 继续删 |
| `filled < total` | **跳过删除**，记一条 `recorder.ok`：「图片区还有空位（已占用 5/6），本次不删除第 1 张」，带上 `slotCount` / `filledSlotCount` 诊断 |

跳过的判据放在「找不到已占用槽位」之后、真正取第 1 张之前：先回答「有没有可删的」，再回答
「需不需要删」，两条消息各自说清是哪一种情况。`tests/unit/page-fill-bridge.test.ts` 用真实
bridge 驱动 DOM，两条分支都覆盖；原来那些「删除后上传到末尾」的用例改成从 6/6 的满位状态开始，
并让 `installShiftForwardOnDelete` 模拟真机行为（前移后**在末尾补一个新的空槽位**）——
少了这一步，删除后图片区会变成「无空位」这种真机上不存在的状态。

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

## 10. AI 作图：模板排版

卖家的原话是「把抠好的产品图当素材，通过放大缩小拼成一张新主图」。服务端**只有视觉理解，没有生图**，
所以这里没有"生成"，只有**排版决策 + 确定性渲染**。

### 10.1 核心取舍：AI 出方案，不出图片

| 做法 | 后果 |
| --- | --- |
| 让模型输出坐标并直接画 | 坐标不可测、同一商品每次不同、用户不满意只能重来 |
| **模板声明版式 + 求解器算几何**（采用） | 纯函数、可单测、可复现；AI 只做它擅长的两件事（判角色、评可读性） |

落点是 `CompositionPlan`（纯数据）→ `EditorLayer[]`（普通图层）。于是撤销、拖拽、导出、回填全部免费复用。

**分层不可破**：`services/composition/*` 不知道 Konva，也不 import `editor/`；把 plan 变成图层的是
`editor/state/compose-emit.ts`。`APPLY_PLAN` 一次压**一条**历史，一次 Ctrl+Z 整体撤销。

### 10.2 模板是数据，不是代码

`src/services/composition/templates/*.json` 原样保存，`template-schema.ts` 负责归一化 + 校验。
版本会迭代（`version: "1.4"`、`status: "draft"`），把数值抄进代码就会让第二份模板变成第二个 `if`。

**`box` 是 `[左, 上, 右, 下]`，不是 `[x, y, 宽, 高]`。** 三条互相印证的数字：

| 数值 | 含义 |
| --- | --- |
| `784` | 正好 `800 - safe_margin(16)` |
| `712` | 正好等于 `store_footer` 保留区的顶边 |
| `185` | 正好比文字区底边 `180` 低 5px |

而 `max_size` / `center` / `offset` 是另一套约定（目标框、点、位移）。同一份文件里两组单位并存，
归一化只在 `template-schema.ts` 一处做。

**校验层能抓什么、抓不到什么（实测记录）**：`[x,y,w,h]` 误写**不一定**能被边界检查抓住——
`[16,185,768,527]` 得到的矩形是 `16..768 × 185..527`，完全合法。真正的保护是测试里钉死的关系
（`viewport.right === width - safe_margin`、`viewport.bottom === footer.top`），误写会把两条同时断掉。

交叉检查里还有一条**警告**：`variant[2]`（390 宽、中心 570）左边界 375，会擦到文字区右边界 380。
三个 variant 都干净，只有最宽的那个不干净——这种漂移代码评审看不出来，lint 一眼就能看见。

### 10.3 alpha 采样：透明边距必须折进坐标

抠图结果是 1600×1600 的画布，商品只占中间一块。按 `sourceWidth/sourceHeight` 直接 fit，算出来的是
**画布**的尺寸 —— 商品永远偏小、位置永远偏一点，而代码看起来完全正确。

所以：

- `alpha-scan.ts` 扫两遍像素：先求不透明包围盒（trim），再在盒内填 N×N 覆盖率掩码（默认 128²）。
  纯函数，node 下可测。
- `alpha-probe.ts` 是浏览器薄壳：`createImageBitmap` → 绘制到 512px 白底画布 → `getImageData` → `scanAlpha`。
  降采样 512 的代价是 trim 误差约 ±3 源像素，对 0.3 量级的 scale 无关紧要。
- **trim 换回源像素时按「两条边」取整，再夹进源尺寸**。分别对 `left` 和 `width` 取整会让两条边各自漂移：
  真实一次 1600×1600、按 512 扫描（×3.125）的抠图，`top` 4 → 12.5 → 13、`height` 508 → 1587.5 → 1588，
  `13 + 1588 = 1601` 比源图多一个像素，`createAlphaProfile` 的合约检查直接抛
  `trim … 超出源尺寸 1600×1600`，于是**每张主图都生成失败**。夹紧只是兜底，真正修好的是"同一把尺子量两条边"。
- `coverage.ts` 的 `toLayerPlacement` 把 trim 偏移折算一次：
  `节点位置 = 目标点 − (trim中心 − 图心) × scale`。漏掉这一项就是"能跑但总是偏"。
- 面积测量用同一个掩码做解析积分，一次评估 <1ms，所以求解器可以扫上百个候选而不必碰像素。

### 10.4 特写求解：zoom 是上限，不是起点

名义 `zoom: 2.2` 只是算术。真实素材跑出来（`hero_dominance` = 0.34 / 0.36–0.46）：

| 素材 | 名义 2.2 的占用率 | 求解器选用 | 结果 |
| --- | --- | --- | --- |
| 高瘦 1:2 实心 | 55.7% | 1.82 | 46.0% |
| 高瘦 1:2 密度 0.75 | 41.8% | 2.20（不动） | 41.8% |
| 正方 1:1 实心 | 76.9% | 1.03 | 46.0% |
| 宽扁 3:1 实心 | 76.9% | 2.20 | 76.9%（区间外，报 warning） |
| 细长 1:6 实心 | 18.6% | 2.20 | 18.6%（低于下限） |

三条结论：

1. **0.36–0.46 是按"密度约 0.75 的 1:2 商品"定的**，实心 1:2 在 2.2 下是 55.7%。这是模板数值的事实，
   不是求解器的判断——所以它只下调并记 warning，不偷偷改阈值。
2. **zoom 只降不升**。曾经写成"双向调整"，结果稀疏素材（密度 0.55）被放大到 2.89 去凑占用率——
   那是靠裁掉更多商品来满足指标，对主图是反的。现在 `allowZoomRaise` 默认 false。
3. **占用率对 zoom 不是单调的**。`center_x = 300` 而画布中心是 400，放大时左侧先出画布、右侧还在长，
   净可见面积可能持平甚至下降。所以用的是 60 点密集采样 + 40 点局部细化，而不是二分。
   （这条纠正了设计初稿里的"单调、可二分"。）

### 10.5 盒子：variant 是留给求解器的搜索空间

4 个近似的 variant 不是装饰：主体被允许压在盒子上，哪个 variant 活下来取决于素材。
`solveBox` 用 alpha 覆盖算每个 variant 的可见比例，取最大；平局用 `productCode` 的哈希决定 ——
**同商品可复现，不同商品自然错开**，这正是 4 个 variant 存在的理由。

两条规则的冲突比预想少：dominance 那一趟通常已经把主体压到 46% 以下，实测遮挡只有约 28%。
真正会被埋的是**宽扁素材**（3:1 在任何 zoom 下都盖满画面），此时 `box_visibility_below_min` 如实报出，
不做无意义的让步。

让步链（`zoom → variant`）只在把 `min_visible_ratio` 提到 0.75 时才真的触发：1.82 → 1.69。
这条路径有测试钉住，且让步必然同时降低占用率，计划里会写明"主体占比降到 X%"。

### 10.6 没有包装盒时的兜底链（数据驱动）

`package_backdrop.fallbacks` 是数组，顺序即优先级：

1. `secondary_view` —— 用另一张素材填同一个框（版式一点不动，只换内容）
2. `plate` —— `#F5F5F5` 圆角衬板，可带型号（`carries: "model_code"`）
3. `drop` —— 留空

`mirrored_copy` 在 schema 里支持但 planner 跳过（需要图层透明度），跳过时会**记 warning**，不假装成功。

**衬板是真实的图层类型**（`PlateLayer`），不是画上去的背景：它可拖动、可缩放、可改色、可删除、可撤销。
为此改了 5 处：`types` 联合 / `restorePlateLayer` / `EditorStage` 渲染 / 图层面板标签 / `compose-emit`。
`keepLayerWithMaterials` 必须**无条件保留** plate —— 它没有 `materialId`，否则每次刷新画布，衬板都会被静默删掉。

两个细节：

- 衬板占**被主体遮挡最少**的那个 variant。主体偏左（`center_x: 300`），所以通常挑最右边的那个：
  `variant[0]` 会被压掉大半，连同它的型号文字。
- 型号写在衬板上时，`model_code` 文字区**本次跳过** —— 一张主图上印两遍型号看起来就是事故。
  衬板文字的 z 是 `plateZ + 0.5`（不是 `TEXT_Z_INDEX`）：它属于背景，飘到主体之上就成了印在商品上的编号。

### 10.7 视觉绑定（glm-5.3）

本地 OpenAI 兼容网关，`http://127.0.0.1:8788/v1`，默认模型 `glm-5.3`。**写代码前先实测过**：

| 项 | 实测 |
| --- | --- |
| 多图一请求 | 支持（2 张合成图 + 角色判别，一次返回干净 JSON） |
| `response_format: json_object` | 支持 |
| 耗时 / 成本 | 3.5–5.2s；双图 1137 prompt token，`credit 0.21` |
| 图像代价（512px） | 4 张 1663 token / 5 张 2029 / 6 张 2395 —— 约 **366 token/张** |

因此：

- **一次请求送全部候选**，上限 `VISION_MAX_CANDIDATES = 6`。6 是 AliExpress 图片区的槽位数，
  所以正常商品永远够用——这是**页面形状**上的上限，不是成本估算。
- 送 512px 白底缩略图。白底不是随手选的：抠图的透明通道各运行时读法不一，白底才是素材在成品主图上的样子。
- 模型回答的是 `A/B/C` 字母，**由我们映射回 material id** —— 让模型回显不透明 id 只会引入拼写错误。
- `temperature: 0`：同一商品重新生成必须绑成同一结果，否则卖家确认过的版式下次会悄悄变。
- **是「生成主图」里的第一段，不是独立的按钮**（见 §10.7.3）。自动选错比不选更糟：版式看起来像
  "设计过的"，没人会怀疑主体选错了，所以它只发生在用户按下生成、或自动排版那一刻；
  标签启发式（`bind-materials.ts`）始终垫在下面，网关挂了只损失一次识别、画布照旧出图。
- 失败分层：网络/鉴权/超时 → `VisionError` 带 code；模型答了但没给出可用 hero → 返回 `null`。
  这两种对 UI 是不同的话（"网关连不上" vs "模型没看准"）。

### 10.7.1 候选上限与截断规则（一次修正）

初版把上限设成 **4**，理由是"6 张成本翻倍、答案不会更好"。实测推翻了这个理由：

| 张数 | prompt token | 耗时 | 判对了吗 |
| --- | --- | --- | --- |
| 4 | 1663 | 3.8–5.8s | ✓ A / C |
| 5 | 2029 | 3.8–3.9s | ✓ A / C |
| 6 | 2395 | 4.7–9.2s | ✓ A / C |

每多一张只多 ~366 token，6 张比 4 张贵 **+44%** 而不是翻倍，准确率没有变化。
而"4"这个数正好会切掉第 5/6 张——**包装图常常就在那儿**，恰恰是模型唯一非要判对的东西。

更要紧的是**规则本身错了**：`slice(0, N)` 丢的是列表尾部。用户额外上传过素材时（>6 张），
被丢的可能正是包装图。现在 `selectVisionCandidates` 在截断时**优先保留标签像包装的候选**，
其余按页面顺序补齐；选中的候选保持原相对顺序，所以 A/B/C 与面板里的顺序仍然一一对应。
判据与 `bind-materials.ts` 共用同一个 `PACKAGING_LABEL_PATTERN`——两份正则迟早会漂移。

Key 存 `chrome.storage.local`（跨浏览器重启可用），**不进代码、不进 git**；本地构建还可以从 gitignored
的 `.env.local` 注入默认值（`VITE_VISION_API_KEY`），于是开发者自己的 `dist/` 打开就是填好的，而仓库与
CI 产物里都没有密钥。错误消息只带 endpoint 与 HTTP 状态码，从不回显 key（有测试钉住）。

**401 要分两种说法**：第一版只有"请检查 API Key"，而当时的真实原因是**根本没配**——这句话把人引向了
"是不是抄错了/过期了"，而不是"你还没填"。现在 `config.apiKey` 为空时明确说"当前没有配置 Key"。
另有一条容易踩的：`chrome.storage.local` 里存着空字符串时**不能**直接采用，否则一次"仅保存设置"
（那时还没有这个字段）就会永久压住内置默认值——字段看着是填过的，请求却一直不带鉴权。空值一律回落到默认。

### 10.7.2 `.env.local` 放仓库根目录会被 Vite 静默忽略（真实踩坑）

三个 Vite 配置都设了 `root: src/`，而 `envDir` 默认等于 `root`。于是根目录的 `.env.local` **根本不会被
加载**，`import.meta.env.VITE_*` 是 `undefined`：构建照常成功，只是值消失了。第一次把 Key 写进
`.env.local` 后，在产物里搜不到它，就是这么发现的。

修法是三个配置都显式写 `envDir: rootDir`。顺带修好了一个更早的哑炮：`.env.example` 一直写着
`VITE_DEFAULT_SERVER_URL`，但没有任何代码读过它（`DEFAULT_SERVER_URL` 是硬编码的同一个值），
现在这个变量真的生效了。

### 10.7.3 识别与排版是一个按钮，不是两步（10.18.1）

面板里原本并排两个按钮：「AI 识别素材角色」和「生成主图」。用户的原话是"应该合为一个按钮，
不应该是单独的两步" —— 这个反馈指向的是一个**实现细节漏到了界面上**：识别结论是排版的一个入参，
它不是什么用户可见的阶段性产物。

拆成两步的三个实际代价：

1. **点反顺序就白排一版。** 先点生成、再点识别，第二下只改了面板上的下拉框，画布还是按旧结论排的，
   用户得再点一次生成。三次点击里有两次是在补偿界面的形状。
2. **第二下没有信息量。** 识别完屏幕上看不出任何变化（除非去读那行 6 秒后消失的说明），
   于是"我点了没反应"和"点了但结论一样"无法区分。
3. **它会诱使人以为可以只做其中一件。** 只识别不排版没有产出；只排版不识别则意味着"素材角色
   靠标签猜"——那是兜底路径，不该由用户手动选择。

所以现在是：**一个主按钮 = 识别（有缓存就直接用）+ 排版**，`handleCompose` 内部按顺序做两件事，
识别失败不阻断排版（回落到标签启发式，note 里说明原因），进度用同一个按钮的文案表示
（「正在识别素材角色…」→「正在排版…」）。

唯一保留的第二个入口是按钮下面那条小链接「重新识别素材角色」：它跑同一条链、只把 `force` 打开。
保留它是因为识别结论有缓存（同一套素材不会每次都问模型），而"这次我不信它的判断"是真实需求；
做成小链接而不是第二个主按钮，是因为它属于少数情况，且**不点它也不会少做任何事**。

`force` 的语义也跟着变清楚了：以前它是"再识别一次"，现在它是"再识别一次**并**重排"——
不重排的话用户还是看不到区别。

**手工选择优先（`heroPickedByHandRef` / `boxPickedByHandRef`）**：合并之后有一个新的坑——
面板上那两个下拉框如果一按生成就被 AI 覆盖，它们就成了装饰。所以只要用户亲手动过主体或包装盒，
「生成主图」就跳过识别、直接用他选的；「重新识别素材角色」是例外（它明说要重问），重问成功后
把"手工"标记清掉，主导权回到 AI。这条不写成文档就是下一次的回归 bug。

### 10.7.4 面板上的说明默认折叠（10.18.2）

一块面板上有四类"看完就没用"的文字：AI 说了什么（能有三行）、复用了多少抠图、
"打开编辑器会自动生成一次"这类说明、以及排版让步原因（五条时能撑满一屏）。
它们对"这一次生成"有用，对"平时看一眼"是噪音 —— 而面板每开一次就要看一次。

所以四类文字都收进 `<details>`，摘要只写"里面有什么"：

- 「识别结论与本地缓存」—— 摘要带一句"（已复用素材，本次很快）"，展开后才是 AI 原话、
  缓存行、下载/清除缓存两个按钮、以及那段使用说明。
- 「本次有 N 条让步：<第一条原因>」—— 摘要里有条数和最严重的那条，展开才是完整列表。
  红色留给摘要（`compose-fold--warn`），不再整块红字占着主区域。

判据是**收起不能等于藏起来**：摘要一行必须能回答"有没有、严重不严重"。
唯一不折叠的是红色报错（`notice--error`）——那是"这次根本没出图"，不能让人再点一下才看见。

**「包装盒」下拉框按条件显示（10.18.3）**：`showBoxPicker = 当前模板有 box 槽位 && 除主体外还有素材`。
两个条件缺一个，那个下拉框就只有一个「无」——用户既不能借它改变什么，还要每次读一遍。
拼贴模板没有 box 槽位（`planner` 里 `findSlot(template,'box')` 找不到就不排盒子），
素材只有一张时也没有第二个选项。隐藏**不改变行为**：包装盒仍由 AI 认、认不出走兜底规则，
消失的仅仅是"手选覆盖"这个入口，而它在两种情况下本来都是死路。

### 10.7.5 换模板不弄丢编号与 Logo（10.18.2）

`applyComposedPlan()` 用 `planToLayers()` 的结果**整体替换**画布，所以"哪些图层不属于排版"
必须显式搬过去，`carriedLayers(plan, existing, productCode)` 就是这份清单：

- **品牌 Logo**：你放上去（可能还解锁挪过）的图章，排版不该擦掉它。
- **编号文字**：来自标题，不是来自模板。只有当 `plan.texts` 里**没有**同一段文字时才搬 ——
  「主图 + 包装盒」模板有 `text_zone`，编号由 plan 带下来（位置由模板定）；
  拼贴模板故意不写文字区，于是 plan 里没有编号。

少搬编号的效果是"切模板生成一次，编号就没了"，而用户的观感是**"它不再从标题里提取编号了"**——
功能其实一直在，只是被替换掉了。测试 `tests/unit/compose-emit.test.ts` 锁住四种情况
（只搬 brand、plan 没有编号时搬、plan 已有编号时不重复搬、空编号不搬）。


### 10.8 自动排版：什么时候可以替用户动手

打开编辑器就出图，但「可以做」和「该做」是两件事。判定集中在 `editor/state/auto-compose.ts`
（纯函数 + 16 个单测），三条边界各踩过一次：

1. **等抠图队列空闲**（不能等第一张就排）：第一张抠完就排版会漏掉包装图——那正是兜底链在掩盖的
   缺失，自己制造它最不该。
2. **两个上限，不是一个**：`AUTO_COMPOSE_GRACE_MS`(30s，有素材但队列没跑完 → 直接开排) 与
   `AUTO_COMPOSE_GIVE_UP_MS`(150s，仍是一张素材都没有 → 才放弃)。第一版只有一个 30 秒的
   deadline，同时充当这两件事：六张图每张 5–20 秒，整批常超过 30 秒，于是计时器到点时
   `cutoutCount` 还是 0 → 判成 `no-cutout` → **把自动流程锁成"已运行"**。之后抠图完成、
   面板显示「素材就绪，准备排版…」，但状态机已经结束，只有手动按钮还能出图。
3. **画布非空就不覆盖**：`APPLY_PLAN` 是整体替换，把上次会话调好的画布换掉只是一条历史记录，
   很容易没注意到。

**第 3 条曾经误伤：编辑器自己加的图层不算"用户的画布内容"。** 打开编辑器时它会自动加一个编号
文字图层（品牌命中时还有 Logo 图层），第一版把 `layers.length > 0` 直接当成"画布非空"，于是
**任何标题里带编号的商品都会跳过自动排版**，面板固定显示「已恢复上次的画布，未自动覆盖」。
现在这两个 id 记在 `autoAddedLayerIdsRef` 里，判定改用 `countForeignLayers(layers, autoAddedIds)`
——只数真正属于用户的图层。

另一条经验：这类"该跑没跑"的问题，光看 UI 分不清是状态机还是渲染。所以每次决策都会打一行
`[AIEE] 自动排版开始/跳过：<reason>` + 计数，出问题时一行日志就能定位。

**排版后的图层要"好抓"。** 自动生成的版式把主体放大到接近铺满画布，而抠图源的四周是透明边距：
按像素命中时，点在边距上会穿透到下面的衬板。第一版衬板还参与命中，于是常见的现象是
「点了商品、实际选中衬板、拖动的是一块被商品挡住的白板」——看起来就是拖不动。修法：

- 衬板保持**可点可拖**；"别抢点击"不是靠关掉命中。曾经把它改成
  「只在被选中时才 listening」，结果它在画布上彻底点不中了：点在衬板上等于点在空白舞台，
  `onSelect(null)` 反而把选中清空，画布与图层列表就此对不上；
- `APPLY_PLAN` 支持 `selectLayerId`，排版完成后**自动选中主体**，这样第一次拖动就落在商品上；
- 图层列表在选中变化时把对应行 `scrollIntoView({ block: 'nearest' })`：列表比面板高，
  "高亮了但在一屏之外"读起来和"没同步"一模一样。

### 10.8.1 画布拖动归属：按在什么上就拖什么

紧接着的第二版把"好抓"理解成了「只要按在选中图层的范围内，拖动就归选中图层」（判定用
`Shape.intersects`，alpha 准确）。出发点只是"图片被不透明图层完全盖住时也要能拖"，代价却是
**每一次**按下都被抢：排版后主体已被选中，于是拖商品编号文字、拖压在上面的包装图、拖衬板，
动的全是主体 —— 手指下的东西纹丝不动。用户的描述是"画布还是很难拖动"。

归属判定是一个纯函数 `src/editor/state/drag-owner.ts`（`decideDragOwner`，15 个单测）。
默认答案是**按下的那个图层**，三种情况移交给选中图层：

1. 按在**衬板**上、且指针落在选中图层的包围盒里 —— 衬板是排版器生成的布景，不是素材；
   按在它上面通常是想调整主体；
2. 按住 **Alt** 按任何东西 —— 显式说"要选中图层"，这是"被不透明图层完全盖住"的出口；
3. 当前选中是**用户自己选的**（`selectionIsExplicit`）、且指针落在它的包围盒里 —— 这就是
   "选中了就该拖它"。

第 3 条要配一个来源标记，否则它会退化成 10.3.4 那个坑：排版结束时主体是**程序自己**选中的，
而主体的盒子几乎铺满画布，于是每一次按下都会被抢。所以 `APPLY_PLAN` 自动选中主体后
`selectionIsExplicit = false`；用户在画布上点、或在图层面板里点，才置 `true`（`EditorStage` 的
`beginLayerDrag` 读它当判定输入）。单击仍然是"点谁选谁"——只有**拖动**才归选中的图层。
想放弃优先权就点一下空白处（`onSelect(null)` 顺手把标记清掉）。

这一条同时解决了透明区的遮挡：抠图素材大半是透明边距，它的盒子压在别的图层上面，而命中区现在是
整块盒子，于是"下层图层的盒子被上层盖住就再也点不中"。先把要动的图层选出来，再拖它。

包围盒而不是 alpha 是刻意的：alpha 要调 `Shape.intersects()`，它会把整个形状重画进
`stage.bufferHitCanvas` 再回读一个像素 —— 放在 `dragstart` 里就是每一笔的第一帧。包围盒是
缓存好的矩形，感觉不到。顺带一条 Konva 行为：拖动过程中命中画布**不再重画**
（`Konva.hitOnDragEnabled: false`），所以这笔开销只在起手那一下。

`beginLayerDrag` 顺手做「拖动即选中」：transformer 和图层面板必须跟着真正在动的那个图层，
否则拖动成功、手柄却留在别的图层上，看起来还是"拖错了"。

两条 Konva 机械细节（改这块前必看，都在 `node_modules/konva/lib`）：

- `node.stopDrag()` 不只是把状态改成 `stopped`，它还会跑全局的 `DD._endDragBefore` /
  `DD._endDragAfter`；后者给**所有** `stopped` 的元素发 `dragend`，并把非 `dragging` 的元素从
  `_dragElements` 里删掉。所以被接管的节点要靠 `suppressDragEndRef` 吞掉那次 `dragend`，而选中
  图层必须在 `stopDrag()` **之后**才 `startDrag()`，否则会被同一轮结束扫描一起掐掉。
- `startDrag()` 不传事件也能用：`_createDragElement` 会退到 `stage._changedPointerPositions[0]`，
  `pointerId` 在下一次 `mousemove` 里补齐。

**alpha 命中区试过，撤了：一条路径对两种素材更重要。** 10.3.5 给图片图层加过 `hitFunc`，只把不透明
像素登记进命中画布，理由是"透明的边距不该吃掉本该落到下层的点击"。第一版直接在**共享**命中画布上
`globalCompositeOperation = 'source-in'` 合成，把下层刚登记的命中像素整片擦成透明（命中画布是整层共用
的一块，`drawHit` 只 `clear()` 一次，之后按 z 序画所有子节点）——改成离屏合成再 `source-over` 画回去
才对，不变式当时由 `tests/unit/alpha-hit.test.ts` 钉住。

但它带来的是更糟的日常体验：抠图素材四周有大片透明边距，**每次抓取都必须正好落在实心像素上**，
用户接连报"抠图后的素材拖不动、原图素材很流畅"——而排版后的画布上，抠图素材恰恰大半是透明区。
10.3.7 又试过"把源图降采样成预览副本 + 掩码建一次就缓存"，本机实测没有改善，10.3.8 一并回退。

现在的结论很朴素：图片节点**不带 `hitFunc`**，整块盒子里按下都能抓起来，和普通照片完全一致；
代价是上层图片的透明区会挡住下层图片的点击，那部分用两层出口兜住：图层面板选中，或按住 Alt 拖
（见上）。`Shape.intersects()` 用的是临时的 `stage.bufferHitCanvas`（每次自己 `clear()` 后只画自己，
所以它一直准确）——记住这一点，以后若真要回到 alpha 命中，别再往共享命中画布上做破坏性合成。

### 10.9 拼贴模板：三个图位各放一张不同的图

`three_pose_figure_collage_white@1.0` 是第一个**图位比素材角色多**的模板：一个主体位（z30，动作姿态）、
两个辅助位（z10 背面、z20 正面）。它和 `hero_closeup_package_backdrop` 的区别不是"再来一个 solve"，而是
**不再求解**：

- **辅助位只落位，不求解。** 每个槽位自带 `closeup`（`viewport` + `zoom` + `center_x`），
  `buildCompositionPlan` 的 pass 3 直接调 `heroPlacement()` 换算中心点就放上去。设计师画好的构图，
  再"优化"一遍只会得到另一个构图 —— 这正是拼贴和 hero/box 布局的分水岭（那边 zoom 是上限、
  要躲碰撞，这边位置是结论）。三个姿态各用各的 `viewport` / `center_x` / `zoom`，没有共享的盒子。
- **`role: "support"` 是一等角色。** 拼贴不需要 hero/box 二分法：`support` 只表示"这里有张图，
  位置写在 `closeup` 里"。它和 `secondary` 的区别只在语义（`secondary` 还参与 `secondary_view` 兜底阶梯），
  所以 `SLOT_ROLES` 里两个都收。
- **`source_selection` 会真的被读。** `view_type` / `framing` / `prefer` / `exclude` / `expected_class`
  全部进视觉 prompt（"图位 X：优先选 rear / back；取景：full；应该是一张「figure」；希望：…；不要：…"）。
  几何层仍然一个字段都不读 —— 它们是"怎么认图"的提示，不是坐标。
- **`rules.collage.render_order` 决定绘制顺序，并且真的改了 z-index。** 它优先于 `z_index`：
  plan 按 `render_order` 排序后把 z-index 重编号成 `10 / 20 / 30…`（`Z_INDEX_STEP = 10`），
  于是画布、图层面板、模板三处口径一致。没列进 `render_order` 的槽位保留自己的 `z_index` 并排在最前；
  `render_order` 里写了不存在的 id 在解析期就报错（拼错一个字母会让排序悄悄退回 `z_index`）。
  模板没写 `render_order` 时行为不变，仍按 `z_index`。
- **谁放哪张图是判断题，几何层不猜。** 真正的分配来自同一次视觉调用：prompt 里追加"这些图位各挑一张
  互不相同的图"，答案多一个 `slots` 对象（`{"图位名":"C"}`），`parseBindingAnswer` 校验后变成
  `slotMaterialIds`。
- **模型没答的用面积兜底，但绝不复用同一张。** `selectSupportMaterials()`：先吃模型的答案，
  剩下的按面积从大到小填。拼贴模板关了 `prevent_alpha_overlap`，所以重复的图不会撞出碰撞警告 ——
  它只会看起来像把同一张照片贴了两遍，那是最难被发现的一种错。
- **缺图是警告，不是故障。** 槽位 `required` 但没分到素材 → `support_slot_empty` 警告（面板红色原因），
  其余槽位照常落位；同一张图被分给两个槽位也按同样方式处理。素材只有两张时就是两图拼贴，
  不会拿同一张凑第三个位置。
- **缓存按图位记身份。** `CachedBinding.slots` 存的是 `slotId -> 图片身份`，不是 material id：
  下次会话的 material id 全变了，身份还在（见 §12.3）。

`rules.collage` 是 `rules.collision` 的另一种写法（`allow_alpha_overlap` 是 `prevent_alpha_overlap` 的反面），
`parseRules` 两种都认 —— 让别人改一个模板只是为了把一个布尔取反，迟早会被改错。

**拼贴模板可以不带包装盒那三条规则。** `shadow` / `package_readability` / `text` 在语义上属于
"主图 + 包装盒"那套布局；拼贴模板经常整块不写。所以它们从"缺就整个模板失败"改成默认值 + 警告
（`shadow` 默认不投影、`package_readability` 默认不要求、`text` 默认不压主体/白底黑字），
而 `hero_dominance` / `collision` 仍然必填 —— 那两个一旦猜错，画面就是错的。
注意实现细节：默认值分支必须绕开 `readRecord()`，否则"缺失"会被记成一条 error，模板照样算失败。

`clip_to_viewport: false` 表示允许人物越出参考区，最终由 800×800 画布裁掉：**不为了避裁切自动缩小人物，
也不用防重叠规则把三个人物分开**。越界裁切是这张海报的构图手法，不是需要修正的缺陷。

用户给的模板里另外几组字段落在别处，不在本仓库的模板方言里：`background_removal` / `figure_integrity`
由既有抠图管线保证（先做商品实例分割再紧致 alpha 边界，只抠背景、不改商品像素、等比缩放 —— 直接缩放
原图会把云层背景、地面、支架、底座、日文气泡一起带上，这正是管线先抠图的原因）；`fallback` 的
"两图降级"由"缺图是警告 + 绝不复用"实现；`no_ai_redrawing` 之类是"生成式重绘"的约束，本工具从不重绘。
型号文字/店铺水印框/底部横幅不进模板 —— 水印走编辑器既有的后处理图层。

### 10.9.1 占比：模型可以说"这块该多大"

第一版拼贴模板上线后的实际效果是"三张都满高、叠成一团"。原因不是模型判错了，而是**没人负责大小**：
模板的 `zoom` 是设计师按理想素材画的，`fit: height` 又把内容拉到视口高度，于是三张图各自几乎顶满
770–800px，重叠区域必糊。视觉模型当时只回答"哪张是主体、哪张是包装盒、每个图位放第几张"，
`hero_dominance` 的占用率约束只作用于 hero 位，support 位连那层约束都不走。

修法是让模型多答一件事 —— **`size`：这张图应该占画布面积的多少**（0.05–0.85）—— 但只让它决定
"多大"，不决定"在哪"：

- **prompt 只在有图位时才问 `size`。** 单个 hero/box 布局问"三张图各占多大"没有意义（那种布局的大小
  由 `hero_dominance` 与包装盒可读性决定）。所以 `buildBindingPrompt()` 里 "给每张进画面的图一个 size"
  这一段，只有 `slots` 非空时才拼进去（hero 的 slotId 有则附带，让主体也能被指认大小）。
- **答案只收模板点过名的槽位。** `parseFills()` 用 slotId 白名单过滤、只认有限数字、夹到
  `[FILL_MIN, FILL_MAX]`。模型凭空编一个 `"product":0.6` 不会被采纳。
- **support 位用二分求解缩放。** `solveSupportFill()`：`occupancyAt(zoom)` = `heroPlacement()` 落位后
  裁剪到画布内的可见面积占比，二分 22 步逼近目标；搜索范围是 `nominal × [0.45, 2.2]`。
  超范围直接返回端点并标 `clamped`，planner 据此发 `support_fill_clamped` 警告 —— **说了做不到就要说出来，
  不能让面板显示"已按 30% 生成"实际是 45%**。
- **hero 位只放宽下限，不放宽上限。** 目标占用率进 `dominanceForFill()`：地板仍是模板的
  `min_canvas_occupancy`（那是"主体必须看得清"），偏好区间按模型给的数收窄。麻烦的是 `solveHero()`
  默认 `minZoom = 1`（从贴合尺寸起搜、只允许往上），于是"主体应该更小"永远不可达 —— 所以有 size hint 时
  传 `minZoom = min(1, nominal × 0.45)`。**上限仍钉在模板的 `zoom`**：为了凑一个百分比放大 hero
  会把商品裁掉，那是这个仓库明确拒绝的取舍。
- **目标与实际的差都要记账。** `plan.diagnostics.fills` 记 `{target, achieved}`，
  `|achieved − target| > 0.04` 时发 `hero_fill_unmet`。占位比是二分出来的近似值，没有这条记录，
  "为什么这次主体偏小"就无从查起。
- **缓存要带上它。** `CachedBinding.fills` 与 `slots` 一起存（两者同源同寿命：一次视觉调用的两个答案），
  解析时只留 `0 < size < 1` 的有限数字 —— 存下来的 `40` 说明记录坏了，不该被当成 40% 用。

一句话：**模型决定"占多大"，模板决定"在哪"，求解器把前者翻译成后者坐标系里的缩放，做不到就报警。**
几何仍然是确定性的，同输入同输出。

### 10.9.2 叠图秩序：脸可以被遮住胸部，不能被遮住

占比做对之后，第二个问题浮上来：三张图各自都在该在的位置、该有的尺寸，结果**右边那张把中间那张的脸挡了**。
这在拼贴里几乎是必然 —— 三张图在横向本来就重叠，重叠区恰好在头部高度。

于是加一条**可选**模板规则 `rules.cascade`，只在拼贴模板里开：

```json
"cascade": { "protect_head": 0.24, "center_largest": true, "balance_margins": true, "max_shift": 0.16 }
```

`arrange-cascade.ts` 按顺序做三件事，**每一件都只平移**：

1. **`center_largest` —— 面积最大的那张站到水平中心。** "视觉中心"就是占了大半张图的东西站中间，
   其余围着它。只改 `x`：三个姿态共享一条基线，把谁往中间挪都会把脚抬起来或压下去。
2. **`protect_head` —— 后画的图不许压住先画的图的头。** `protect_head: 0.24` 表示"内容盒最上面 24%
   是脸"（手办立像的头部大致占四分之一）。先挪**被挡**的那张（它通常更小、更靠边，动它代价更小），
   挪不开再挪挡人的那张（此时发 `cascade_center_tradeoff`，因为构图的中心意图被牺牲了），
   都不行就发 `head_occluded` —— 和 10.8 的原则一样：**做不到要说出来**。
3. **`balance_margins` —— 所有画面图层整体平移，让左右/上下留白相等。** 整体动不改变相对位置，
   所以不会把第 2 步刚躲开的脸又挡回去。内容已经顶出画布时发 `margins_uneven`
   （这种情况就是"内容比画布还宽"，四边不可能一样宽）。

为什么**只平移**、不顺手缩一点：

- 大小归 `size`（10.9.1）与模板的 `zoom`，顺序归 `render_order`（10.9）。同一条规则如果同时能改三样，
  "为什么这次人物变小了"就再也查不出来 —— 一张图的大小只该有一个决定者。
- 缩写会让 `protect_head` 变成"为了躲脸把主体缩成配角"，而这正是用户明确拒绝的效果
  （他要的是"可以遮住胸部以下，不要遮住脸"，不是"把挡人的那张缩小"）。

两个数字是刻意的：

- **`HEAD_TOLERANCE = 0.06`** —— 脸允许被"擦到" 6%。发型、天线、飘动的披风本来就互相穿插，
  零容忍会让三张图彻底摆不开（模板里每个图位都是 770–800px 高）。
- **`max_shift = 0.16`** —— 平移上限 16% 画布宽。为了躲一张脸把人物推出画布，是拿构图换构图。

未裁切的内容盒才算得对：留白对齐用的是**未经 `clipToCanvas` 的**内容盒，否则"已经超出画布"的部分会被
抹平，`left + right === canvas.width` 恒成立，`margins_uneven` 永远不会发 —— 而那种情况恰恰最该说。

### 10.9.3 带店铺边框水印的图，在识图阶段就被剔掉

listing 的第一张常是本店自己加过**边框水印**的图：一圈花边、圆角白卡、角标贴纸、上下文字条。
这类图不能进合成图 —— 但**抠图救不了它**：边框不是背景，它是商品照片的像素本身，
`background/remove` 只去背景，会把那圈白边原样留着。于是拼出来是一张印着花边的白卡贴在干净版式里。

判断只能交给视觉模型：它是唯一同时看到全部缩略图的一方。做法是在**同一次请求**里多问一个字段：

```json
{ "hero": "A", "package": "B", "package_found": true, "skip": [], "reason": "…" }
```

- **多一个字段，不多一次请求。** 为此单开一次"哪张有边框"的调用，成本和延迟都要翻倍，
  而判断所需的信息（缩略图）此刻已经在上下文里。
- **`skip` 是硬排除，不是"排最后"。** 排到候选末尾仍可能被选中（照片不够时），
  而带边框的图在任何槽位都是错的。
- **模型自相矛盾时整条答案作废。** 若它一边把 A 放进 `skip`、一边把 A 选成 hero，
  `parseBindingAnswer` 返回 `null` —— 与"模型没给出可用结论"同一条路径，回落到标签启发式。
  让 A 胜出等于把带框的图放进最大的槽位。
- **拼错不连坐。** `skip` 里的字母要能在候选表里找到，找不到就丢掉。
  一个拼错的字母如果被当成"排除某张好图"，损失比漏掉一张带框图更大 —— 前者是静默的错误构图，
  后者只是回到改动前的行为。
- **排除只作用于自动路径。** 被剔的素材仍留在素材列表里，手动选中它照样能排版：
  这条规则约束的是"系统替你选"，不是"你不许用"。

缓存里存的是**图片身份**，所以第二次打开同款商品，带框的照片不会因为缓存命中而悄悄回到画布上
（与 `fills` 同理：同一次答案的一部分，丢掉它就等于换了答案）。

排除必须**当场生效**，不能等下一次渲染。自动排版在一条 `await` 链里"问模型 → 排版"：
`setVisionSkipped()` 只是排到下一次渲染，而 `composeFor` 是从本轮渲染里捕获的闭包，
它手里的候选列表还是"没排除"的那份 —— 于是刚被点名的那张图会照旧被塞进拼贴图位。
所以同一份名单还存了一份 `visionSkippedRef`，`composeFor` 读 ref 而不是 state
（`usableCutouts`/`bindCandidates` 仍然按 state 派生，负责跨渲染的常规路径）。

### 10.9.4 成品观感：六个数字 + 一条整体区间 + 一条底线

上面每一节管的都是**一张图**：它自己的取景框、自己的占比、自己和别人的遮挡。可「这一页好不好看」
是拼完才出现的性质 —— 三张各自合格的手办可以拼成一页糊、也可以拼成一页空。

所以这里补两层，一层只测量，一层只收口：

**第一层：`measure-layout.ts` 只测量，不判断。** 它输出六个数字：

| 数字 | 含义 | 为什么是它 |
| --- | --- | --- |
| `union` | 可见内容盒并集 ÷ 画布面积 | "这页用了几成"，是卖家第一眼的感觉 |
| `hierarchy` | 最大 ÷ 最小 α 占比 | =1 就是"三张一样大，读不出主次" |
| `margins`/`minMargin` | 并集盒到四边的像素 | 留白歪不歪、有没有顶到边 |
| `occlusion` | 后画的图盖住先画的那张的最大比例 | 叠是拼贴的本意，埋掉不是 |
| `cropped` | 最大那张被画布切掉的比例 | 允许裁切放大，但要知道裁了多少 |
| `centroid` | 面积加权质心（归一化） | "视觉重心"偏了半屏，规则看不出来，人一眼看得出 |

并集用**容斥原理**精确算（最多四项，2⁴ 个子集，没有扫掠线的边界 bug）。并集量的是"占了多少地方"，
不是 alpha 像素总和 —— 后者在两张图重叠时会重复计数，反而不像人眼。

它写进 `plan.diagnostics.aesthetic`，**只记账**。这一层的价值是让"这页为什么看着挤"能被截图对照，
而不是让管线自己给自己打分。真正判断好不好看，得等到后面接上"自评"（把成品缩到 512 让模型当评委，
只在判难看时换档重试）—— 那一步会因为分数不稳定和多一次请求而单独做。

**第二层：`fit-canvas-fill.ts` 只收口。** `rules.collage.canvas_fill` 三个数：
`min_union` / `max_union` / `min_hierarchy`。

- **层级差先收。** 最大/最小不足时，只把**最小那张**往下收（乘 0.92 逐步步进），因为放大会让整页更挤，
  而"不够素材就不凑"是底线。收到 `名义 zoom × 0.45` 地板还不达标，就发 `hierarchy_flat` 把话说明白。
- **整体占位后收。** 并集在区间外时，对**全部可缩放项乘同一个系数**（`sqrt(target/union)`，一步不超过
  ±35%），所以刚调好的层级差不会被毁掉。
- **只缩放 support 位，不动 hero。** hero 的 zoom 已经跟 `hero_dominance` 和包装盒可读性谈完了
  （§10.9.1），再动它等于把一场结束的谈判重开。整体的拥挤感主要来自后景那几张，拿它们开刀副作用最小。
- **单张不参与层级差。** 一张图的 ratio 恒为 1，不跳过就会把自己一路缩到地板 —— 这是实现时踩到的坑，
  `tests/unit/composition-aesthetic.test.ts` 钉住了。

**底线：`rules.collage.min_pictures`（拼贴模板是 2）。** 素材只够一张时，硬拼出来的"独苗"最坏 ——
画布上一个人站着、四周全白，卖家会把它当成品上架。低于底线时 planner 清空图片并发
`not_enough_pictures`，`composeFor` 直接返回 `null` 并把原因写进红色提示。模板校验会拦住
`min_pictures` 大于"能放图的槽位数"的写法，因为那种模板永远出不了图，而症状会出现在运行时（"素材不够"），
查起来像素材的问题。

### 10.10 测试边界

- 求解器、模板校验、plan→图层：**node 下全可测**（`AlphaProfile` 与 `MeasureText` 都是注入端口）。
- `probeAlphaProfile` / `blobToThumbnailDataUrl` 只能在浏览器跑 —— 所以它们的逻辑被压到 `alpha-scan.ts`
  与 `scanAlpha` 里，薄壳只剩"解码 + 读取像素"。
- `tests/live/vision.live.test.ts`：真网关契约测试，默认 skip（`AIEE_LIVE=1 AIEE_VISION_KEY=…`）。
  它用 node 现场生成的 PNG（蓝色立板 / 棕色双面箱体）跑真实 `VisionBinder`，断言角色判对 ——
  fixture 故意做得毫无歧义，所以判错意味着 prompt 或模型变了，而不是"模型今天心情不好"。
- 拼贴模板另有一份 `tests/unit/composition-collage.test.ts`：模板解析（viewport 原值、`collage` 别名取反、
  `support` 角色、`product_match`、`render_order`、缺三块包装规则时的默认值 + 警告、`render_order` 拼错 id 报错）、
  `render_order` 与 `z_index` 冲突时前者赢、没有 `render_order` 时退回 `z_index`、逐槽定位
  （三个姿态的 x/y 互不相同）、`selectSupportMaterials`（用模型答案、面积兜底、绝不复用）、
  plan 三图 z 序、缺图/重复图的警告、`buildBindingPrompt` 把五个提示字段写进图位段落、
  以及 `parseBindingAnswer` 对 `slots` 的过滤（未知图位、未知编号、重复、与 hero 撞车全部丢弃）。
- `tests/unit/composition-fill.test.ts` 专门盯"占比"这条新链路：`solveSupportFill` 撞地板/天花板时
  `clamped` 是不是真的为真（有符号差 bug 就是它抓到的）、目标变小是否单调变小、planner 有/无 `fills`
  时的缩放关系、只改大小不改水平位置、hero hint 可达时不发警告、不可达时发 `hero_fill_unmet`、
  以及 `parseFills` 的白名单与夹紧。
- `tests/unit/composition-cascade.test.ts` 盯"叠图秩序"：规则全关时一个像素都不动、最大者被挪到
  `width / 2` 而其它图不动（居中不是重排）、被挡的图让开、被挡的挪不开时改挪前图并发
  `cascade_center_tradeoff`、都挪不动发 `head_occluded`、整体平移 `dx` 让左右留白相等、
  内容比画布还宽时发 `margins_uneven`；集成两例用拼贴模板跑真实 plan，断言"每张图的头带被后画的图层
  压住的比例 ≤ 6%"和"左右留白相等" —— 头带的定义直接调 `headBandOf()`，测试与实现不允许各算一套。
- `tests/unit/vision-binding.test.ts` 里的 `skip`（边框水印）四例：prompt 里既有「店铺边框水印」也有
  `"skip":[]` 与"没有就写空数组"的收尾句（模型会为了填字段瞎编一个）、`skip` 里的图不能当包装盒、
  更不能进拼贴图位、以及"既选 hero 又排除 hero"时整条答案作废（返回 `null`）。
  `tests/unit/compose-cache.test.ts` 补两例：`skipped` 的身份列表去重去脏后原样读回、没有时不写这个键。
- `tests/unit/composition-aesthetic.test.ts` 盯"成品观感"：`unionArea` 的容斥（两块相邻不重复计数、
  两块重叠只算一次）、`measureLayout` 的并集/最紧留白/重心、遮挡 50% 的量法、被画布切掉一半的
  `cropped`；`fitCanvasFill` 在区间内一动不动、太满缩回来、太空放大、层级差只收最小的那张、
  单张时不做层级差（否则会把自己缩到地板）；集成两例用拼贴模板断言"只有 hero 时不出图并发
  `not_enough_pictures`"和"两张图时 `diagnostics.canvasFill` 与 `diagnostics.aesthetic` 都有账"。
  拼贴与占比那两个文件的模板副本会摘掉 `canvas_fill`/`min_pictures`：它们测的是逐槽几何，
  全局那一层由这个文件负责，混在一起等于在测另外一件事。

## 11. 品牌目录：把 Logo 配置搬进仓库

品牌 Logo 以前只能一张一张手工上传。现在有一半来自仓库里的 `catalog/`：`brands.json` 是清单，
`logos/<slug>.png` 是图。**一个提交就是一次发布** —— 加个品牌、换张 Logo 都不用重新打包扩展，
也不用动版本号（`AGENTS.md` 的口径是 `src/` 变了才升版本，`catalog/` 只是数据）。

### 11.1 真相源仍然是本地

目录是**输入**，不是真相源。`chrome.storage.local` 的品牌注册表 + IndexedDB 的 blob 才是：
编辑器、`matchBrandByTitle`、自动加 Logo 图层全都只读本地，**永远离线优先**。
拿不到目录（GitHub 被墙、JSON 写错、校验和不对）时，本地照旧能用，只是这次没更新。

这条决定的另一个好处：同步逻辑可以随时重跑而不会有"半个品牌"这种状态 ——
Logo 逐个下载（一个坏图不影响其它），但**注册表只写一次**（`mergeRemoteBrands`）。

### 11.2 三个 id 必须稳定，否则历史画布会断图

| 是什么 | 规则 | 变了会怎样 |
| --- | --- | --- |
| 目录里的品牌 | `id`（slug，`^[a-z0-9][a-z0-9-]{0,63}$`） | 等于换了个新品牌，老品牌会进 `toRemove` |
| 注册表条目 | `remote-<slug>` | 历史画布上的 Logo 图层引用的就是这个 id |
| IndexedDB blob | `brand-logo-remote-<slug>` | 换掉就等于断图 |

所以"更新一张 Logo"的正确做法是**同名覆盖文件**，不是新建文件：图片字节变了，`sha256` 变了，
`rev` 跟着变，同步原地替换 blob，图层那边的 id 一动不动。

### 11.3 `version` 和 `rev` 分别管什么

- `version`（整数）：**要不要上网**。和上次成功同步的版本相同 → `up-to-date`，一次请求都不发。
  再加一层 24 小时 TTL：打开编辑器就同步，但一天内不重复打 GitHub。
- `rev`（每品牌）：**要不要重下这张图**。缺省回落 `sha256`，再缺省回落 `v<version>`。
  于是"只改了一张图"不必让所有机器重下六张。

`version` 只在**整份目录都落地**之后才前进（`sync.ts` 里的 `complete`）：同步到一半失败时版本留在旧值，
下次自动重试，而重试又只会碰 `rev` 不同的那几张，成本很低。

### 11.4 本地优先的三道闸

目录是别人（仓库维护者）写的内容，不能反过来清掉卖家自己的东西：

1. **同名手工品牌**：本地非 remote 品牌的 `name`（去空格、不分大小写）与目录某条相同 → 该条进 `conflicts`，
   不下载。卖家自己传的 Logo 才是他要的那张。
2. **卖家改过的远程品牌**：`updateBrand` 给 remote 条目打 `edited: true`，之后同步只换 logo 和 `remoteRev`，
   名称/关键词保持卖家的措辞。
3. **单独关掉的品牌**：选项页每行一个「同步」勾选框（`state.skipped`）。取消勾选后，同步既不覆盖也不删除它。

目录里**删掉**的品牌只删注册表条目，**blob 不删** —— 已保存的画布文档可能还引用着那个 Logo 图层，
删了会变成空白。

### 11.5 可达性：镜像按顺序试，失败要说清是谁失败

`BRAND_CATALOG_URLS` 依次是 `raw.githubusercontent.com` 和 `cdn.jsdelivr.net`。逐个试，
**记住上次成功的那台**（`baseUrlUsed`）并放到下次的第一位；全失败时错误信息拼成
`没拿到品牌目录（raw.githubusercontent.com：HTTP 502；cdn.jsdelivr.net：超时）` ——
卖家要能区分"GitHub 被墙"和"目录 JSON 写坏了"，这两种的修法完全不同。
两个地址都对同一个分支名解析成功（含 `/` 的 ref jsDelivr 也认，2026-10-27 实测返回当时的 `version: 2`）。

只接受 `https`（本机 `127.0.0.1` / `localhost` 例外，方便本地起个静态目录调试）。

**读哪个 ref 也是设计的一部分。** 现在 `BRAND_CATALOG_REF` 指向功能分支
`feat/ai-image-generation`，因为功能还没发版，目录却已经在用了。规矩只有一条：
**合并到 `main` 之后把常量改回 `main`**，否则删分支那天所有已装插件的同步一起失效。
不用 tag 而用分支，是因为「换个 Logo」不该等于「发一次版」；不用 commit sha，
是因为那样每次改目录都得改代码、还得让用户更新扩展。

### 11.6 不安全输入当成不安全输入

目录来自网络，最终会变成 IndexedDB 里的图片和画布上的像素。硬边界（`brand-catalog/schema.ts`）：

- `logo.file` 必须是相对路径 `logos/<name>.(png|jpg|jpeg|webp)`：不要绝对地址、不要 `..`、不要其它后缀。
- 解析成绝对 URL 后再校验一遍 **origin 相同 + pathname 仍以目录前缀开头** —— 正则以后放松了，
  这一条还兜得住。
- `brands.json` ≤512KB、品牌 ≤100 条、单图 ≤4MB、单条术语 ≤60 字、名称 ≤120 字。
- `sha256` 可选；写了就强校验，对不上这张图不落地。

### 11.7 目录是数据，所以有脚本看着

```bash
npm run check:catalog   # 字段 / 路径 / 文件存在 / sha256 / 数量上限
npm run catalog:write   # 重算 sha256 + 规范化 JSON
npm run catalog:bump    # version + 1，然后同上
```

`scripts/brand-catalog.mjs` 的存在理由跟 `check-version.mjs` 一样：CI 会跑，人也会跑。
文件校验和是这里唯一的"编译期"，漏了它，坏图会在卖家浏览器里才炸。

### 11.8 测试边界

- 纯逻辑全可测：`parseBrandCatalog` / `resolveLogoUrl`（`tests/unit/brand-catalog-schema.test.ts`）、
  `planBrandSync`（同步决策）、`applyBrandSync` + `syncBrandCatalog`（用注入端口跑，不需要网络）。
- 注册表合并规则单独测：`tests/unit/brand-store-merge.test.ts`（保住 `createdAt`、保住 `edited` 措辞、
  只删 remote、删条目时 blob 还在）。
- 真网络没有自动测试：`catalog/brands.json` 里的图来自卖家给的品牌 Logo，改目录后靠
  `npm run check:catalog` 兜住；两个镜像能连是手工验过的（见 §11.5）。

### 11.9 打开编辑器时的静默同步

第一步（10.5.0）只有选项页一个「立即同步」按钮。第二步把它接进编辑器的启动流程，并允许
卖家自填一个镜像 —— 这两件事的难点都不在"调一次 `syncBrandCatalog`"。

**一次每次打开都同步是错的。** 目录本身有 24h TTL（`planBrandSync` 里 `now - syncedAt < TTL`
直接返回 `fresh`），所以成功的同步不会重复。但**失败的**不会：`syncBrandCatalog` 在拿不到目录时
只写 `lastError`、`syncedAt` 原地不动 —— 这是对的（下次还得重试），于是"GitHub 被墙"那天，
每开一个商品页就多一次 15s 超时。卖家一天开几十个页面。

所以加了 `src/services/brand-catalog/silent-sync.ts` 的 `claimSilentSyncAttempt()`：模块作用域
一个布尔值，**每个标签页只给一次机会**，刷新页面重置。它不落盘、不跨标签页共享 —— 这是特性
不是缺陷：频繁开关页面属于刷新，值得再试；同一页面里的重渲染不该再发一次网络请求。

顺序上先同步、后读注册表，但同步永远不阻塞首屏：`syncBrandCatalog` 内部有 15s 上限，超时或
抛错都进同一个 `catch`，编辑器照常渲染本地已有的品牌。

**"这次同步没加新东西"绝不能让后面的读注册表也跳过**（10.12.0 修掉的真 bug）。原来的写法是
`if (outcome.ok && outcome.result.added.length === 0) return;`，注释还写着"列表已经加载过，
不必重读"——但在这条路径上**列表从来没加载过**：同步本身是启动流程的第一件事。于是只要目录是
最新的（也就是绝大多数时候），`loadBrandMaterials()` 一次都不执行，工具栏的品牌下拉永远是空的
「不使用品牌」，看起来就是"品牌不可选、只有 AI 生图时才起作用"。注册表才是真相源，同步只是
改动它的途径之一；读它必须是流程的固定一步，不是某个分支的附属动作。

**自填镜像**（`extraBaseUrls`）排在所有内置镜像之前，内置的仍跟在后面当兜底 —— "自己搭的镜像
先试，挂了还能落回 GitHub"。`isAllowedCatalogBase()` 把 `resolveCatalogBase` 的校验规则导出给
选项页，让卖家输错地址时当场就看到红字，而不是等到后台某次同步静默失败。字段存在
`ExtensionSettings.brandCatalogUrl`，`''` 表示"只用内置镜像"、`undefined` 表示"别动它"——
`saveSettings` 用 `??` 而不是 `||` 就是为了让 `''` 能真的清空。

### 11.10 测试边界（静默同步）

- `tests/unit/brand-catalog-sync.test.ts` 加了「自填镜像排在首位且内置不丢」「重复地址去重」两例；
- `tests/unit/brand-catalog-base.test.ts`：`isAllowedCatalogBase` 放行 https / loopback、拒绝公网
  http 与垃圾输入，并断言它与 `resolveCatalogUrl` 对同一地址的判断一致（避免"存得下、同步却拒"）；
- `tests/unit/silent-sync.test.ts`：一次标签页只给一次机会；新模块实例（新标签页）重新放行。
- 编辑器启动时的真实时序（首屏不等同步、失败静默）只能手工验，步骤见 `docs/manual-test.md` 5.74。

### 11.11 名称不参与匹配：`aliases` 为什么被删掉

品牌条目以前有三样东西：`name`、`aliases`、`keywords`，匹配时三样一起算
（`brandTerms()` 返回 `[name, ...aliases, ...keywords]`）。问题不是冗余，而是**两种职责混在
一个列表里**：

- `name` 是**显示名**，人读的，用来在选项页列表和编辑器品牌下拉里区分「魔方」和「万代」；
- `keywords` 是**匹配词**，机器用的，标题里出现就算这个品牌。

混在一起的后果是**名字本身变成了匹配器**。一条叫「魔方」的品牌会认领任何标题里带"魔方"的
商品 —— 包括那条商品只是描述"可以变成魔方"的别的品牌。反过来，「三零」「X社」这种两三个字
的显示名在中文标题里撞车概率极高。`aliases` 更是不可判定：它介于两者之间，谁都不知道一个新
词该写进哪一格，所以卖家只好两处都写，然后两处不同步。

现在只有两个字段，各管一件事：

| 字段 | 谁在读 | 参与标题匹配 |
| --- | --- | --- |
| `name` | 选项页列表、编辑器品牌下拉、图层名 | **否** |
| `keywords` | `matchBrandByTitle()` | 是（唯一的来源） |

`brandTerms()` 于是只剩一行 `return brand.keywords;`。想让显示名也能命中，就把它抄进关键词 ——
这件事是显式的、可见的、能被 `catalog:bump` 和选项页看见的，而不是藏在函数里的隐式行为。

**旧数据不降级**（两个入口，都在读的时候折，不在写的时候折）：

- `brand-store.ts`：`listBrands()` 把老条目上残留的 `aliases` 用 `foldLegacyTerms()` 并进
  `keywords`，并且**不把 `aliases` 带出去** —— 否则下一次 `updateBrand()` 写回时它又活了，
  等于永远删不干净。
- `schema.ts`：`readBrand()` 把 `manifest.brands[].aliases` 当额外关键词读（`mergeTerms()`）。
  这条是给**旧格式的 fork / 镜像 / 浏览器里缓存的旧 JSON** 用的，不是给我们自己的
  `catalog/brands.json` 用的（那份已经只有 `keywords`）。`check:catalog` 会对残留的 `aliases`
  打一条提示，但不会失败 —— 别人的镜像不该因为我们的重构而同步不了。

### 11.12 品牌区也是「一条摘要 + 按需展开」

选项页的品牌区一度是三条平铺的内容叠加：一块讲目录同步、三个输入框加上传按钮、然后每个品牌
两行输入框加 保存/删除。目录里 13 个品牌就是 26 个输入框常驻，读起来像一张要填的表，而这一页
真正被"读"的频率远高于被"改"。

现在三处都改成同一套形态 —— **收起时是一行摘要，选中才展开编辑**，与视觉接口链（§14.6）同一个
动机：屏幕上不该同时出现两组归属不明的输入框。

| 位置 | 收起时 | 展开后 |
| --- | --- | --- |
| 品牌目录（GitHub） | `品牌目录（GitHub）　已同步 v3 · 时间 · 镜像　[镜像设置] [立即同步]` + 一行「改完点同步就行」 | 说明段落 + 「自填目录地址」输入框 |
| 品牌商标 · 每一行 | 缩略图 · **名称** · 关键词 · `手动上传`/`目录同步` · [编辑] | 名称/关键词输入框 + 尺寸 + 「同步」勾选 + 保存 / 删除 / 收起 |
| 品牌商标 · 新增 | `[+ 添加品牌]` | Logo 上传 + 名称 + 关键词 + [添加品牌] |

几条刻意的选择：

- **收起时保留"能判断对错"的信息**：名称 + 关键词 + 来源。展开才看得到的只有一个用不上的尺寸
  （`48×48` 这种）。品牌区最常回答的问题是「这个品牌的关键词对不对」，不是「这张图多大」；
- **一次只展开一行**（`editingBrandId`），不是每行各自开合：两个品牌同时摊开时，屏幕上的输入框
  又变回归属不明；
- **保存/删除/添加成功都自动收起**：改完就该回到摘要，摘要显示的是刚存下去的值 —— 不收起的话
  用户分不清屏幕上这些字是"已保存"还是"还没保存"；
- 同步状态行（`catalogStatus` / `lastError`）**不藏在展开区里**：那是操作反馈，点了「立即同步」
  必须立刻看得见，收起来等于让人以为按钮没反应；
- 折叠状态是**纯 UI 状态**，不进存储也不进文档 —— 刷新后回到"全部收起"，因为那是默认的阅读形态。

## 12. 本地缓存：同一套素材不重算第二遍

### 12.1 为什么要有它

编辑器里的一切都是**会话级**的：`createSessionId()` 每次打开都换新 id，源图被复制成
`<imageId>` 这样的会话内 id，画布藏在 `aiee:doc:<sessionId>` 里。这个默认是对的（刷新不该
复活别人的画布），代价是每次进门都要重付两笔最贵的账：

- **抠图**：上传 + 服务端往返，一张图几十秒；
- **AI 识别素材角色**：token + 4–10 秒等待（它是「生成主图」里的第一段，不是独立按钮）。

而这两笔账都不依赖会话。抠图是**源图的函数**，主体/包装盒是**素材集合的函数**。所以缓存
不按会话，按**源图身份**。

### 12.2 三种缓存，各存什么

| 缓存 | key | 命中后省掉 |
| --- | --- | --- |
| 抠图 | 源图身份（CDN url；上传文件用 `label\|bytes\|宽x高`） | 上传 + 服务端抠图 |
| AI 绑定 | 素材集 + 视觉模型（`model` + `baseUrl` + 商品编号） | 一次视觉请求 |
| 成品 PNG | 素材集 + 模板 + 主体/包装盒 | 整条排版链 + 一次渲染 |

三者的 blob 都写进现有的 `blobs` 表，**不改 IndexedDB schema**（`DB_VERSION` 还是 1）：
id 是确定性的（`cutout-cache-<hash>` / `compose-result-<key>`），索引单独存在
`chrome.storage.local` 的 `aiee:compose-cache` 一个键里 —— 想清干净就删这一个键。

### 12.3 身份，而不是 id

缓存里存的是 `url:https://…` 这样的**身份**，不是 `material-cutout-3` 这种会话内 id。原因很
实际：跨会话的时候 materialId 全变了，存 id 等于永远不命中。AI 绑定因此也存身份，读回来
时再映射回本会话的素材；映射不上（那张图这次没进来）就当作没命中——**指向不了的结论比
重新问一次更糟**。

上传文件没有 url（`upload-images.ts` 里写的就是 `''`），所以用 `label|bytes|宽x高` 当身份：
同一个文件再选一次命中，换了文件就不命中。连字节数都不知道时才退回 `blob:` + 会话内 id，
等于放弃复用——宁可慢，不要串图。

**`blob:` 开头的 url 不算身份**（10.12.0 起）。那是本标签页 `URL.createObjectURL()` 造的临时
地址，同一张图下次打开就是另一个字符串；把它当身份等于给这张图**永久关掉复用**，而界面上
看起来只是"这个商品的缓存时好时坏"。粘贴、从本地补图这两种素材以前正是踩在这里。判断顺序
因此是：真 url → `label|bytes|宽x高` → 会话内 blobId。

### 12.4 失效规则：缓存键要盖住「变了的后果」，不多也不少

两个键的范围不一样，这是刻意的：

| 键 | 盖住什么 | 为什么 |
| --- | --- | --- |
| AI 绑定 `bindingKeyFor` | 商品编号（没有编号时才是整组源图身份）+ 模型 | 它回答的是"这批照片里哪张是主体"——一个 listing 问一次就够了。多加一张图、少一张图不改变这个答案，却会让旧答案作废，于是**每次打开都重新问一遍模型**，这正是"用了 AI 生图，下次打开还是重新生成"的主要来源 |
| 成品图 `resultKeyFor` | 商品编号 + 模板 + 主体身份 + 包装盒身份 | 成品 PNG 里只有主体、包装盒和模板；其余抠图不在画面上，不该能把它作废 |

模型留在键里（换模型就该重新问），**接口地址不留在键里**：切到备用网关判的是同一批照片，
旧答案依然成立。反过来，下面这些确实会让键变：

- 换主体图 / 换包装盒图 / 换模板 → key 变 → 不命中（符合直觉，不用解释 TTL）；
- 镜头顺序变了 → **仍然命中**（身份是集合，排序过）；
- 卖家在速卖通后台把图原地换掉但 CDN url 没变 → 还命中旧的抠图。这条跟图片下载器
  是同一个假设（url 即内容），出口是面板上的「清除本地缓存」。

### 12.5 缓存是优化，坏了不能变成故障

- 索引读坏 / 写不进（配额满）→ 一律当成"没有缓存"，编辑器照常跑；`createComposeCache`
  的每个方法都 `try/catch`，`parseComposeCacheState` 对任何垃圾输入返回空状态。
- 索引还在但 blob 没了（清过站点数据）→ `readResultBlob` / `hasCutoutBlob` 返回 null，
  调用方当作未命中。
- 上限：抠图 40 条、AI 绑定 16 条、成品图 12 条，按 `at` 丢最旧的（`pruneComposeCache`）。
  没有上限的缓存迟早把配额吃光，而配额满的表现是「加图失败」，离缓存十万八千里。

### 12.6 成品图什么时候拍

`pendingResultKey` 在排版成功后立刻设上，真正渲染由一个 effect 完成，而且要等**每个图片
图层都解码完**（`imageForLayer` 就是解码表）：早一帧拍出来的 PNG 里是空框。失败不打断流程——
画布已经在屏幕上，缓存写不进去不该看起来像「生成主图」坏了——但 10.12.0 起会
`console.warn('[AIEE] 成品图没写进本地缓存：', error)`：静默失败让"有的商品就是不缓存"变成
无法诊断的悬案，而这一行在正常路径上一次都不会出现。

面板上那一行是这套机制的出口：「已复用上次的抠图 n 张」「这套素材的成品图已缓存（时间）」、
「下载缓存成品图」（直接发文件，不重排不重抠）、「清除本地缓存」。

### 12.7 测试边界

- `tests/unit/compose-cache.test.ts`（29 例，纯 Node）：身份推导（url / 上传 / 只剩 blobId /
  `blob:` url 不算身份）、hash 稳定性与分隔符、绑定键按商品编号收敛（多一张图不失效、没编号
  才退回整组身份）、模型敏感而接口地址无关、结果键对模板/主体/包装盒/商品编号敏感、
  `parseComposeCacheState` 对垃圾输入的降级、裁剪到上限、写入/读回/清除、索引在而 blob 不在、
  存储写入抛错时照常返回。
- 存储用注入端口（`ComposeCachePorts`）模拟，仓库里没有 fake IndexedDB，缓存也不值得为它加一个。
- 真 IndexedDB 的往返仍靠手动测试（`docs/manual-test.md` §5.6x）。

## 13. 品牌 Logo：压在一切之上，默认锁定

### 13.1 为什么它不像水印那样"不在文档里"

水印（§2 那套 `useWatermark`）刻意活在 `EditorDocument` 之外：它必须扛过撤销 / 重做 / 清空，
把它放在文档里就得给每条 reducer 分支加豁免。品牌 Logo 有相反的需求 —— **它可以被解锁、拖动、
缩放**，也就是必须能进 undo 栈、能被 `COMMIT_LAYER` 改。

所以它是**普通文档图层**（`ImageLayer`，`kind: 'brand'`），只是多了一个 `locked?: boolean`。
"和一样水印"落实成三个画布行为，而不是一个存储位置：

1. **永远最后绘制**：`EditorStage` 的 `drawItems` 顺序是
   `用户图层 → 水印 → 编号 → 品牌 Logo`，所以 Logo 压过商品图、水印和编号文字（用户明确选了
   「Logo 压过一切」，否决了"编号仍最上"）。它不靠数组顺序保证这一点 —— 就算在层板里改顺序，
   也是最后画。
2. **默认锁定**：`createLogoLayer()` 产出 `locked: true`。锁定的图片节点 `listening={false}` +
   `draggable={false}`，画布上点不中、拖不动，点击穿透给下面那一层；Transformer 也不往它身上挂
   （`selectable` 里判 `lockedSelection`）。
3. **可解锁**：出口只有一个 —— 图层面板里那一行的「锁定 / 解锁」按钮（`handleToggleLock`）。
   解锁会顺手选中它，让手柄直接出现；锁上则把选中清掉，避免手柄留在动不了的图层上。

### 13.2 每个品牌各记一份位置

`src/services/logo-placement.ts`，存 `chrome.storage.local` 的 `aiee:logo-placement`
（`Record<brandId, {x, y, scale}>`）。

- **按品牌分开**，不共用一个位置：词标是 5:1、吉祥物是 1:1，共用一份会把其中一个摆到画布外。
- **默认位置**（`defaultLogoPlacement`）：右下角、留 `LOGO_MARGIN = 32`，最长边压到画布的
  `LOGO_DEFAULT_LONGEST_RATIO = 0.26`。右下角是卖家放品牌章的惯例，也躲开顶部的编号和居中的水印。
- **写入时机**：`handleCommitLayer` 里，patch 带 x/y/scale 且图层是 `brand` 时，`brandIdOf(materialId)`
  反推品牌 id 再写回。和 `codePlacement` 同一套做法（只在松手时写，拖动过程不碰存储）。
- **读改写的代价**：`saveLogoPlacement` 每次都先读回整张表再合入自己这一条，而不是拿着内存里的旧表直接覆盖 ——
  两个标签页各开一个商品页时，否则会互相抹掉对方的品牌。这一步多一点 IO，但只有一次写入、且不阻塞 UI。

### 13.3 生成主图时它不消失

`applyComposedPlan` 在 `planToLayers(plan)` 之后调用 `carriedLayers()`，把当前文档里所有
`kind === 'brand'` 的图层（以及模板没留位置的编号文字）原样追加上去 —— 见 §10.7.5。
排版替换的是商品图、衬板、模板自己带的文字区；品牌章不是"排版的一部分"，不该被生成动作抹掉 ——
和水印一样要留下。（`APPLY_PLAN` 依旧是**一个** history 条目，所以一次 Ctrl+Z 能整体退回。）

**识别到品牌但没有 Logo 图**（10.18.2）：标题命中关键词、`setActiveBrandId` 已经生效（下拉框显示品牌名），
但 `brandMaterials` 里找不到 `material-brand-<id>`（目录同步没拉下这张图，或手工上传的那张丢了）。
以前这里静默 `return`，界面呈现为"品牌选中了、画布上没有 Logo"，和"没从标题里提取"无法区分。
现在发一条 error notice 指向出口：去选项页「品牌商标」上传，或点「立即同步」。

### 13.4 测试边界

- `tests/unit/logo-placement.test.ts`（9 例）：默认位置的角落 / 26% 比例 / 未知尺寸回落、`parseLogoPlacementMap`
  对垃圾输入的降级、缺字段条目被丢弃、scale 夹紧、空 brandId 被忽略。
- `tests/unit/editor-reducer.test.ts` 里两条 `layer lock`：`COMMIT_LAYER { locked }` 能进文档、是一个可撤销步骤、
  撤销能恢复锁，且不改变图层身份。
- `tests/unit/compose-emit.test.ts`（6 例）锁 `carriedLayers()`：只搬 brand、plan 没编号时搬编号、
  plan 已有编号时不重复搬（trim 后比较）、空编号不搬、其它文字永不搬。
- 画布上的真实手感（点不中 / 解锁后能拖 / 记忆生效 / 换模板后编号还在）只能手动验（`docs/manual-test.md` §5.7x / 5.113）。

---

## 14. 视觉接口链：备用的那一个不是装饰

一开始只有一个视觉网关（`VisionSettings{baseUrl, model, apiKey}`）。问题不在协议，在**可用性**：
拿到的是本地网关 `127.0.0.1:8788`，而它有时候就是没起来——重启、容器忘了开。那时识别那一段
直接失败，卖家得自己去选项页改地址。多配几条地址能解决，但一旦是"多条"，就有一批细节必须定死。

### 14.1 存储形态与请求形态是两个类型

- `VisionEndpoint{baseUrl, model, apiKey}` —— **存的样子**。`model` / `apiKey` **允许为空**，空 = 继承主接口。
- `VisionSettings{baseUrl, model, apiKey}` —— **发请求的样子**，三个字段都已解析成确定值。

合成发生在 `resolveVisionConfigs()`：`model: row.model || base.model || DEFAULT_VISION_MODEL`，
`apiKey: row.apiKey || base.apiKey || DEFAULT_VISION_API_KEY`。为什么不在存储里就地填满？
因为选项页要显示**用户自己填的东西**：把继承来的值写回输入框，用户就再也删不掉了，而"留空 = 跟随主接口"
这个语义也会在第一次保存后消失。

> 顺带修掉的一个老坑：`loadSettings()` 以前在**读**的时候就把空 Key 换成默认 Key。现在存储保留空值，
> 默认值在发请求前才补上。请求行为不变（不会白着发 401），但选项页不再撒谎。

### 14.2 「任何失败都切」是刻意的

401 / 403 / 5xx / 超时 / 连不上 / 身体不是 JSON —— 全部切下一条，不分类。

反过来的设计（"鉴权失败值得重试/不该降级"）听起来更聪明，实际更糟：一个 Key 过期的备用网关会**永远**
挡住后面那个能用的网关，因为每次都在它这里停下。要判断"哪种错误该切"，得先知道用户为什么把它排在前面，
这个信息没人有。所以规则只有一条：**能答上就用，答不上就下一个**。

代价写在明处：全部失败时抛的是**第一条**的错误（用户心里的"主接口"，它的 status 最有意义），
其余接口的原因拼在 message 的括号里 —— 于是"是主接口挂了，还是所有地址都配错了"仍然分得出来。

### 14.3 记住上次成功的那个

`aiee:vision-pin` 存一个 `baseUrl`。命中就把它挪到最前，其余保持用户写的顺序。

为什么值得多一个存储键：没有它，主接口宕机期间**每次**绑定都要先等一次 15 秒超时，而绑定是每次生成主图
前都会做的一步。有了它，整个宕机期只多花一次超时。

只有**成功**才写 pin。失败也写的话，一个时好时坏的网关会把自己反复拉到队首，把好网关挤到后面。
pin 是优化，所以读写都包在 try/catch 里：存储坏掉时链路照走，只是不再"记住"（`askVisionWithFallback`
里连 `savePin()` 的 reject 都吞掉了——答案已经在手，不能因为记不住而丢掉）。

### 14.4 保存是"整体替换"，但旧调用方还能用

`saveSettings({ vision })` 接受两种：
- **数组** → 整条链替换。这是选项页发的，也是唯一能表达"删掉某一条"的形式。
- **单个对象** → 只补丁**第一条**（`{...current.vision[0], ...patch}`，备份行后面原样保留）。
  编辑器只知道一个地址、以及 10.8.x 之前的所有调用方都是这个形态。

`normalizeVisionEndpoints()` 兜住一切脏数据：数组里的非对象跳过、没有 `baseUrl` 的行丢弃、
按 `MAX_VISION_ENDPOINTS = 5` 截断、一条都不剩就回落到默认那一条。

### 14.5 为什么是 5 条

不是技术限制，是**时间**限制：每条串行发，5 条全挂就是最多 5 × 15 秒。真需要第六条的场景
（三个机房各两台）不在这套工作流的射程内，而让人误把十条粘进去的代价是每次绑定额外两分钟。

### 14.6 为什么设置页用下拉框，而不是平铺

第一版把每条网关渲染成一个带边框的块，全平铺在页面上。问题不在"难看"，在**归属不明**：三条网关就是
九个输入框，改到一半再滚一下，眼前这三个属于哪条得往回找那行标题；常见情况其实只有一条网关，
却要占掉整屏。现在改成**一个下拉框 + 一组按需展开的输入框**：

- 下拉选项是「主接口 — 127.0.0.1:8788」这种形式（`endpointLabel()` 拼的是序号 + 地址的 host）——
  序号说位置，host 才是能把两条备用区分开的东西；
- **默认收起**：下拉的第一项是占位「选择要编辑的接口…」，`visionTab` 的类型就是 `number | null`，
  `null` = 什么都不展开。这不是省几个像素 —— 这份配置一年改两次，三个常驻输入框会让整页读起来像
  "必须填的表"；收起状态下这一节的正文只有一行，把"链的顺序 + 每条是谁"说完就够；
- 选中一个才渲染那三个输入框，所以不存在"这是谁的模型"的疑问；同一时间最多一组输入框在场；
- 收起有两个出口：下拉选回占位项，或点行内的「收起」（灰色，故意比红色的「移除这个接口」轻）；
- `+ 添加接口` 会**展开**新加的那条，否则新行加在下面、屏幕上什么也没变，按钮看起来没反应；
- 加的是**空地址行**，而 `rowsForSave()` 会丢掉空地址行 —— 所以展开时会提示「这个接口还没填地址，
  保存时会被丢掉」，避免"加了一行、保存后就没了"的困惑；
- **保存成功后自动收起**（`setVisionTab(null)`）：改完就回到那一行摘要，不给"改到一半"的错觉；
- 删掉当前行时也是**收起**而不是滑到隔壁（`removeEndpoint()` → `setVisionTab(null)`）：滑过去会在同一个
  位置换上另一条网关的地址，最容易看错；其余情况渲染时按长度夹紧（`editingIndex`），
  不给"下拉指向不存在的行"留空档。

### 14.7 测试边界

- `tests/unit/vision-endpoints.test.ts`（14 例）：继承规则、空链回 `[]`、`orderByPin` 三种情况、
  逐条回退（500 → 备用答上、400 → 切走、连不上 → 切走）、只 pin 成功者、全挂时抛第一条的 code/status
  且 message 含其余 host、pin 存储抛错也照常返回答案、空链直接抛「没有配置视觉接口」且**不发请求**。
- `tests/unit/settings.test.ts`：存储侧的 13 例（旧对象升级成一条链、丢无地址行、脏值回落、列表整体替换、
  单对象只改主接口）。
- 真网关的两跳（主接口真的关掉、备用真的答上）只能手动验，见 `docs/manual-test.md` §5.79–5.81。

## 15. 设置页：四个分类、一条摘要、一次保存

选项页以前是**一列到底**的单文件（1191 行）：账号 → 视觉 → 水印 → 品牌，全部平铺。问题不是长，
而是**没有层次**：接口路径、SESSION Cookie、错误码、六个输入框、十三行品牌，读起来同等重要。
真正每天要看的只有"连上没有、几个品牌在同步"，其余一年改两次。

现在分成四块，一次只显示一块：

| 分类 | 常驻可见 | 收在折叠面板 / 抽屉里 |
| --- | --- | --- |
| 账号连接 | 服务地址、账号、角色、连接状态 | 账号密码表单（登录后收起）、接口路径与 SESSION Cookie |
| AI 视觉 | 每个接口一行摘要（主/备N · host · 模型 · 上次测试结论） | 地址 / 模型 / Key 三个输入框 |
| 水印 | 数量 + 当前默认水印缩略图与尺寸 | 上传、列表改名、设默认、删除 |
| 品牌商标 | 数量、搜索、目录同步摘要、每行 Logo+名称+关键词数+来源 | 添加表单、编辑抽屉、自填目录地址 |

### 15.1 四个面板同时挂载，非活动的用 `hidden`

分类切换**不卸载**面板，只是把非活动的那块 `hidden` 掉（`.opt-page [hidden]{display:none!important}`，
对抗 `display:grid` 之类的覆盖）。这样"切走再切回来，没保存的草稿还在"是 DOM 的结果，不需要
把草稿存到别处再恢复 —— 后者要维护一份"暂存结构"，而它一定会和表单逐渐不同步。

代价是所有面板的 effect 一直活着。这里可以接受：四个面板都不发网络请求（数据由外壳加载一次），
唯一的副作用是缩略图的 `objectURL` 池，而那个池本来就是按 id 复用的。

### 15.2 只有一条提交路径

`saveSettings(origin)` 是唯一会发 `SAVE_SETTINGS` 的函数。抽屉里的「保存视觉设置」与底部的
「保存更改」都调它，`origin` 只决定提示文案。

这不是洁癖：10.8.1 那个 bug 就是**同一个设置被两条路径分别拼参数**，其中一条漏了 `vision`，
于是"改了但存不下来"。只要有两个地方各拼一次 payload，就总有一个会漏。收成一个函数后，
"哪些字段会被保存"只有一个答案（`rowsForSave()` 里的那份）。

### 15.3 脏标记是一份指纹，不是一堆 boolean

```ts
snapshotOf({ serverUrl, username, catalogUrl, vision }) // JSON.stringify(trim + rowsForSave)
```

加载后存一份、保存成功后再存一份，`dirty = 当前指纹 !== 已保存指纹`。底部按钮的禁用、`beforeunload`
的提醒都读它。

为什么不用 `serverUrlDirty || visionDirty || …`：每加一个字段就要记得加一个 boolean、记得在保存成功后
清掉、记得在"放弃修改"里重置，漏一处就是"明明存好了按钮还亮着"或者反过来"改了却存不了"。
指纹是**结构化**的：字段增减自动跟着走，而且天然忽略不影响存储的东西（密码、翻页、搜索词、展开状态）。

配套的三件事：`beforeunload` 里有未保存改动才拦（`event.returnValue=''`，文案由浏览器决定）；
保存失败**不清**指纹（草稿必须留着，用户要能改完再试）；「放弃修改」重新 `loadSettings()` 而不是
把字段一个个还原 —— 后者是又一份"字段清单"。

### 15.4 状态分两层：人话在前，技术细节在折叠面板里

成功是紧凑的绿色徽标（`.opt-badge--ok` + 文字，不只靠颜色）；警告/错误是独立的提示卡
（`Notice`，`role="alert"` 只在 error 时），**默认只给人话摘要**，完整错误码与堆栈放在
「查看详情」的 `<details>` 里。

页头只留"标题 + 一句说明 + 连接状态 + 账号名·角色"。接口路径、SESSION Cookie、`lastError` 的原文
全部挪进账号区的「技术说明」折叠面板 —— 需要它们的时候是排查，不需要的时候是噪音。

### 15.5 列表必须封顶

品牌目录里 13 个品牌，将来会更多；水印也可能几十个。所以两处都分页（每页 10 条，`Pager`
带「共 N · 第 x/y 页」），品牌区另有搜索框（按名称 / slug / 关键词，不区分大小写）。

分页而不是"内部滚动"：滚动区里的最后一行永远挨着页面底部，和固定保存栏抢位置；
而且"这页到底有多少条"没法一眼看出来。删到当前页空了的时候 `safePage` 会把页码夹回去，
不留一页空白。

### 15.6 添加/编辑用抽屉，不在列表里展开

品牌行的编辑从"原地展开六个控件"换成右侧抽屉（`.opt-drawer`，420px，Esc 关闭、焦点进来、
`aria-modal`）。原因同 §11.12 但更进一步：编辑一张 Logo 要填的东西（名称 / 关键词 / 是否跟随同步 /
尺寸 / 删除）本来就比一行高，塞进列表会让那一行比别的行高两倍，缩略图对不齐。

### 15.7 样式搬了家

`opt-` 前缀的全部规则在 `src/options/options.css`，由 `src/options/main.tsx` 引入；
`src/editor/styles/index.css` 里原来那段 `.options`（约 400 行）已删除，只留编辑器的样式和
按钮/变量的全局基础。理由很直接：设置页的样式改一次就要动编辑器的样式表，两边互相影响。
`main.tsx` 仍先引 `index.css`（`--border`、`button.primary` 等基础靠它），再引 `options.css`。

### 15.8 错误记录：一条摘要 + 一份历史

失败原来只写一个 `aiee:last-error`，后一次覆盖前一次。于是"同一个毛病又犯了"和"换了个毛病"
在界面上长得一模一样，而卖家最想知道的恰恰是**这是不是老毛病**（比如每次点错标签页都会来一条
`E_UNSUPPORTED_PAGE`，看到 `×7` 就知道不用管它，看到一条新的才需要处理）。

现在的形状（`src/services/error-log.ts`）：

| 位置 | 内容 |
| --- | --- |
| `aiee:error-log` | `[{ code, message, at, count }]`，新的在前，最多 `ERROR_LOG_MAX = 20` 类 |
| `aiee:last-error` | 仍在写，形状不变 —— 老版本插件读的是它 |

四条规则：

1. **只和最新那条合并**。同一个 `code + message` 连续发生就 `count + 1`、刷新 `at`；
   中间夹了别的错误则重开一条。「A、B、A」和「A 发生了两次」是两种现场，合并掉就丢了顺序。
2. **20 类封顶**。够看出重复了；`chrome.storage.local` 每次写都要序列化整个值，
   在"写失败"的那个时刻堆长文本没有好处。
3. **读的时候兜底**。`parseErrorLog()` 丢掉没有 `message` 的条目、把非数字的 `at`/`count` 收成
   合理值、按时间重排、截断到上限；存储里是垃圾就是一个空记录表，绝不让它把设置页弄崩。
4. **写失败不算失败**。`appendError()` 里所有存储调用都 try/catch：记录本身不能变成第二个故障。

界面上只露两个口：账号区顶部一张红色提示卡（最近一次，人话摘要 + 「查看详情」给 code/时间），
以及下面折叠的「错误记录（N 类，共 M 次）」，展开是 `时间 · code · ×次数 · message` 的清单和
「清空记录」。**只有一条时这个折叠块根本不渲染** —— 上面那张卡已经说完了，再加一块红色只是噪音。

### 15.9 测试边界

选项页**没有任何单测**，这次也没有为它新增：它的逻辑几乎全是"把值搬进消息里"，真正的分叉
（`rowsForSave` / `endpointLabel` / `normalizeVisionEndpoints`）都在 `src/options/helpers.ts` 与
`src/services/` 里，后者有测试。界面本身靠 `docs/manual-test.md` §5.90–5.101 手验。

`typecheck` 是这里的真实防线：四个 section 的 props 形状由 `interface` 钉住，改一个字段名
会在这里先断，而不是在浏览器里变成 `undefined`。

错误记录是例外：它的合并/兜底规则在 `tests/unit/error-log.test.ts`（18 例），因为它不是"搬值"，
而是一小段有分支的逻辑。


