# WorkBuddy 积分池（notrat-workbuddy-pool）

把你本机**已登录的 WorkBuddy / CodeBuddy 桌面端账号**合成一个自动故障转移的模型服务商，接进 Notrat。

哪个号限流了、积分用完了、令牌失效了，请求自动落到下一个能用的号上。附带模型目录、积分自动化、请求可观测，和一个管理面板。

**装完不用配置**：不需要填 API Key、不需要手抄地址、不需要改设置。面板自己找到账号、自己接进 Notrat。你只需要在聊天框的模型下拉里选它。

---

## 安装

### 前提（唯一的一条）

本机装过 **WorkBuddy 或 CodeBuddy 电脑版**，并且**登录过**。

> 只用了网页版登录的话读不到 —— 不是 bug。账号凭据来自桌面端留在本机的登录快照，网页版的 Cookie 不在那儿。

### 装法

**一句话**：把整个 `notrat-workbuddy-pool` 文件夹放进 `~/.notrat/plugins/`，然后重载插件。

Windows 就是 `C:\Users\<你的用户名>\.notrat\plugins\`；macOS / Linux 是 `~/.notrat/plugins/`。

**A. 下载 zip（推荐）**

1. 下载 `notrat-workbuddy-pool.zip`
2. **解压**。压缩包里放的是插件的**内容**（`manifest.json` 在根），所以解压出来是一个名为 `notrat-workbuddy-pool` 的文件夹。
3. 把这个文件夹整个移到 `~/.notrat/plugins/` 下。**最终必须长这样**：

   ```
   ~/.notrat/plugins/
   └── notrat-workbuddy-pool/
       ├── manifest.json      ← 必须在这一层
       ├── panels/pool.tsx
       └── server/index.js
   ```

4. Notrat → 状态栏「插件箱」抽屉 → **右键「积分池」卡片 → 重载插件**（不用重启 Notrat）

> ⚠️ **文件夹名必须正好是 `notrat-workbuddy-pool`**（= `manifest.json` 里的 `id`）。
> 插件靠它定位自己的服务端文件（`${pluginDir}/server/index.js`）。名字不对，面板照样会出现在抽屉里，
> 但一点开就是「插件 MCP server 未启动」—— 因为服务端路径解析不到。
> Windows「解压到 xxx」和 macOS 双击解压都会用**zip 文件名**当文件夹名，所以别给 zip 改名。

**B. 从仓库拉（改代码用）**

```bash
git clone <本仓库> ~/.notrat/plugins/notrat-workbuddy-pool
```

改完代码在「插件箱」里右键那张卡片 → **重载插件**就生效，不用重启 Notrat。

不需要 `npm install` —— 这个插件零依赖，引擎已经 vendor 进来了。

**为什么不直接在应用里「选一个 zip 安装」？**

应用内的 zip 安装目前只服务官方市场条目（下载 → 校验 sha256 → 解包到 `~/.notrat/plugins/<id>/`）。
第三方插件还没有「选本地 zip」的入口，所以上面第一条路是手动放目录。这也是为什么发布物是一个**目录型 zip**：
解开就是那个文件夹，不用你手工建目录、也不用改文件名。

## 装完之后（正常情况下你什么都不用做）

打开面板（插件抽屉点「积分池」），它会自动跑完前三步：

| 自动完成 | 你会看到 |
|---|---|
| 起引擎（两个本机端口 + 账号池） | 状态点变绿，「已启动」 |
| 扫描本机登录快照 | 「找到 N 个账号，共 M 积分」 |
| 接进 Notrat（写自定义服务商） | 「已自动接好」 |

**唯一需要你手动做的一步**：回到聊天框，点上面的模型名，选带「积分池」的那一项。

之后发消息就走积分池了。它**不会**替你切当前模型 —— 你什么时候想用、用哪个模型，仍然你说了算。

### 如果某一步没自动完成

面板首屏一次只显示**下一步该做什么**和一个按钮，照点就行：

- **「再找一次」** —— 扫了但没账号。这只可能是两种情况：桌面版没装，或者装了没登录。
- **「一键接上」** —— 账号找到了但没接上（一般是应用刚启动、AI 配置还没就绪）。
- **「打开」** —— 引擎没起来。先点它；还是不行就看下面的「常见问题」。

### 不想让它自动接？

设置 → 插件 → 积分池 → 配置里关掉 `autoWire`（或让我在对话里改：`wb_config_set` 传 `{"autoWire": false}`）。关掉之后面板只留手动按钮，绝不动你的 AI 配置。

想撤销已经接上的？面板 →「接入」页 → **移除**。

---

## 它做什么，不做什么

**只读本机**：账号来自桌面端已经留在磁盘上的登录快照。插件**不发起任何登录流程**，不弹二维码，不要你输密码。

**令牌不出本机**：凭据只在内存里用于向 WorkBuddy 上游发请求。工具出口统一脱敏，日志里也不会出现。

**只动自己那一条**：写进 Notrat 的 AI 配置时，只增删 `id = notrat-workbuddy-pool` 这一项，别的服务商原样保留，当前模型也不会被改（除非你本来一个服务商都没有）。

**积分自动化默认关着**：签到那类操作会产生真实的上游流量，所以默认不跑。要用得你自己开（面板「设置」页或 `wb_config_set`）。

---

## 为什么中间要有一个"桥"

这是整个插件里唯一不显然的地方。

引擎的 `shim` 是个本机 HTTP 服务，同时说 **OpenAI Chat / OpenAI Responses / Anthropic Messages** 三种协议。但它只放行**回环 Origin** —— 非回环来源一律 403。而 Notrat 渲染进程在打包版里从 `file://` 加载，请求带 `Origin: null`，会被直接拒掉：

```
$ curl -H 'Origin: null' -H 'Authorization: Bearer ***' http://127.0.0.1:8120/v1/models
403  origin_not_allowed
```

放宽 shim 的 Origin 校验是不可接受的（那是它防本地网页越权调用的那道线）。所以插件带了一个**桥**：跑在 MCP 子进程里（服务端 fetch，没有 Origin），加 CORS 头并回显 Origin，再转发给 shim。

```
Notrat 渲染进程 ──→ 桥 127.0.0.1:8130 ──→ shim 127.0.0.1:8120 ──→ WorkBuddy 上游
   (Origin: null)      (加 CORS)            (只放行回环)          (copilot.tencent.com …)
```

端口固定（国内 8130 / 国际 8131），重载 Notrat 不会变，所以填一次就够。`baseUrl` 已经带 `/v1`（Notrat 会直接拼 `/chat/completions`，少 `/v1` 会 404）。

---

## 面板

| 标签页 | 干什么 |
|---|---|
| **账号** | 每个号的积分、签到状态、是否冷却/停用/需重新登录；清冷却、停用、设积分保留线 |
| **模型** | 模型目录：上下文窗口、输出上限、支持图片、**现在有几个号能接**（0 = 都不可用） |
| **请求** | 最近的请求记录与按模型的排队时长（p50 / p95） |
| **接入** | 一键接上 / 手动三件套（地址、口令、模型名）/ 移除接入 |
| **设置** | 选号策略、额度门槛、冷却时长、积分自动化 |

新手默认只看得到「下一步」，点「更多设置」才露出全部标签页。

面板放在 `right-panel`（右栏，可拖 240–560px）和 `page`（整页）。任一位置都能**右键 → 移动到…** 搬去别的 13 个位置，布局按容器宽度自适应。

---

## 常见问题

**「本机没读到可用的登录」**

按顺序排除：① 装的是**桌面版**吗（网页版不算）② 打开过并**登录**了吗 ③ 登录的是**哪个区**（国内版 / 国际版账号完全独立，面板顶部可以切）。

**模型列表是空的**

引擎刚起、还没拉到上游模型目录。等状态点变绿后点「重新读取」。如果一直空，看「接入」页的技术说明，或跑 `/wb-doctor` 自检。

**端口被占用 / 引擎起不来**

国内要 8120、8130，国际要 8121、8131。被别的进程占了就会启动失败。面板会显示失败原因，详细日志在：状态栏「插件箱」→ 积分池 卡片 →「▸ 实时日志」（即 stderr）。

**聊天报 401 / 405**

先确认选的是「积分池」那个服务商，不是别的。再确认那个号没被停用、没在冷却。都正常就点「清冷却」重试。

**换了账号 / 新登录了一个号**

面板点「再找一次」，或跑 `/wb-rescan`。不会重复添加，也不会丢已有配置。

**只想看状态，不想让它碰我任何东西**

关掉 `autoWire` 和 `autoStart`。面板仍能看状态，引擎按需才起。

---

## 配置项

改法：面板「设置」页，或对话里 `wb_config_set`，或直接编辑 `~/.notrat/plugins/data/notrat-workbuddy-pool/config.json`。

| 键 | 默认 | 说明 |
|---|---|---|
| `autoStart` | `true` | 插件启动时预热引擎 |
| `autoWire` | `true` | 找到账号后自动接成 Notrat 的服务商（只写一次、幂等） |
| `distribution` | `priority` | 选号：`priority` 抽干一个再用下一个 / `round-robin` 轮询 / `balanced` 空闲越久权重越高 |
| `minUsableCredits` | `50` | 余额低于此值跳过该号（`0` 关闭） |
| `cooldownMs` | `60000` | 限流冷却基数 |
| `creditReserves` | `{}` | 单账号积分保留线 |
| `automation.enabled` | `false` | 积分自动化（签到等），会产生真实上游流量 |

---

## 开发

**运行时零依赖**，但**校验脚本**要借 Notrat 源码里的 `esbuild` / `react`（面板是 TSX，得编译才能验）。
脚本会自动往上找 4 层目录里的 `Notrat` / `notrat` / `front_project/Notrat`；放不到一起就用环境变量指过去：

```bash
# PowerShell
$env:NOTRAT_REPO = "C:\path\to\Notrat"
# bash / zsh
export NOTRAT_REPO=/path/to/Notrat
```

截图另需一个 headless 浏览器（Playwright 的 chromium 缓存或系统 Chrome/Edge，都会自动探测；
也可用 `CHROME_PATH` 指定）。装一个最省事：`npx playwright install chromium`。

```bash
# 全部行为测试（编译 / 引导态 / 接线 / 点击 / MCP 握手 / 渲染）
npm test                 # = node scripts/test-all.cjs

# 面板离线校验（Notrat 仓库自带，退出码 0 才算过）
node "$NOTRAT_REPO/scripts/plugin-panel-check.mjs" panels/pool.tsx

# 按宿主真实尺寸预览（红=横向溢出必须改，黄=超出宿主高度会滚动）
node "$NOTRAT_REPO/scripts/plugin-panel-preview.mjs" panels/pool.tsx --manifest manifest.json

# 12 画框 × 4 套主题：出 HTML → 截图 → 逐框体检（溢出/字号/热区/对比度/重复标题）
node scripts/preview.mjs --shot
node scripts/probe-frames.mjs minimalist-light preview-minimalist-light.html

# 真起引擎跑一次开局（会绑端口；本机已有实例时会给出"另一个在跑"的诊断）
node tests/_bootstrap_live.mjs
```

目录：

```
manifest.json          插件包声明（贡献面、配置项、UI 位置）
panels/pool.tsx        管理面板（单文件 React，零构建依赖）
server/index.js        MCP server：工具表 + 引擎单例
server/engine.js       引擎外壳：端口、账号池、状态文档
server/bridge.js       桥：CORS + 转发
server/vendor/         vendor 进来的引擎（见 VENDOR.json，勿手改）
scripts/_paths.mjs     路径解析：Notrat 源码 / headless 浏览器（自动探测 + 环境变量覆盖）
scripts/               校验 / 预览 / 打包脚本
tests/                 行为测试
```

面板设计遵循 Notrat 的「面板设计规范」：壳归宿主（不自己画标题栏）、按容器宽度自适应（240px 不横向滚动）、加载/空/错/禁用四态齐全、浅色与暗色都过一遍。

---

## 发布

```bash
node scripts/make-release.mjs     # 产出 dist/notrat-workbuddy-pool.zip + .sha256
python scripts/verify-release.py  # 用 Python 的 zipfile 独立复核（第二套实现；Windows 上也可写 py）
```

**打包器不只是压一下，它在写完之后自检，任何一条不过就 exit 1**（不会产出"看起来成功"的包）：

| 检查 | 为什么 |
|---|---|
| `manifest.json` 在压缩包根，条目数 1–200，路径 ≤200 字符，无绝对路径 / `..` / `~` | 宿主 `installOfficialPluginZip` 的硬限制 |
| manifest 里的 `sourceFile`、`mcpServers` 的 `${pluginDir}/...` 指向的文件都在包内 | 少一个文件 → 面板能开但 MCP 起不来 |
| 禁入状态文件 / 凭据 / 预览产物 / 测试 / 开发脚本 | 这些东西进包等于把你自己的账号和布局一起发出去 |
| 逐文件扫令牌样式、本机绝对路径、`U+FFFD` | 手滑把真 key 或本机路径写进文档是这类仓库最常见的事故 |
| 回读解包，与源文件逐字节比对 + CRC | 证明写出的 zip 没坏（自读自写发现不了长度写岔） |

两个实现刻意不共享代码：写入用 `make-release.mjs` 的自写 ZIP writer，复核用 Python 标准库 `zipfile` —— 一边有 bug，另一边会直接抛异常。

**文件名有约束**：必须是 `notrat-workbuddy-pool.zip`，不能加版本号。Windows / macOS 解压时用 zip 文件名建目录，而目录名必须等于 `manifest.id`（插件靠它解析 `${pluginDir}`）。加了版本号 → 解压出 `notrat-workbuddy-pool-0.2.0/` → 装不上。

构建是**可复现**的：固定时间戳、条目排序、deflate level 9 —— 同样的源文件永远得到同样的 sha256，方便你核对别人手里的包是不是原版。

## 署名与许可

本插件 **MIT**。

引擎移植自 [`2861292267/DSH-Official-WorkBuddy-Credit-Proxy`](https://github.com/2861292267/DSH-Official-WorkBuddy-Credit-Proxy)（包名 `dsh-rotakit`，MIT），那是 [`XDTrees/dsh-workbuddy-xdpool`](https://github.com/XDTrees/dsh-workbuddy-xdpool)（MIT，作者 **XDTrees**）的改编版；账号凭据解密来自 [`dingminhua/dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）；shim 加固与错误映射参考 [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）。

本插件只做一件事：把那套引擎从 DSH 宿主壳里取出来，换成 Notrat 的接线。

**免责**：仅供个人学习研究，只驱动**你自己**本机已登录的账号，不发起任何登录流程。请遵守 WorkBuddy 的服务条款；使用后果由使用者自负。
