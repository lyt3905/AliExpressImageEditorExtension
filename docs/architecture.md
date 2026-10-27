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
- **是按钮，不是自动触发**。自动选错比不选更糟：版式看起来像"设计过的"，没人会怀疑主体选错了。
  标签启发式（`bind-materials.ts`）始终垫在下面，网关挂了只损失一次点击。
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

### 10.9 测试边界

- 求解器、模板校验、plan→图层：**node 下全可测**（`AlphaProfile` 与 `MeasureText` 都是注入端口）。
- `probeAlphaProfile` / `blobToThumbnailDataUrl` 只能在浏览器跑 —— 所以它们的逻辑被压到 `alpha-scan.ts`
  与 `scanAlpha` 里，薄壳只剩"解码 + 读取像素"。
- `tests/live/vision.live.test.ts`：真网关契约测试，默认 skip（`AIEE_LIVE=1 AIEE_VISION_KEY=…`）。
  它用 node 现场生成的 PNG（蓝色立板 / 棕色双面箱体）跑真实 `VisionBinder`，断言角色判对 ——
  fixture 故意做得毫无歧义，所以判错意味着 prompt 或模型变了，而不是"模型今天心情不好"。

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
   名称/别名/关键词保持卖家的措辞。
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
- 真网络没有自动测试：`catalog/brands.json` 的示例用两张占位 Logo，真图由卖家自己放进去。



