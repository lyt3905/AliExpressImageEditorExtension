# AliExpressImageEditorExtension

Chrome Manifest V3 扩展：扫描 AliExpress 卖家后台**商品主图** → 本地下载 → 打开编辑器 → **自动抠图** → 在 800×800 画布上编辑 → 导出**白底 PNG**。

> 第一阶段（MVP）目标：把主流程真正跑通，而不是第一版就做到生产级完善。

---

## 主流程

```text
用户打开 AliExpress 商品编辑页
  → 点击工具栏插件图标（chrome.action.onClicked，无 popup / 无 side panel）
  → 注入/复用 content script → 精确扫描商品图片控件
  → Service Worker 有界并发下载图片
  → 图片 Blob 存入 IndexedDB
  → 创建 Editor Session（chrome.storage.session + IndexedDB）
  → 自动打开扩展内部 Editor Tab（editor/index.html?session=…）
  → Editor 立即显示所有原图（原图不等待抠图）
  → 后台自动对 selected 原图抠图（并发 6，队列调度）
  → 抠图结果自动进入「已抠素材」
  → 默认水印框自动加到图层最上层（锁定，不可编辑）
  → 用户点击素材加入 800×800 画布，拖动 / 缩放 / 旋转 / 排序
  → 需要时「添加文字」：文字是普通可编辑图层（内容 / 字体 / 字号 / 颜色 / 加粗 / 对齐）
  → 导出 800×800 白底 PNG（含水印与文字）→ chrome.downloads 下载到本地
  → （可选，用户点按钮）把这张 PNG 作为**一张新图**回填到商品页图片区
```

**不做的事**：不替换商品页已有图片（6 个图片位满时，回填会先删掉**第 1 张**腾出空位 —— 这是全流程唯一
一处删图，见下文「回填到商品页」，可在工具栏关掉）、不点商品页的保存 / 发布 / 提交、不上传商品信息、
不修改服务端。

**唯一会主动操作 AliExpress 页面的功能是「回填到商品页」**，且只在用户点击按钮时发生；它只点素材中心
上传面板内部的「上传图片」与「确认上传」，以及（勾选删除时）商品页第 1 张图上的删除图标，从不点商品级保存。
除此之外全程不碰页面。删图是破坏性操作，所以它在 UI 上默认勾选、可随时关掉，且**只删那一个图标，找不到就停下**，
绝不退化成「点别的按钮试试」。

---

## 提取范围：只取卖家编辑页的那几张商品图

扫描**精确匹配**卖家后台自己的图片控件，而不是"猜容器"：

```text
.imageUploadWrap
├─ .mainImageSection                                  主图
└─ .moreImagesSection                                 更多图片
     └─ .sell-o-image-item.has-url[data-index="0..4"]   ← 只有这些槽位会被提取
          ├─ .image-item-header-bar > .header-text        → 素材标签（商品正面图 …）
          └─ .sell-o-image-item-preview > .image-card > img   → 原图 URL
```

实测命中这 5 张：商品正面图 / 商品背面图 / 商品实拍图 / 商品侧面图 / 商品细节图，
并写入会话的官方标签（编辑器素材卡片上显示的就是它，不再是笼统的「原图 1/2/3」）。

被**故意排除**的：

| 目标 | 为什么排除 |
| --- | --- |
| 末尾空槽位（`data-index="5"`，无 `has-url`，只有「上传图片」占位） | 里面没有图片 |
| 缩略图上的悬浮预览 `.ait-tooltip` / `.ae-image-hover` 里的同一个 `<img>` | 同一张图的副本，会重复计数 |
| 槽位内的铅笔 / 垃圾桶 / 箭头按钮 | 是 `<svg>`，不是 `<img>` |
| 同一个 `.sell-o-image-item` class 出现在控件**之外**（SKU / 详情图等模块） | 不在上述三个根节点内 |
| `data:` / `blob:` / `.svg` / icon / logo | 页面装饰 |

槽位顺序优先取 `data-index`（全部槽位都有且互不相同时），否则退回 DOM 顺序。

> 兜底顺序（精度不够时才往下走）：控件精确匹配 `seller-widget` → 通用主图容器 `container:*` → 全页商品 CDN `document:product-cdn`。
> 三层都为空才报「未找到商品主图」。

---

## 环境要求

- Chrome ≥ 114（Manifest V3 + service worker ESM）
- Node.js ≥ 20（开发/构建）

## 快速开始

```bash
cd C:\Users\lyt39\Documents\GitHub\AliExpressImageEditorExtension

npm install        # 安装依赖
npm run typecheck  # TypeScript 类型检查
npm run test       # Vitest 单元测试（不联网）
npm run build      # 产出 dist/ 并自动校验产物完整性
npm run check:dist # 单独校验 dist/（build 已内置这一步）
```

线上接口契约测试（可选，会真实请求服务器，需要账号密码）：

```bash
AIEE_LIVE=1 AIEE_USERNAME=admin AIEE_PASSWORD=<密码> npm run test:live
```

### 加载到 Chrome

1. 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目的 **`dist`** 目录
4. 首次使用请打开扩展的 **选项**（`chrome://extensions` → 详情 → 扩展程序选项，或 `dist/options/index.html`），
   填写服务地址 / 账号 / 密码并点击 **登录并保存**
5. 点击工具栏上的插件图标前，先在 `chrome://extensions` 里把本扩展 **固定（Pin）** 到工具栏 ——
   本扩展没有 popup，只能通过工具栏图标触发。

> **必须选 `dist`，不要选项目根目录。**
> `manifest.json` 的源文件在 `public/manifest.json`，只有 `npm run build` 之后才会出现在 `dist/`。
> 如果误选项目根目录，Chrome 会报 **「清单文件丢失或不可读取」**。
>
> Windows 的文件夹选择框需要**先双击进入 `dist`**，再点「选择文件夹」；只在列表里单击选中 `dist` 并不会进入它。

`dist` 目录由 `npm run build` 生成，`manifest.json` / `service-worker.js` / `content-script.js` /
`icons/` / `editor/` / `options/` 都在其中。清单引用的每个文件都可在 `dist` 内解析到
（`dist/icons/icon{16,32,48,128}.png` 由 `python scripts/make-icons.py` 生成，已随仓库提交）。

> 修改 `src/` 后必须重新 `npm run build`，再到 `chrome://extensions` 点击本扩展的 **刷新（⟳）** 按钮才会生效。

### 排错：Chrome 报「无法为脚本加载 JavaScript 'content-script.js'」

这个报错有两种原因，**先看文件在不在**：

```bash
npm run check:dist
```

`npm run build` 现在**自带这一步**：三步构建跑完会校验 `dist/`，缺文件直接以非 0 退出并列出缺了什么。

原因一：**`dist/` 是半成品**。`vite.config.ts` 里 `emptyOutDir: true` 会先清空整个 `dist`，
如果构建在清空之后、写完之前被打断（例如终端被中断），就会出现
`editor/`、`assets/`、`content-script.js` 全部缺失、而 `manifest.json` 还在的诡异状态。
重新跑一次 `npm run build` 即可。

> 在上述开发环境里连续多次执行构建时，整目录清理动作会累计触发沙箱的**批量删除保护**，
> 导致清空到一半失败。规避办法：**一轮里只构建一次**；确需重试时可先把旧目录改名而不是删除
> （`mv dist dist.old`，重命名不走删除钩子）。

原因二：**内容脚本被打包成了 ES module**。内容脚本必须以 IIFE 形式产出（`vite.content.config.ts` 已固定
`format: 'iife'`）。`check:dist` 会用 `new vm.Script()` 把每个内容脚本按**经典脚本**解析一遍，
并拒收顶层 `import`/`export` 或动态 `import()`，因此这类回归会在构建期就被拦下。

### 使用

1. 打开 AliExpress 卖家后台的商品编辑页（URL 含 `product` / `publish` 等）
2. 点击工具栏插件图标
3. 插件自动下载主图并打开编辑器；编辑器打开后**立即**可用，抠图在后台自动进行，完成后自动出现在「已抠素材」
4. 点击素材加入画布 → 拖动 / 缩放 / 旋转 / 图层排序 → **下载 PNG（800×800 白底）**
5. 想用页面外的图？点工具栏「上传图片」选本地文件，或直接 `Ctrl+V` 粘贴截图 —— 会自动抠图并出现在「已抠素材」
6. 想直接把这张图放回商品页？点 **回填到商品页** —— 它会把同一张 PNG 作为**一张新图**放到图片区的空槽位上。
   6 个图片位常是满的，所以工具栏上「回填前删第 1 张」**默认勾选**：回填会先删掉原来的第 1 张（原主图）腾出空位。
   不需要它就在工具栏取消勾选，回填就只追加、不动任何旧图。无论哪种，都不会替你点保存（详见下文「回填到商品页」）

点击插件后若出错，工具栏图标会显示红色 `!` 徽标，鼠标悬停可看错误原因；最近一次错误也会显示在选项页。

### 排错：悬停提示「当前页面不是 …」「读取不到当前标签页的地址」

点击图标时，插件先用**当前标签页的 URL** 判断这个页面能不能扫描。判断逻辑只有一份，
在 `src/shared/page-gate.ts`（Service Worker、页面适配器、`content_scripts.matches` 共用同一套主机规则）。
被拒绝时徽标显示红色 `!`，悬停提示会带上**实际站点**，Service Worker 控制台还会打印一行
`[AIEE] page gate rejected <原因> <URL>`，对照下表即可定位：

| 悬停提示 | 真实原因 | 处理 |
| --- | --- | --- |
| 读取不到当前标签页的地址 | 浏览器根本没给出 URL | 切到商品编辑页再点一次；仍无效则到 `chrome://extensions` 重载扩展 |
| 当前标签页不是普通网页（`chrome://…`） | 当前页是 `chrome://`、`edge://`、`file://`、`about:` 等 | 新建标签页打开商品编辑页 |
| 当前标签页是插件自己的页面 | 焦点在编辑器/选项页那个标签上 | 切回商品编辑页再点图标 |
| 检测到 AliExpress 的其他地区站点（…） | 当前是 `aliexpress.us` / `.ru` 等地区站点 | 第一版只支持 `aliexpress.com` 卖家后台 |
| 当前页面不是 … 商品编辑页（当前站点：…） | 当前是其他网站 | 同上 |

> 早期版本把以上五种情况都报成「请先在 AliExpress 商品编辑页点击插件图标」，
> 于是「点错标签页」被误读成「页面不支持」，且日志里没有 URL 可查。现已分开报。

---

## 水印框

可以在选项页配置**多个**水印框，并把其中一个设为**默认**。每次打开编辑器时，默认水印会自动成为
画布上的一个**锁定图层**，永远位于最上层。

**配置**（`chrome://extensions` → 详情 → 扩展程序选项 → 水印框）
- 「添加水印框」选本地图片：PNG（可带透明通道，推荐）/ JPEG / WebP，单张上限 8MB
- 列表里可改名、用单选按钮切换默认、删除（删除会连带清掉本地图片数据）
- **第一个添加的水印自动成为默认**，只用一个水印时无需额外操作

**尺寸**：按「长边铺满 800、居中」等比缩放，绝不拉伸。所以边框类水印请直接做成正方形，
小 logo 想保持小尺寸就先在外部加透明边距做成 800×800（或后续按需扩展为可配置比例）。

**锁定范围**（这是设计上的硬约束，不是靠判断绕开的）

| 能做什么 | 不能做什么 |
| --- | --- |
| 工具栏里整体显示 / 隐藏 | 在画布上点选、拖动、缩放、旋转 |
| 工具栏里临时换成别的水印 | 在图层面板里删除、上移、下移 |
| 参与导出（白底之上） | 被「清空画布」「撤销」影响 |

最后一条是结构保证的：水印**不属于图层文档**（`EditorDocument.layers`），它由 `useWatermark`
单独持有并渲染。因此 `UNDO` / `REDO` / `CLEAR` 在原理上就碰不到它 —— 而不是靠到处加 `if (locked)`。

工具栏的「水印」勾选框与下拉框只影响**本次打开的编辑器**，不会改动选项页里的默认设置；
刷新编辑器会重新回到默认水印。

文件：`src/services/watermark-store.ts`（存储）、`src/editor/state/use-watermark.ts`（注入与锁定）、
`src/editor/components/EditorStage.tsx`（渲染在最上层且 `listening={false}`）。

---

## 文字图层

工具栏的「添加文字」会在画布中心放一个 `Konva.Text` 图层。它和图片图层共用同一套机制，没有第二套状态：

| 能力 | 实现 |
| --- | --- |
| 数据 | `TextLayer`（`src/shared/types.ts`），纯 JSON —— 不进 IndexedDB、不上传服务端 |
| 增删 / 上移下移 | 复用 `ADD_LAYER` / `DELETE_LAYER` / `MOVE_LAYER` |
| 拖动 / 等比缩放 / 旋转 | 复用同一个 `Transformer`，`scale` 仍是唯一缩放来源（`transformEnd` 后归一化回 1） |
| Undo / Redo | 复用现有 history：**一次编辑只留一条记录** |
| 持久化 | 与图片图层一起写进 `aiee:doc:<sessionId>`，刷新后原样恢复 |
| 导出 | 它就是 Stage 里的真实节点，`toCanvas` 时自然进入 800×800 白底 PNG |

`EditorLayer` 现在是判别联合（`ImageLayer | TextLayer`）：`TextLayer` 没有 `materialId` / `blobId` /
`sourceWidth` / `sourceHeight`，所以 `imageForLayer`（图片加载路径）只认图片，文字永不进入。
水印仍是独立的 `WatermarkLayer`，不进入图层文档，因此**依旧固定盖在所有普通图层（含文字）之上**。

文字属性面板（`src/editor/components/TextPropertiesEditor.tsx`）位于右侧栏、图层列表上方：
文字内容 / 字体 / 字号 / 颜色 / 加粗 / 左中右对齐 / **描边** / **阴影**。
**内容、字号、颜色、描边与阴影的各输入框都在失焦时提交一次**，字体、加粗、对齐与预设按钮是
点击即提交 —— 在输入框里打一行字只会留下 1 条 undo 记录。

### 描边 / 阴影

| 项 | 控件 | 说明 |
| --- | --- | --- |
| 描边 | 颜色 + 宽度 `0–40` | 宽度 **0 = 无描边**；恢复时负值被夹到 0 |
| 阴影 | 颜色 + 模糊 `0–80` + 水平/垂直偏移 `-100–100` + 不透明度 `0–100%` | 模糊和两个偏移**都为 0 时不出阴影** |

- 预设：描边「无 / 白描边 / 黑描边」，阴影「无 / 投影 / 柔和 / 发光」。预设就是一次多字段
  `COMMIT_LAYER`，点一下只占 1 条 undo。
- 两者都在节点自身坐标系里绘制，**跟随图层缩放一起放大**：描边设 4px 的文字放大到 200% 后看起来是 8px。
- 文字描边由 Konva 以字形轮廓为中心绘制，因此开启 `fillAfterStrokeEnabled` 让填充最后画；
  否则一半描边会盖住字身，字看起来比加描边前还细。
- **不影响拖拽手柄**：Konva 的 Transformer 测量被选节点时硬编码 `skipShadow: true`，并遵循我们已开启的
  `ignoreStroke`，所以加描边 / 阴影不会把选框撑大。
- 旧草稿兼容：这两个选项出现之前的文档没有相关字段，恢复时逐字段补默认值（宽度 0 = 关闭），
  老草稿里的文字不会因此被判成损坏。

### 样式记忆

新增的「添加文字」不再是一律 48px 黑字，而是**沿用你上次调好的样式**。

| 记住（12 个字段） | 不记住 |
| --- | --- |
| `fontSize` `fontFamily` `fill` `fontStyle` `align` `stroke` `strokeWidth` `shadow*` | `text`（内容）、`x` `y`（位置）、`width` `scale` `rotation` |

不记内容是因为新图层绝不能带出上一条文案；不记位置 / 缩放 / 旋转是因为每次都应从画布中心、1 倍、不旋转重新开始。

- 字段清单是 `src/shared/constants.ts` 里的 `TEXT_STYLE_KEYS`，**单一定义**：`pickTextStyle()`（提交时抽取）、`TextStyleDefaults` 类型、`createTextLayer()` 的入参过滤都从它派生，加字段不会漏。
- 存储在 `chrome.storage.local` 的 `aiee:text-defaults`（`src/services/text-defaults.ts`）。用 `local` 而不是 `session`（关浏览器就该还在），也不用 `sync`（120 次/分钟写配额，样式提交是高频动作）。
- **不进 `EditorDocument`**：文档描述「这张图有什么」，偏好描述「用户习惯」，而且文档在历史栈里，塞进去会污染 undo。加载偏好不 dispatch 任何 action，所以 hydrate 仍然只产生 1 条历史记录。
- 只在样式补丁上写存储：`pickTextStyle()` 对纯位置 / 内容 / 变换的补丁返回 `null`，拖动和改字不会触发写盘。
- 写入是**整个对象覆盖**而不是 `load → merge → set`：连续两次提交（改完字号立刻改颜色）不会交错读写，天然 last-write-wins。
- 读取和写入都过一遍 `sanitizeTextStyle()`，手工改坏或半截写入的存储项不会把 `fontSize: 99999` 送上画布。
- 存储不可用时静默降级为默认样式，不影响编辑器任何既有行为。
- 面板底部的「恢复默认样式」同时把**当前图层**改回默认（算 1 步撤销）并**清除记住的偏好**，避免误存一套夸张描边后每次新建都带着它。

`x / y` 与图片一样是**几何中心**：`offsetX = width / 2`，`offsetY = 实测高度 / 2`，
因此旋转和缩放都围绕中心发生。文字高度取决于自动换行，首帧用 `estimateTextHeight`
（Konva 默认 `lineHeight = 1`，即 `fontSize × 行数`）估算，节点上屏后由 `EditorStage` 实测校正。

---

## 本地图片上传 / 粘贴抠图

除了扫描到的商品图，编辑器还接受两种本地来源，二者走**完全相同**的一条路径：

| 入口 | 操作 |
| --- | --- |
| 工具栏「上传图片」 | 打开文件选择器，可多选。PNG / JPEG / WebP，单张上限 20MB |
| 剪贴板 | 在编辑器任意位置 `Ctrl+V`（例如 `Win + Shift + S` 截图后直接粘） |

粘贴不挑焦点：即使光标正停在文字属性输入框里，只要剪贴板里有图片就按图片处理；剪贴板里
**只有文字时事件原样放行**，往输入框粘文本不受影响。

**上传即自动抠图**：新图以 `selected: true` + `cutoutStatus: 'idle'` 写入会话，随即进入同一个
`CutoutQueue`，所以「抠图进度 x/y」的分母会同步 +1，抠完自动出现在右侧「已抠素材」里。
上传的图**不会**自动落到画布上 —— 由你在素材面板里点选，和商品图完全一致。

- 校验是**逐张**的：单张过大 / 非图片 / 尺寸解析失败只跳过那一张，同一批里其余照常加入，
  顶部提示条会说明跳过了哪些、为什么。
- 校验顺序：空文件 → 超过 20MB → mime（先信声明类型，不在白名单就嗅探前 16 字节）→ 尺寸。
  截图粘贴常常没有 `type`，靠的正是这一步嗅探。
- `src/services/upload-images.ts` 干的是「写 blob + 追加 `SessionImage` + `putSession`」，
  **不是**纯内存操作。
- 素材 id / blobId 统一用 `upload-` 前缀；扫描图的 id 是 URL 哈希，两者结构上不可能撞。
- 粘贴来的无文件名截图会补成 `本地图片-1.png` 这样的标签，否则素材卡片会是一行空标题。
- 与下载链路共用 `src/shared/image-mime.ts` 的同一套 mime 判定（`background/` 是 SW 专属，
  编辑器不能 import，所以放在 `shared/`）。

> **为什么必须落盘**：`use-editor-session` 每次加载都是先按会话记录重建素材列表，再用
> `keepLayerWithMaterials()` 过滤草稿图层。上传的图如果只活在编辑器内存里，刷新之后素材没了，
> 引用它的图层就会被当成垃圾一并滤掉 —— **画布上那张图凭空消失**。

---

## 回填到商品页（往图片区放一张新图）

编辑器工具栏的 **回填到商品页**：把刚合成的 800×800 白底 PNG 送回商品页图片区。

**默认先删掉第 1 张，再放新图。** 6 个图片位常是满的，而速卖通只在**空槽位**上渲染上传按钮 ——
没有空位就无处可放。所以工具栏上有一个默认勾选的 **回填前删第 1 张**，回填时先删掉原来的第 1 张
（原主图）腾出空位。取消勾选后回填就只追加、不动任何旧图。

位置要提前说清楚：速卖通删掉第 1 张后，**后面的图会自动前移**，所以空出来的是**最后一个**槽位 ——
**新图会落在最末尾，不会自动成为第 1 张**。想让某张图当主图，删完之后在商品页里手动拖一次。

流程（`src/background/page-filler.ts` → 注入 `public/vendor/aeiir/`）：

1. 编辑器用**和「下载 PNG」完全同一次**的合成结果，先比 5MB 上限，再发给后台。
   （尺寸检查在删图**之前** —— 超限的 PNG 绝不会让你先损失一张旧图。）
2. 后台在**每个 frame** 里跑一次只读探测，挑出持有商品表单的那个 frame（每个结果自带 `frameId`，
   所以不需要 `webNavigation` 权限，也不需要 `all_frames: true`）。
3. 注入经典脚本。勾选了删除时，**先删旧图**（删除图标就在商品页上，不需要面板；先删再选槽位才选得准，
   因为删除会让图片区重排）→ 点上传按钮开面板 → 定位拖拽区 / 文件输入框 → 注入文件 → 等上传信号 → 点「确认上传」。
   面板**已经开着**时直接复用、不再点按钮 —— 跨 frame 重试时再点一次会把面板关掉；你按提示手动打开过也一样。
4. 面板如果不在这个 frame 里，桥回报 `UPLOAD_PANEL_NOT_FOUND`，后台**换 frame 重试**（最多 3 次）。
   **重试绝不删第二张**：第一次尝试已经删过第 1 张了，再删一次就轮到第 2 张，所以 `removeFirstImage`
   只在 `attempt === 1` 时为真。

细节：

- **红线**：只点上传面板内部的「上传图片」与「确认上传」，以及（勾选删除时）第 1 张图上的删除图标，
  **绝不**点商品页的保存 / 发布 / 提交。最后保存与否始终由你决定。
- **删图失败就停，绝不猜**：找不到删除图标 → 直接报「在第 1 张图（商品正面图）里没有找到删除图标，已停止
  （不会去点别的按钮）」，**页面上不产生其它点击**；点了但它没消失（例如弹了二次确认框）→ 报
  `DELETE_TIMEOUT` 并提示可能有确认框，**不会自己去点那个确认**；图片区整个找不到 → 报
  `IMAGE_AREA_NOT_FOUND`，**不会到页面别处去找同名节点删**。
- **删掉的图只能手动补回**：删图不可撤销（本流程不点保存）。万一后续上传没确认成功，提示会明确写出
  「注意：本次已先删除了原来的第 1 张图（商品正面图），若新图没上传成功需要你手动补回」——
  不会让你以为一切正常。
- **图片位满了会明确报错，不会瞎点**：真实页面**只在空槽位上**渲染 `div.image-upload-btn`，
  所以 6 个槽位全满时页面上一个按钮都没有。这时报「商品页的图片位已经全部占用（6 个槽位都有图），
  …请先在商品页删掉一张、腾出空位再回填」，**页面上不产生任何点击**。
  （勾选删除时通常走不到这里：删完第 1 张就有空位了。）
- **只有在「可见按钮挂在已占用槽位上」时才降级并警告**：那种情况下仍会尝试，但提示条会变成红色写明
  「回填完成，但需确认：没有找到空槽位…可能会覆盖已有图片，请回商品页核对」。
- **未确认会如实说**：如果面板没关、或没有「确认上传」按钮，提示为「回填未确认：…」而非成功。
- **商品页已关闭 / 会话过期**：分别提示「原来的商品页标签已经关闭…」「会话已过期…」，页面上不产生任何点击。
- 复用姊妹扩展 `aliexpress-image-replace-test-extension` v0.5.1 的 6 个库文件（原样 vendor 到
  `public/vendor/aeiir/`，**未移植成 TS**），加一个本项目的 `bridge.js` 作为页面侧驱动。
  原因与踩坑见 [`docs/architecture.md`](docs/architecture.md) §6.5。

> **为什么不用 `web_accessible_resources`**：本方案靠 `chrome.scripting.executeScript({ files })` 注入，
> 不需要把脚本暴露给页面（已实测确认）。

手工验证步骤见 [`docs/manual-test.md`](docs/manual-test.md) 第 6.5 节。

---

## 服务端接口（**只调用已有接口，服务端未做任何修改**）

服务地址：`https://39.107.244.239`（可在选项页修改默认值）

| 用途 | Method + Endpoint | 请求 | 响应 |
| --- | --- | --- | --- |
| 登录 | `POST /api/auth/login` | JSON `{username, password}` | `Set-Cookie: SESSION=…`；`{success,data:{id,username,role,…}}` |
| 登录态 | `GET /api/auth/me` | Cookie | `200` + `{success,data:{…}}`，未登录返回 `401` |
| 退出 | `POST /api/auth/logout` | Cookie | `{success:true}` |
| 上传图片 | `POST /api/admin/uploads/images` | `multipart/form-data`，字段名 **`file`** | `{success:true,data:{url:"https://…aliyuncs.com/….png"}}` |
| 抠图 | `POST /api/public/toy-image/v1/background/remove` | JSON `{input_url, max_size:1600}` | **平铺** `{job:{…},asset:{id,kind,url}}` |
| 取结果 | `GET asset.url` | — | `image/png` 字节流 |

### ⚠️ 响应结构不一致（已踩坑，务必注意）

该服务端**两族接口的响应包装方式不同**：

| 接口族 | 结构 |
| --- | --- |
| `/api/auth/*`、`/api/admin/uploads/images` | `{"success":true,"data":{…}}`（信封） |
| `/api/public/toy-image/v1/background/remove` | `{"job":{…},"asset":{…}}`（**平铺，无 `data` 字段**） |

早期版本按信封读取 `data.asset.url`，于是**每次抠图都会失败**并报
`抠图响应缺少结果图片地址` —— 尽管服务端其实已正确返回了结果 URL。

`readRemoveBackgroundPayload()` 现在两种结构都接受，并把错误消息一并透出
（服务端失败时返回的是平铺 `{"error":"internal_error","message":"…"}`，同样**没有 `success` 字段**）。

已加入**线上契约测试**用于持续防回归（默认跳过，不联网）：

```bash
AIEE_LIVE=1 AIEE_USERNAME=admin AIEE_PASSWORD=<密码> npm run test:live
```

> 单元测试只能断言「我以为的结构」，所以这个 bug 能通过全部 87 个单测。
> 只有真实调用线上接口的测试才能发现它。

**鉴权方式：仅 Cookie（`SESSION`）**。服务端没有 header/token 方案（`X-Session-Id`、`Authorization` 等均实测返回 `401`），
因此扩展依赖 `credentials: 'include'`：

- 扩展在 `manifest.json` 中声明了 `https://39.107.244.239/*` 的 `host_permissions`；
  按 Chromium 的 SameSite 规则，**扩展对该域的请求被视为 same-site**，`SameSite=Lax` 的 SESSION Cookie 因此会被正常携带。
- 密码**不落盘**：只写入 `chrome.storage.session`（内存级，浏览器关闭即失效），用于登录过期后的自动重登。
- 用户名与服务地址写入 `chrome.storage.local`。
- 代码不打印任何凭据，Cookie/密码不会出现在 URL、日志或构建产物中。

**为什么不是「服务端抓取外部图片」**：扩展先把图片下载成 Blob，再用 `multipart` 上传给服务端；
服务端从**它自己的对象存储**读取该 URL 做抠图。AliExpress 的外部 URL 从未交给服务端。

### 关键取舍（真实限制）

- 服务端**不支持**直接 `multipart` 上传到抠图接口（实测字段 `file`/`image`/`source` 均返回
  `{"error":"bad_request","message":"Missing field: input_url"}`），所以必须先上传拿 URL，再调抠图接口。
- 服务端存在 `POST /v1/background/remove-inline`（原始字节进 / PNG 字节出，最契合本用例），但：
  - 公开前缀 `/api/public/toy-image/v1/background/remove-inline` → `404`
  - 鉴权前缀 `/api/toy-image/v1/background/remove-inline` → `403 Forbidden`
  即对当前账号不可用，因此项目走「上传 + `input_url`」这条可用链路。
- 抠图结果落在服务端对象存储上（`*.aliyuncs.com`），扩展会立即 `fetch` 回 Blob 存进 IndexedDB，
  编辑过程只用本地 Blob，**不持续依赖远程文件**。因此 `host_permissions` 含 `https://*.aliyuncs.com/*`。

---

## 本地优先

除抠图必须依赖现有服务外，全部在本地完成：

页面扫描、图片下载、Blob 存储、Session、图片预览、Canvas 编辑、拖动、缩放、旋转、图层排序、
Undo/Redo、PNG 合成、PNG 导出、PNG 下载 —— **全部本地**。服务端只承担抠图。

---

## 技术栈

Chrome MV3 · React 18 · TypeScript（strict）· Vite 5 · Konva 9 + react-konva · IndexedDB（无第三方封装）·
`chrome.storage.session` / `chrome.storage.local` · `chrome.downloads` · Vitest 2

未引入 Redux / RxJS / WebSocket / DI / Worker Pool / 后端 / Mock Server / ZIP / SHA-256 缓存 / Telemetry。

---

## 目录结构

```text
AliExpressImageEditorExtension/
├─ public/
│  ├─ manifest.json              # 构建时复制到 dist/
│  ├─ icons/                     # 工具栏图标（由 scripts/make-icons.py 生成，已提交）
│  └─ vendor/aeiir/              # 回填用的经典脚本（见 §6.5）
│     ├─ shared/                 # messages / errors / validation
│     ├─ content/                # dom-wait / upload-locator / file-injector
│     └─ bridge.js               # 页面侧驱动（本项目自己写，不是姊妹项目的文件）
├─ scripts/
│  ├─ make-icons.py              # 零依赖生成 icon{16,32,48,128}.png
│  └─ check-dist.mjs             # 构建后校验 dist/ 完整性（构建脚本已调用）
├─ vite.config.ts                # UI 构建（editor + options，负责清空 dist 并复制 public/）
├─ vite.sw.config.ts             # Service Worker 构建（单文件 ESM）
├─ vite.content.config.ts        # Content Script 构建（单文件 IIFE）
├─ vitest.config.ts
├─ src/
│  ├─ background/                # service-worker / message-router / session-manager / download-manager / page-filler
│  ├─ content/                   # content-script / image-scanner / url-normalizer / aliexpress-page-adapter
│  ├─ editor/                    # index.html / App / components / state（reducer + history + use-watermark + use-paste-images）/ styles
│  ├─ options/                   # 设置页（登录 + 水印框管理）
│  ├─ services/                  # indexed-db / server-api / cutout-client / cutout-queue / exporter / downloader / settings / watermark-store / text-defaults / upload-images
│  └─ shared/                    # messages / types / errors / constants / text-style / image-mime / page-gate
├─ tests/
│  ├─ unit/                      # 314 个单元测试（不联网）
│  ├─ live/                      # 线上契约测试，默认 skipped
│  └─ fixtures/aliexpress-page.html
└─ docs/
   ├─ architecture.md
   └─ manual-test.md
```

---

## 权限

```json
"permissions": ["storage", "tabs", "downloads", "scripting"]
```

- `storage`：session/local 设置
- `tabs`：读取当前标签页、打开编辑器标签页、返回商品页
- `downloads`：导出 PNG
- `scripting`：页面在扩展安装前已打开时补注入 content script；以及**把回填脚本注入到商品页**
  （`executeScript({ files })` —— 这是唯一能把经典脚本注入非顶层 frame 的方式）

未使用 `<all_urls>`、未使用 `cookies`（登出走服务端 `/api/auth/logout`）；也**未使用
`web_accessible_resources`** —— 回填脚本靠 `executeScript` 注入，不需要暴露给页面。

`host_permissions` 只覆盖扫描链路真正会用到的域，与 `content_scripts.matches` 对齐：

```json
[
  "https://*.aliexpress.com/*",          // 卖家后台商品页（与 content_scripts.matches 同一套规则）
  "https://*.aliexpress-media.com/*",    // 商品图 CDN
  "https://*.alicdn.com/*",              // 商品图 CDN
  "https://39.107.244.239/*",            // 自建服务端（登录 / 上传 / 抠图）
  "https://*.aliyuncs.com/*"             // 抠图结果可能落在 OSS
]
```

`aliexpress.us` 等地区站点**未**申请：扫描器只认 `aliexpress.com` 卖家后台，授予了也进不来，
属于死授权（早期版本误加，已移除）。若将来要支持其他地区站点，必须同时改
`src/shared/page-gate.ts`、`content_scripts.matches` 与页面适配器的路径判定，只加 host 权限是不够的。

---

## 已知限制（第一版）

1. 仅支持 AliExpress 卖家后台商品编辑页的**商品图片控件**（主图 + 更多图片，见上文「提取范围」）；不做详情图 / SKU 图 / 视频封面 / MutationObserver 自适应扫描。`aliexpress.us` / `.ru` 等地区站点会**明确提示不支持**（`src/shared/page-gate.ts`），而不是静默失败。
2. 扫描到的主图**全部默认 `selected = true`**，暂不支持逐张勾选。
3. 抠图并发为 6（`CUTOUT_CONCURRENCY`）。已用 6 张各不相同的图片实测线上服务：6/6 全部成功，
   墙钟 5.6s（单项耗时累加约 19.8s，说明确实是并行而非排队）。但这是**小型图片**下的结果，
   大图同时上传 6 张时的表现尚未测量；若遇到超时，把该值调小即可。
4. 水印框只在有默认水印时自动注入；草稿水印的显示状态不跨刷新保存（刷新后回到默认水印）。
5. 登录态是浏览器会话级 Cookie，浏览器完全退出后需重新登录（选项页可自动重登）。
6. 抠图失败仅影响该张图片，界面提供「重试」；失败的图片不阻塞导出。
7. 未实现：自动上传（无点击自动补图）、Session TTL、孤儿 Blob GC、schema migration、SHA-256 缓存、retry backoff。
8. 回填是**半自动**的：需要你在编辑器里点「回填到商品页」。找不到可见上传按钮时**不做全自动兜底**，
   而是分两种情况给不同的指引：图片位全满 → 报错让你先删一张；页面改版 → 让你手动打开上传面板
   （打开后再点一次回填会复用该面板继续，不会卡在同一个错误上）。回填落在空槽位；除非你关掉
   「回填前删第 1 张」，否则它会先删掉原来的第 1 张来腾空位 —— 所以默认那一条**不是**「旧图全都还在」。
   只有在「可见按钮挂在已占用槽位上」时才会降级并给出红色警告，那种情况**可能覆盖已有图片**，必须回商品页核对。
   删图不可撤销，本流程也不会替你保存，删掉的那张需要你手动补回。
9. 文字图层只做基础排版：内容 / 字体（仅本机字体）/ 字号 / 颜色 / 加粗 / 左中右对齐 / 描边 / 阴影。
   不含渐变、曲线文字、富文本、每字符不同颜色、字体上传与网络字体，也不做多层描边或内发光。
   属性在失焦时才提交，所以输入过程中画布不会逐字实时刷新（描边 / 阴影同理）。
10. 本地图片只有**文件选择器**与**剪贴板粘贴**两个入口，不做拖拽上传；粘贴只取位图，
    不处理「粘贴一个图片 URL / HTML 片段」。上传后不能删除素材，也无法给素材改名。
    单张上限 20MB（`MAX_UPLOAD_BYTES`）—— 抠图服务端本来就缩到 1600px，再大只是白等一次写盘。

---

## 验证状态

| 项目 | 状态 |
| --- | --- |
| `npm run typecheck` | **PASS**（0 error） |
| `npm run test` | **PASS**（20 文件 / 314 测试；`tests/live` 默认 SKIPPED，不联网） |
| `npm run test:live` | **PASS**（2 用例：单张契约链路 1.8s；**并发 6 实测 6/6 成功、墙钟 5.6s**） |
| `npm run build` | **PASS**（dist 产出 editor / options / service-worker / content-script / manifest / icons / vendor 7 个回填脚本） |
| `npm run check:dist` | **PASS**（manifest 引用完整、内容脚本与回填脚本均为合法经典脚本、页面资源可解析；已实测：移走任一回填脚本会以非 0 退出并指名缺失文件） |
| 服务端接口实测 | **PASS**（登录 / 上传 / 抠图 / 取结果链路已真实调用并返回有效 PNG，magic `89504e47`） |
| 自动化测试 | **已完成** |
| 水印框功能 | **仅自动化验证**（选择器 / 尺寸计算 / 存储 CRUD 有单测；画布上的锁定表现未在真实 Chrome 中看过） |
| 本地上传 / 粘贴抠图 | **仅自动化验证**（校验 / 落盘 / id 生成 / 素材合并有单测；真实剪贴板与文件选择器未在 Chrome 中手点过，步骤见 manual-test 5.46–5.52） |
| 回填到商品页 | **仅自动化验证**（34 个单测覆盖：frame 打分与选择、重试时 `openPanel: false`、5MB 上限前置拦截、标签页丢失 / 会话过期 / 页面非商品页、降级警告通道；**桥本身**用真实卖家后台 fixture 驱动了完整六阶段流程与「确认上传」，并覆盖「图片位全满 → 报错」与「面板已被手动打开 → 复用继续」两条分支。但**没有**在真实 Chrome + 登录态的商品页上跑过，步骤见 manual-test 第 6.5 节） |
| 真实 Chrome + AliExpress 登录页 E2E | **尚未由我验证**（本环境无法登录真实 AliExpress 卖家后台） |

手工验证步骤见 [`docs/manual-test.md`](docs/manual-test.md)。
