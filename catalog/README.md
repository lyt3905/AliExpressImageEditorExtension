# 品牌目录（Brand catalog）

这个目录是**扩展在线读取的公开数据**，改完推上去就生效，不需要重新打包插件。

```
catalog/
  brands.json          ← 目录清单：谁是谁、Logo 在哪个文件、校验和
  logos/<slug>.png     ← Logo 原图（也支持 .jpg / .jpeg / .webp）
```

扩展侧的两个地址（按顺序尝试，前一个失败自动换下一个）：

- `https://raw.githubusercontent.com/lyt3905/AliExpressImageEditorExtension/feat/ai-image-generation/catalog/`
- `https://cdn.jsdelivr.net/gh/lyt3905/AliExpressImageEditorExtension@feat/ai-image-generation/catalog/`

> **分支名写死在 `src/shared/constants.ts` 的 `BRAND_CATALOG_REF` 里。**
> 现在指向功能分支 `feat/ai-image-generation`（功能还没发版）；合并到 `main` 之后**必须改回 `main`**，
> 否则删分支的那一刻，所有已装插件的同步就全挂了。jsDelivr 不认带 `/` 的分支名，那个镜像会 404 直接换下一个——
> 宁可没有镜像，也不能让镜像返回旧数据。

## 加一个品牌

1. 把 Logo 放成 `logos/<id>.png`。文件名就是 `id`，只能用小写字母、数字、`-`、`_`、`.`。
2. 在 `brands.json` 的 `brands` 里加一条：

```json
{
  "id": "morph-toys",
  "name": "Morph Toys Store",
  "aliases": ["Morph Toys", "MTS"],
  "keywords": ["morph toys"],
  "logo": { "file": "logos/morph-toys.png" }
}
```

3. 跑 `npm run catalog:bump`（版本 +1，顺手算好 `sha256`、规范化 JSON），然后提交。
4. 如果你只是想改某个 Logo 的图：换掉文件、跑 `npm run catalog:write`，`rev` 会自动跟着 `sha256` 变，装了插件的机器下次同步就会重下这一张。

## 现在的品牌清单

| `id` | 显示名 | 匹配词 |
| --- | --- | --- |
| `animaster` | 大漫匠 | 大漫匠、AniMester |
| `ms-toys` | 魔方 | 魔方、MS-TOYS、MS TOYS、Magic Square |
| `x-transbots` | X社 | X社、X-TRANSBOTS、XTRANSBOTS |
| `dr-wu` | 吴医生 | 吴医生、Dr.Wu、DrWu、Dr Wu |
| `lucky-cat-toys` | 招财猫玩具 | 招财猫玩具、激光猫、Lucky Cat Toys |
| `fans-toys` | FansToys | FansToys、Fans Toys |
| `bandai` | 万代 | 万代、BANDAI |
| `threezero` | 三零 | 三零、threezero、three zero |
| `galaxy-toys` | 银河玩具社 | 银河玩具社、银河社、Galaxy Toys |
| `shfiguarts` | SHF | SHF、S.H.Figuarts、SHFiguarts |
| `hasbro` | 孩之宝 | 孩之宝、Hasbro |
| `dlx` | DLX | DLX、DLX Collectible Figure |
| `official-mosaic` | 官方马赛克 | （只做灯片，不参与标题匹配） |

**匹配是"标题里出现该词"的子串判断（不分大小写）**，所以别往里放太短的词：
`MS` 单独一条会把 `items`、`customs` 这类标题全命中，所以魔方只留了 `MS-TOYS` / `MS TOYS`。
两个字的词已经够用（`万代`、`三零`），一个字母或两个字母的缩写尽量带上连字符或点。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | ✅ | 目录版本，整数，**每次改内容都要 +1**。扩展用它判断「上游有没有变」，没变就一次网络请求都不发。 |
| `updatedAt` |  | 日期字符串，脚本自动写。 |
| `brands[].id` | ✅ | 稳定 slug，`^[a-z0-9][a-z0-9-]{0,63}$`。**不要改**：扩展里的品牌 id 是 `remote-<id>`，改了等于换了个新品牌，历史画布上的 Logo 图层会断图。 |
| `brands[].name` | ✅ | 品牌显示名，≤120 字符。和手工上传的品牌**同名（不分大小写）时目录这条会被跳过**，本地优先。 |
| `brands[].aliases` / `keywords` |  | 标题匹配用的别名/关键词，各 ≤40 项、每项 ≤60 字符。`name` 本身也参与匹配。 |
| `brands[].logo.file` | ✅ | `logos/<name>.(png\|jpg\|jpeg\|webp)`，≤4MB。 |
| `brands[].logo.sha256` |  | 64 位小写十六进制。脚本自动填；填了就强校验，对不上这张图不落地。 |
| `brands[].rev` |  | 单品牌修订号，缺省回落到 `sha256`（再缺省回落到 `v<version>`）。只有它变了才重下这张图。 |

## 命令

```bash
npm run check:catalog   # 校验（CI 也会跑）：字段、路径、文件存在、sha256、数量上限
npm run catalog:write   # 重算 sha256 + 规范化 JSON（不改 version）
npm run catalog:bump    # version + 1，然后同上
```

## 边界（写进扩展里的硬限制）

- 只接受 `https`（本机回环 `127.0.0.1` / `localhost` 例外），Logo 路径解析后必须还在目录前缀下。
- `brands.json` ≤512KB、品牌 ≤100 个、单图 ≤4MB、图片类型只认 PNG/JPEG/WebP。
- 目录里删掉一个品牌 → 扩展只删注册表条目，**不删已下载的图片**：历史画布可能还在引用它。
- 扩展侧永远离线优先：拉不到目录就用本地缓存，不阻塞打开编辑器。
