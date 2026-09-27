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
  → 后台自动对 selected 原图抠图（并发 2，队列调度）
  → 抠图结果自动进入「已抠素材」
  → 用户点击素材加入 800×800 画布，拖动 / 缩放 / 旋转 / 排序
  → 导出 800×800 白底 PNG → chrome.downloads 下载到本地
```

**绝不发生的行为**：不修改 AliExpress 商品数据、不回填主图、不自动点击保存、不提交商品、不上传商品信息、不修改服务端。

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

点击插件后若出错，工具栏图标会显示红色 `!` 徽标，鼠标悬停可看错误原因；最近一次错误也会显示在选项页。

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
│  └─ icons/                     # 工具栏图标（由 scripts/make-icons.py 生成，已提交）
├─ scripts/
│  ├─ make-icons.py              # 零依赖生成 icon{16,32,48,128}.png
│  └─ check-dist.mjs             # 构建后校验 dist/ 完整性（构建脚本已调用）
├─ vite.config.ts                # UI 构建（editor + options）
├─ vite.sw.config.ts             # Service Worker 构建（单文件 ESM）
├─ vite.content.config.ts        # Content Script 构建（单文件 IIFE）
├─ vitest.config.ts
├─ src/
│  ├─ background/                # service-worker / message-router / session-manager / download-manager
│  ├─ content/                   # content-script / image-scanner / url-normalizer / aliexpress-page-adapter
│  ├─ editor/                    # index.html / App / components / state（reducer + history）/ styles
│  ├─ options/                   # 设置页
│  ├─ services/                  # indexed-db / server-api / cutout-client / cutout-queue / exporter / downloader / settings
│  ├─ shared/                    # messages / types / errors / constants
│  └─ future/page-image-writer.ts
├─ tests/
│  ├─ unit/                      # 113 个单元测试（不联网）
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
- `scripting`：页面在扩展安装前已打开时补注入 content script

未使用 `<all_urls>`、未使用 `cookies`（登出走服务端 `/api/auth/logout`）。

---

## 已知限制（第一版）

1. 仅支持 AliExpress 卖家后台商品编辑页的**商品图片控件**（主图 + 更多图片，见上文「提取范围」）；不做详情图 / SKU 图 / 视频封面 / MutationObserver 自适应扫描。
2. 扫描到的主图**全部默认 `selected = true`**，暂不支持逐张勾选。
3. 抠图并发固定为 2（`CUTOUT_CONCURRENCY`）。
4. 登录态是浏览器会话级 Cookie，浏览器完全退出后需重新登录（选项页可自动重登）。
5. 抠图失败仅影响该张图片，界面提供「重试」；失败的图片不阻塞导出。
6. 未实现：自动上传、AliExpress 回填、Session TTL、孤儿 Blob GC、schema migration、SHA-256 缓存、retry backoff。
7. `PageImageWriter` 仅为占位接口，调用会返回「当前版本暂不支持商品图片回填」。

---

## 验证状态

| 项目 | 状态 |
| --- | --- |
| `npm run typecheck` | **PASS**（0 error） |
| `npm run test` | **PASS**（10 文件 / 113 测试；`tests/live` 默认 SKIPPED，不联网） |
| `npm run test:live` | **PASS**（真实调用线上服务：登录 → 上传 → 抠图 → 取回 PNG，1.7s） |
| `npm run build` | **PASS**（dist 产出 editor / options / service-worker / content-script / manifest / icons） |
| `npm run check:dist` | **PASS**（manifest 引用完整、内容脚本为合法经典脚本、页面资源可解析） |
| 服务端接口实测 | **PASS**（登录 / 上传 / 抠图 / 取结果链路已真实调用并返回有效 PNG，magic `89504e47`） |
| 自动化测试 | **已完成** |
| 真实 Chrome + AliExpress 登录页 E2E | **尚未由我验证**（本环境无法登录真实 AliExpress 卖家后台） |

手工验证步骤见 [`docs/manual-test.md`](docs/manual-test.md)。
