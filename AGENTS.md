# 仓库约定

给在这里动手的人 / agent。**这些不是建议，是会被 CI 检查的规则。**

## 1. 每次改内容，必须在同一个提交里升版本号

判定口径：**`src/` 有任何改动**（行为、界面、修复、重构都算）→ 版本号必须变。
只改 `docs/`、`README.md`、注释性配置这类不动运行时的提交，不强制。
CI 的 `版本号必须随内容更新` 一步会比对基准分支，`src/` 动过而版本号没变 → **直接失败**。

一条命令升，不要手改三个文件：

```bash
npm run version:bump patch     # 10.1.0 -> 10.1.1   修 bug
npm run version:bump minor     # 10.1.0 -> 10.2.0   加功能
npm run version:bump major     # 10.1.0 -> 11.0.0   不兼容
npm run version:bump 10.2.3    # 显式指定
```

它同时写三处，并回读校验：

| 位置 | 谁在用 |
| --- | --- |
| `public/manifest.json` | **Chrome 真正读的版本**，`chrome://extensions` 上显示的就是它 |
| `package.json` | npm / 工具链 |
| `package-lock.json`（`version` 与 `packages[""].version`） | `npm ci` |

`npm run check:version` 校验三处一致 + 符合 Chrome 的格式规则（1–4 段、0–65535、无前导零）。
绝对不要只改其中一处：构建照常成功，症状只会是下载到的包名和浏览器里显示的版本对不上。

## 2. 密钥不进仓库

API Key 走 gitignored 的 `.env.local`（构建期注入 `VITE_VISION_API_KEY`），或在选项页填写
（存 `chrome.storage.local`）。任何被跟踪的文件里都不该出现 key —— 提交前
`git grep -F '<key>'` 应当无输出。

## 3. `dist/` 不入库

它是构建产物，由 `npm run build` 生成，`.gitignore` 已排除。要给别人可加载的版本，走 CI 的
artifact 或 Release（见 README「已构建版本」）。

## 4. 提交信息

`type(scope): 中文摘要`，例如：

```
fix(导出): 799×799 的间歇性失败——浮点截断，别把 previewScale 反算回去
feat(排版): 模板驱动的智能排版（图生图拼版）+ 视觉角色绑定
chore: 版本 0.7.3 → 10.0.0（AI 作图独立版本线）
```

正文写**为什么**，尤其是踩过的坑：现象 → 根因 → 修法。这个仓库的文档风格就是
"把踩坑过程留下"，`docs/architecture.md` 里每一节都在解释为什么不是另一种做法。

## 5. 提交前的最小验证

```bash
npm run typecheck
npm test
npm run check:version
```

改了构建配置或 `public/` 的话再加 `npm run build`（它自带 `check:dist`）。
