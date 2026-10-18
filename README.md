# ds-bridge

把 DeepSeek 网页端会话包装成 **OpenAI 兼容接口**，给 SillyTavern（酒馆）的数据库插件填表用。

不用逆向 DeepSeek 的 PoW wasm，不用手抄 token：**浏览器就是传输层**。
登录态、Cookie、TLS 指纹、PoW 全在真实页面里完成，桥只负责搬运。

```
git clone https://github.com/misa1ink/ds-bridge.git
cd ds-bridge
start.bat          # Windows 双击也行
```

需要 Node.js 22+。不用装任何 npm 依赖。

---

## 为什么这么搭

酒馆数据库插件慢，通常不是模型慢，是**请求次数多**：N 个字段 = N 次串行调用。

所以这里有两层加速：

| 层 | 做法 | 效果 |
|---|---|---|
| 传输层 | 直接复用网页端会话，不跑官方 API 计费通道 | 免费、无 token 成本 |
| 调用层 | `/v1/table/fill` 一次请求填整行 | 请求数从 N 降到 1 |

单字段场景仍走标准 `/v1/chat/completions`，插件无感。

---

## 快速开始

**双击 `start.bat`** 就行。

它会自己检查 Node 版本、首次运行时生成配置和 API key、确认文件齐全、启动服务、5 秒后自动打开控制台。

```
start.bat                 直接启动
start.bat --install       只初始化，不启动
start.bat --no-browser    启动但不自动开浏览器
start.bat --status        只看是否在运行
```

重复双击不会起第二个实例——它会先探测 `/health`，发现已在跑就直接打开控制台。

关窗口即停服务；浏览器窗口别关，登录状态靠它保留（浏览器是 detached 的，重启服务不用重新登录）。

然后打开 **<http://127.0.0.1:8788/>** —— 所有操作都在这个网页里：

| 页 | 干什么 |
|---|---|
| **登录** | 点「打开 DeepSeek 登录窗口」，在弹出的真实浏览器窗口里扫码/输密码登录，登录态自动保存 |
| **预设** | 拖入酒馆预设或破限文本，立即生效并落盘 |
| **测试** | 连通性自测、批量填表试跑 |
| **状态** | 服务状态、API Key、酒馆配置一栏照抄 |

顶栏右上角是**入口切换**：`国内站` / `国际站`。带绿点表示该入口的浏览器已经起来了。

### 登录

登录页只有两个按钮：

- **打开 DeepSeek 登录窗口**（推荐）：在桥自带的浏览器窗口里打开登录页并弹到前台，你在真实窗口里完成登录。那个窗口平时最小化待在任务栏，不点按钮不会弹出来
- **检查登录状态**：手动刷新登录状态；「登录身份」一行会显示当前账号（手机号/邮箱，DeepSeek 返回的打码格式）

登录成功后浏览器窗口可以最小化或不管它，**不要关掉整个浏览器进程**——关了也没事，下一个请求会自动重启浏览器并复用磁盘上的登录态，但重启期间会断几秒。

### 无头常驻（挂机 / 手机用）

**双击 `start-server.bat`**：浏览器无头运行（不弹任何窗口），服务绑到 `0.0.0.0` 允许局域网访问。

- 前提：`config.json` 里已有 API key（没有会拒绝启动，防止账号裸奔在局域网）
- 登录态复用 profile 目录，先在桌面模式（`start.bat`）登录过一次即可
- 手机上访问 `http://<电脑局域网IP>:8788/`，粘入 API key 即可；客户端 Base URL 填 `http://<IP>:8788/v1`
- 第一次可能要放行 Windows 防火墙：`New-NetFirewallRule -DisplayName "ds-bridge" -Direction Inbound -LocalPort 8788 -Protocol TCP -Action Allow`
- 同一份代码也能跑在云服务器/NAS 上（Node 22+ 即可），登录态迁移：把用户目录下的 `.ds-bridge-profile-cn`（和 intl）整个拷过去，不用重新登录

### 手动启动

不想用 .bat 的话：

```powershell
cd E:\工作区\ds-bridge
node scripts\init-config.mjs   # 仅首次
node server.mjs
```

环境变量：`DS_HEADLESS=1` 无头浏览器；`DS_BRIDGE_HOST=0.0.0.0` 开放局域网（其余见「配置」一节）。

---

## 国内站 / 国际站

顶栏点一下就切换，选择会存进 `config.json` 的 `site` 字段，重启后保持。

| | 国内站 `cn` | 国际站 `intl` |
|---|---|---|
| 地址 | `chat.deepseek.com` | `chat.deepseek.com` |
| API 语言头 | `zh_CN` | `en_US` |
| 界面语言 | 简体中文 | English |
| 登录方式 | 手机号 / 微信扫码 | 手机号 / 邮箱 / Apple / Google |
| 独立 profile | `.ds-bridge-profile-cn` | `.ds-bridge-profile-intl` |
| 调试端口 | 9222 | 9223 |

### 为什么要两个浏览器

DeepSeek 两个区域用的是**同一个域名**，靠账号所属集群和 locale 区分（我核对过：页面打包文件里只有一个 `chat.deepseek.com` 聊天域名，`chat.deepseek.cn` 根本不存在）。

同域名意味着**同一个 profile 只能保持一份登录**。所以两个入口各开一个浏览器、各用一个 profile、各占一个调试端口：

- 两边可以同时登录不同账号，互不覆盖
- 切换回另一个入口时**不用重新登录**
- 实测：国际站显示未登录时，国内站依然保持已登录

端口归属靠读取进程命令行里的 `--user-data-dir` 判断，不是"端口被占就用"。否则第二个入口会误用第一个的浏览器，一个登录把另一个顶掉。

### 换域名怎么办

如果以后国际站有了独立域名，改 `config.json` 即可，不用动代码：

```json
{
  "site": "intl",
  "siteOverrides": {
    "intl": { "origin": "https://chat.example.com" }
  }
}
```

`apiBase` 会跟着 `origin` 自动推导。

---

## 登录是怎么做到的

登录发生在**桥自带的浏览器窗口**里（不是系统默认浏览器——它没有登录 profile）。控制台的「打开 DeepSeek 登录窗口」按钮通过 CDP 在那个浏览器里开一个登录页标签并弹到前台，你在真实窗口里扫码或输密码，凭据进的是真表单，登录状态和直接用浏览器完全一样。

- 浏览器平时**最小化待在任务栏**，只有点按钮才会弹到前台——自动恢复/重启时也不会抢焦点
- 登录态存在独立 profile 目录（`.ds-bridge-profile-cn` / `.ds-bridge-profile-intl`），落盘、长期有效
- 「登录身份」显示的是 DeepSeek `users/current` 接口返回的账号信息（手机号/邮箱为官方打码格式）
- 画面镜像（screencast 画布登录）已移除：不再有闪动的嵌入画面，资源占用更低

**首次使用**：点「打开 DeepSeek 登录窗口」→ 扫码或输手机号 → 回控制台看状态变绿。之后一般不用再管。

---

## API Key

`init-config.mjs` 会生成一个，写在 `config.json` 的 `apiKeys` 里：

```json
{
  "apiKeys": [
    { "key": "sk-dsb-63749b45a975...", "label": "sillytavern" }
  ]
}
```

- 配置了 key → 所有请求必须带 `Authorization: Bearer <key>`，否则 401。
- `apiKeys` 为空 → 桥开放（只适合本机临时试用）。
- `POST /v1/keys {"label":"phone"}` 追加新 key 并落盘，无需重启。
- `GET /v1/keys` 只回标签和尾号，不泄露明文。
- 换新 key：`node scripts/init-config.mjs --rotate`。

酒馆里把 key 粘到 Custom OpenAI 的 API Key 栏即可。

---

## 预设导入（三种用法）

### 用法一：在网页里导入（推荐）

打开 <http://127.0.0.1:8788/> → **预设** 页 → 把文件拖进去，或粘贴内容 → 自动启用。

导入后立刻落盘到 `presets/imported/<名字>.json`，重启后依然生效。

**能认的格式**：

| 来源 | 处理方式 |
|---|---|
| 酒馆 Chat Completion 预设 `.json` | 抽出 `main` / `nsfw` / `jailbreak` 三段，参数一并保留 |
| 酒馆 text-completion 预设 | 按 `[Main Prompt]` 等标记切分 |
| 纯文本破限 `.txt` | 整段作为主提示词 |
| `{main, nsfw, jailbreak}` 自定 JSON | 直接采用 |
| 正则脚本数组 | 存下来备用 |

认不出的格式会明确报错，不会静默吞掉。

**「当前生效」那一栏是关键**：它显示的实际内容就是每次 `/v1/table/fill` 会前置注入的文本。点「预览实际注入内容」可以直接看全文，不用花模型调用去试。

### 用法二：导出回酒馆

预设条目上的「导出」按钮会生成标准酒馆预设 JSON，可以拿到另一台机器上导入。
所以这个网页既是导入端，也是中转站。

### 用法三：导入到酒馆本体

`presets/DS-Bridge-NSFW.json` 是内置的可导入预设：

```
酒馆 → 插头图标（Chat Completion）→ 预设下拉 → 导入 → 选 DS-Bridge-NSFW.json
```

| 项 | 内容 |
|---|---|
| 端点 | 写死 `http://127.0.0.1:8788/v1` + 模型 `deepseek-web` |
| 破限 | Main Prompt 换成"fiction engine"框架；NSFW Prompt 换成场景延续指令；Post-History 禁止跳过 |
| 参数 | 上下文 64k、输出 1200、流式开、`bypass_status_check` 开 |

改内容不用手改 JSON：编辑 `presets/core-nsfw.txt` 和 `presets/scene-nsfw.txt`，重跑 `node scripts/build-preset.mjs`。

### 填表路径也做了处理

数据库插件不走预设，所以破限文本单独注入到 `/v1/table/fill`。生效来源按这个顺序：

1. 网页里启用过的导入预设
2. `config.json` 的 `fillSystemPrompt`
3. 内置的 `presets/*.txt`

网页「状态」页和 `/health` 都会显示当前用的是哪一个。

想跳过某次请求的这层：传 `{"safe": true}`。

---

## 接进酒馆

**推荐**：在网页里导入预设，然后按「状态」页那张卡片照抄。

手动配置的话：

```
Base URL : http://127.0.0.1:8788/v1
API Key  : config.json 里的那个 sk-dsb-...
Model    : deepseek-web          # 带思考：deepseek-web-think
```

插件里把"填表模型"指到这个端点即可。**如果插件是逐字段调用，换成批量端点收益最大**（见下）。

---

## 接口

### 认证

除 `/health`、首页和 `/v1/console/bootstrap` 外，所有接口都要 `Authorization: Bearer <key>`。

`/v1/console/bootstrap` 只对 `127.0.0.1` 开放，把 key 交给本机网页。手机/远程访问时拿不到它，在控制台「状态」页手动粘一次 key 即可（浏览器会记住）。

### 账号

| 端点 | 用途 |
|---|---|
| `POST /v1/view/open` | 在桥的浏览器窗口里打开 URL（默认登录页）并弹到前台 |
| `POST /v1/account/logout` | 退出登录：`{"site":"cn","switch":true}` = 清 cookies/localStorage 并重置 worker 会话 |

### 入口切换

| 端点 | 用途 |
|---|---|
| `GET /v1/sites` | 两个入口的列表、当前启用、各自的 worker 数 |
| `POST /v1/sites/switch` | `{"site":"cn"}` 或 `{"site":"intl"}`，落盘并预热浏览器 |
| `GET /v1/login/check?site=` | 探测任意入口的登录态（附带 `account`：手机号/邮箱/ID），不会切换当前入口 |

### 预设管理

| 端点 | 用途 |
|---|---|
| `GET /v1/presets` | 列表 + 当前生效 |
| `POST /v1/presets/import` | 导入（`{content, filename, name, activate}`） |
| `POST /v1/presets/activate` | 启用指定预设，传空名字回退内置 |
| `GET /v1/presets/get?name=` | 取详情和合成后的文本 |
| `GET /v1/presets/preview` | **实际会注入的内容** |
| `GET /v1/presets/export?name=` | 导出成酒馆预设 |
| `POST /v1/presets/delete` | 删除（若正生效则自动回退） |

### `POST /v1/chat/completions`

标准 OpenAI 格式，`stream: true/false` 都支持。

```json
{ "model": "deepseek-web", "stream": true,
  "messages": [{ "role": "user", "content": "你好" }] }
```

`messages` 会被压平成单条 DeepSeek prompt。**system 内容按原文发送，不加 `[系统指令]` 标签** —— 打了标签模型就会退回助手腔。
想保留多轮，用同一个 bridge 实例连续请求；想每次干净，加 `"newSession": true`。

### `POST /v1/table/fill`  ← 填表专用

一次请求，整行数据回来。自动注入 `fillSystemPrompt`。

```json
{
  "context": "角色：沈砚，28岁，恋人关系。场景：深夜卧室，衣衫半解。",
  "columns": [
    { "key": "name",     "desc": "角色名" },
    { "key": "state",    "desc": "身体状态，一句，要具体" },
    { "key": "clothing", "desc": "此刻衣物状态，写清哪些还在、哪些已褪下" },
    { "key": "want",     "desc": "此刻的欲望，直白，不用委婉语" }
  ],
  "rows": [ { "name": "沈砚" } ]
}
```

实测返回：

```json
{
  "name": "沈砚",
  "state": "后背抵着床头，半撑起身，胸口起伏还没平下来，嘴唇被咬得有点肿",
  "clothing": "衬衫敞开挂在肩上没脱，皮带松了扣，西裤还穿着但拉链已经拉开",
  "want": "想把她按回枕头上，把刚才吵架的话全用身体说一遍"
}
```

返回：

```json
{ "ok": true,
  "rows": [{ "name": "林雾", "mood": "戒备", "outfit": "深灰羊毛衫，袖口挽到小臂", "intent": "想尽快结束这场寒暄" }],
  "raw": "…" }
```

解析失败会回 `{ ok: false, reason: "unparsable", raw }`，方便插件降级到逐字段。

### 其他

| 端点 | 用途 |
|---|---|
| `GET /health` | 服务 + 浏览器状态 |
| `GET /v1/login/check` | 登录态检查 |
| `GET /v1/models` | 模型别名列表 |
| `POST /v1/session/reset` | 换新会话（清上下文） |

---

## 配置

主要配置在 `config.json`（`scripts/init-config.mjs` 生成，手改也行，每次请求重新读取）：

| 字段 | 说明 |
|---|---|
| `site` | 当前入口：`cn` 或 `intl` |
| `siteOverrides` | 按入口覆盖 `origin`/`apiBase`/`locale` |
| `apiKeys` | `[{key, label}]` 或纯字符串数组；空数组 = 不校验 |
| `fillSystemPrompt` | 填表时前置注入的破限提示词 |
| `chatSystemSuffix` | 附加在客户端 system 之后（默认空，预设已覆盖） |
| `concurrency` | 并发标签页数（每个入口各自一份） |
| `modelAlias` | 对外模型名 |

环境变量覆盖文件（临时调试用）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DS_BRIDGE_PORT` | `8788` | 桥监听端口 |
| `DS_BRIDGE_HOST` | `127.0.0.1` | 如需局域网访问改 `0.0.0.0` |
| `DS_HEADLESS` | 空 | 设为 `1` 浏览器无头运行（不弹窗口，挂机/服务器用） |
| `DS_BRIDGE_KEY` | 空 | 追加一个合法 key（不会覆盖文件里的） |
| `DS_CDP_PORT` | 自动探测 | 指定已运行的调试浏览器端口 |
| `DS_CONCURRENCY` | `2` | 并发标签页数（同一账号，别开太大） |
| `DS_MODEL_ALIAS` | `deepseek-web` | 对外模型名 |
| `DS_BROWSER` | 自动找 Edge/Chrome | 浏览器路径 |
| `DS_APP_VERSION` | `20241129.1` | 客户端版本头，DeepSeek 升级后可调 |

---

## 结构

```
ds-bridge/
├─ start.bat              # 双击启动器（桌面模式，浏览器有窗口）
├─ start-server.bat       # 无头常驻启动器（挂机/手机/服务器，浏览器无窗口）
├─ server.mjs             # HTTP 服务 + 路由 + 按入口分池 + 死浏览器自动重启
├─ config.json            # API key、入口、启用中的预设（生成物）
├─ lib/
│  ├─ cdp.mjs             # 极简 CDP 客户端 + profile/端口归属判定 + 无头启动
│  ├─ view.mjs            # （遗留）画面镜像，已不再被服务端引用
│  ├─ sites.mjs           # 入口定义（origin/locale/profile/port）
│  ├─ deepseek.mjs        # 会话创建 / PoW 头 / 流式完成 / 账号信息 / 标签页自愈
│  ├─ stream.mjs          # DeepSeek SSE 解析（三种帧格式，页面与 Node 共用）
│  ├─ presets.mjs         # 预设导入/存储/导出/合成
│  ├─ config.mjs          # 配置加载 + 原子写入 + key 校验
│  └─ pow.mjs             # sha3 wasm 求解
├─ presets/
│  ├─ core-nsfw.txt       # 内置破限主提示词
│  ├─ scene-nsfw.txt      # 内置场景延续指令
│  ├─ DS-Bridge-NSFW.json # 可导入酒馆的成品预设（构建生成）
│  └─ imported/           # 网页里导入的预设（运行时生成）
├─ scripts/
│  ├─ init-config.mjs     # 生成 config.json + API key
│  ├─ build-preset.mjs    # 从 txt 构建预设 JSON
│  └─ probe-status.mjs    # 启动器用来探测服务是否在跑
├─ wasm/
│  └─ sha3_wasm_bg.wasm
├─ public/index.html      # 网页控制台（登录/预设/测试/状态 + 入口切换）
└─ test/
   ├─ stream.test.mjs     # 解析器单测（离线）
   ├─ auth.test.mjs       # key 校验 + 预设结构（离线）
   ├─ presets.test.mjs    # 预设解析/存储/导出（离线）
   ├─ sites.e2e.mjs       # 入口定义 + 切换（含离线断言）
   ├─ smoke.mjs           # 接口冒烟
   ├─ e2e.mjs             # 真机端到端
   ├─ console.e2e.mjs     # 真机：控制台生命周期
   └─ nsfw.e2e.mjs        # 真机：认证 + NSFW 产出
```

零 npm 依赖，`node server.mjs` 直接跑。

---

## 排障

**双击 start.bat 闪退或满屏"不是内部或外部命令"** → `start.bat` 必须是 **UTF-8 无 BOM + CRLF**。用记事本另存或 Git 自动转换可能把它改成 LF 或加 BOM，cmd 就会逐行解析失败。修复：

```powershell
$p = "start.bat"
$t = [System.IO.File]::ReadAllText($p) -replace "`r`n","`n" -replace "`n","`r`n"
[System.IO.File]::WriteAllBytes($p, [System.Text.Encoding]::UTF8.GetBytes($t))
```

**`cdp not connect` / 浏览器连接丢失** → 桥的浏览器窗口被关了。服务会自动检测死连接并重启浏览器（登录态在磁盘 profile 里，不丢），重启期间请求会断几秒。如果反复出现，看看是不是杀软在杀 Edge。

**「打开 DeepSeek 登录窗口」没反应** → 窗口可能被最小化且置前被系统拦了。看任务栏有没有新的 Edge/Chrome 窗口；服务日志里出现 `opened in real window` 就说明标签页已打开。

**切换入口后显示未登录** → 正常。每个入口是独立 profile，第一次用国际站需要登录一次，之后一直保持。国内站的登录不会因此丢。

**`port 9222/9223 is held by a different browser profile`** → 那个端口被另一个 profile 的浏览器占着（多半是手动开过）。关掉它，或改 `lib/sites.mjs` 里该入口的 `cdpPort`。这个检查是有意的：不做的话第二个入口会静默复用第一个的浏览器，一个登录顶掉另一个。

**`config.json is not valid JSON`** → 手改时留下 BOM 或语法错。BOM 现在会自动忽略；语法错会明确报出位置。

**`not logged in`** → 点「打开 DeepSeek 登录窗口」登录一次。登录态存在独立 profile 里，之后长期有效；浏览器重启也不丢。

**「登录身份」显示"未取得身份"** → 已登录但 `users/current` 拉取失败（可能是 DeepSeek 改了接口）。不影响填表，只是看不到账号显示。

**`401 invalid key`** → 请求没带或带错了 `Authorization: Bearer ...`。查 `config.json` 的 `apiKeys`，或 `GET /v1/keys` 看有哪些标签。本机控制台会自动从 `/v1/console/bootstrap` 取 key；手机访问时在状态页手动粘一次。

**`deepseek 401`** → 网页端登录过期，重新登录；或调 `DS_CLIENT_VERSION`。

**回复被截断 / 只出一两个字** → DeepSeek 的 SSE 有三种帧格式：快照、路径补丁、**裸 token 推送** `{"v":"字"}`。裸 token 帧最容易被漏，漏掉就丢尾巴。`lib/stream.mjs` 三种都处理了，`node test/stream.test.mjs` 可验证。

**`Session with given id not found`** → 那个浏览器标签页被关了。worker 现在会自动重建标签页并重试一次；连续出现就重启服务。

**流一直不动** → `POST /v1/session/reset` 后重试。

**回复变成助手腔 / 开始说教** → 预设没导入，或 Main Prompt 被覆盖了。酒馆里确认选中的是 `DS-Bridge-NSFW`；网页里检查「预设」页「当前生效」是否为你的预设。

**填表字段被改成委婉语或 `...`** → 看「预设」页「当前生效」。若显示「内置」而你导入过预设，点该预设的「启用」。`/health` 里 `preset` 字段会说明当前用的是哪个。

**导入报"认不出这个 JSON"** → 文件可能是世界书或角色卡，不是预设。预设需要含 `prompts[]`，或至少 `main`/`prompt` 字段。

**429** → 降低 `DS_CONCURRENCY`，或加大插件侧请求间隔。

**找不到浏览器** → `set DS_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe`。

---

## 手机 / 远程使用

不开电脑、手机直接用，两条路：

**局域网（同一 WiFi）**——电脑挂着就行：

1. 桌面模式（`start.bat`）登录过 DeepSeek 一次
2. 双击 `start-server.bat`（无头 + 开放局域网），电脑可锁屏
3. 手机浏览器开 `http://<电脑IP>:8788/`（IP 用 `ipconfig` 查），粘一次 API key
4. 手机上的酒馆/客户端：Base URL `http://<电脑IP>:8788/v1`
5. 防火墙放行：`New-NetFirewallRule -DisplayName "ds-bridge" -Direction Inbound -LocalPort 8788 -Protocol TCP -Action Allow`

**手机当服务器（Termux，电脑彻底不开）**——完整图文教程见 **[docs/手机使用教程.md](docs/手机使用教程.md)**。速览：

1. F-Droid 装 Termux → 拉唤醒锁
2. 传文件或在线下载，`bash termux-setup.sh` 一键装好启动
3. 电脑的 `.ds-bridge-profile-cn` 拷到手机 `~/` = 登录态迁移，免扫码
4. 酒馆连 `http://127.0.0.1:8788/v1`

---

## 测试

```powershell
node test/stream.test.mjs    # SSE 解析器，12 项，离线
node test/auth.test.mjs      # key 校验 + 预设结构，27 项，离线
node test/presets.test.mjs   # 预设解析/存储/导出/路径安全，43 项，离线
node test/sites.e2e.mjs      # 入口定义 + 切换，34 项（离线断言 + 服务在跑时测切换）
node test/smoke.mjs          # 接口冒烟 + 认证，13 项
node test/e2e.mjs            # 真机：普通回复 + 流式 + 批量填表
node test/console.e2e.mjs    # 真机：控制台生命周期
node test/nsfw.e2e.mjs       # 真机：认证拦截 + NSFW 产出
```

离线测试不需要服务在跑，也不需要登录。真机测试会用到**当前启用的入口**，所以切到未登录的国际站时它们会失败——这是正确行为，不是 bug。

`sites.e2e.mjs` 会自己还原原来的入口，可以反复跑。

实测（单账号，`DS_CONCURRENCY=2`）：

| 场景 | 耗时 |
|---|---|
| 单字段短回复 | ~1.0 s |
| 批量填表 4 字段整行 | ~1.4 s |

对比逐字段串行调用，4 字段从 ~4 s 降到 ~1.4 s；字段越多差距越大。

---

## 已知边界

- 走的是网页端会话，**同一账号有频率限制**，别把并发开大。两个入口各自独立计数。
- DeepSeek 改接口时只需更新 `lib/stream.mjs` 的帧处理，其余不动。
- 破限是提示词层面的，模型侧仍有概率拒绝；`presets/*.txt` 是可迭代的，实测不理想就调那两段。
- 桥的浏览器窗口最小化待在任务栏，别手动关整个浏览器进程——关了也能自动恢复，但断几秒。
- 两个入口同时启用会开两个浏览器实例，各占一份内存。不用国际站时不切过去就不会启动它。
- `/v1/console/bootstrap` 只对 `127.0.0.1` 开放。**绑到 `0.0.0.0` 时 API key 认证是唯一防线**（`start-server.bat` 会强制要求 key），公网部署务必确认 `apiKeys` 非空，或者再加一层反向代理认证。
