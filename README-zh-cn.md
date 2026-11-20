# dsh-desktop-autoweb

一个极简的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
**在桌面端启动时运行一次 `dsh web` —— 就是你手敲的那条命令 —— 并把该命令打印出来的带鉴权 URL 记录下来。**

逻辑只有一个文件（`index.js`，约 130 行），零依赖、零构建。

```
桌面端启动
        │
        ▼
  profileContext.name === 'desktop' ？
        │ 是
        ▼
  spawn ── DeepSeek Harness.exe --expose-internals …/dsh-desktop-host/lib/cli.js web --port 0
        │
        ▼
  子进程输出  "dsh web: http://127.0.0.1:64961/?token=…"
        │
        ▼
  插件写入  $DSH_HOME/desktop-autoweb.url
```

---

## 为什么必须是子进程

`dsh web` 不是一个可以在当前进程里调用的函数，它本身就是**启动一个进程**：

```
dsh web
  → resources/runtime/cli/bin/dsh.cmd
  → "DeepSeek Harness.exe" --expose-internals …/dsh-desktop-host/lib/cli.js web
  → runProfile({ profile: "web", … })
```

三条硬约束决定了无法“就地变成网页版”：

| 约束 | 具体表现 |
| --- | --- |
| 一个进程只能有一个 profile | `profileContext.name` 由 `profile-boot` 在启动时 `provide()` 一次，之后不再改变。桌面宿主永远是 `desktop`。 |
| 端口与配置在启动时注入 | 宿主自己的端口、host、TLS、patch 层都在 boot 时定死（`--no-open --host 127.0.0.1 --port 0`）。 |
| 提供的内容不同 | 桌面端窗口已经在 `127.0.0.1:60415` 提供服务了，但那是 **`desktop`** profile（带 dshmarket、侧边栏、桌宠、workbuddy 等）。`dsh web` 提供的是干净的 **`web`** profile（只有 `dsh-base` + `dsh-web-app`）。两个 profile ⇒ 两个进程。 |

所以插件并没有“自己写一个 HTTP 服务”，它跑的就是 shim 跑的那条 CLI，同一个可执行文件、同一个入口。

---

## 工作流程

`index.js` 导出一个 Cordis 插件（`name`、`inject`、`apply`）。它的 patch 层往 profile 里插入一行：

```yaml
# cordis.patch.yml
- insert:
    - id: desktop-autoweb
      name: 'dsh-desktop-autoweb'
      config:
        openBrowser: true
        port: 0
```

### 1. 判定是否为桌面端

```js
const profile = ctx.get('profileContext')
if (profile?.name !== 'desktop') return
```

这是 **DeepSeek Harness 自己就在用的写法**，见
`@deepseek-ai/dsh-web-app/cordis.patch.yml:303`：

```yaml
disabled: !!js "ctx.get('profileContext')?.name !== 'desktop' || !process.env.DSH_PRIMARY_RUNTIME"
```

任何其它 profile —— 包括子进程自己要启动的 `web` —— 在这里就直接返回，因此不可能形成套娃。

### 2. 防止嵌套启动

子进程会带上 `DSH_DESKTOP_AUTOWEB_CHILD=1`，插件一旦看到这个标记也直接返回。这是在步骤 1 之外的第二道保险。

### 3. 启动与 `dsh web` 完全相同的命令

```js
const args = ['--expose-internals', desktopCliPath(), 'web', '--port', String(config.port ?? 0)]
if (config.openBrowser === false) args.push('--no-open')
spawn(process.execPath, args, {
  cwd: profile.cwd,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnvironment(),
})
```

`desktopCliPath()` 从 `$DSH_INSTALL_DIR` 解析出
`…/@deepseek-ai/dsh-desktop-host/lib/cli.js`；没有该变量时回退到
`dirname(process.execPath)/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`。

### 4. 给子进程一个干净的环境

子进程必须启动 **`web`** profile，不能继承父进程的 `desktop` 身份。因此所有 `DSH_*` 变量都被剔除，
只保留 `DSH_HOME` —— 它只说明 profile 树在哪里，不说明当前是谁：

```js
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue
  if (key.toUpperCase().startsWith('DSH_') && key !== 'DSH_HOME') continue
  environment[key] = value
}
environment.ELECTRON_RUN_AS_NODE = '1'
environment[CHILD_MARK] = '1'
```

这与 `@deepseek-ai/dsh-subprocess` 里的 `scrubbedParentEnv()` 是同一套策略。

### 5. 解析 URL 并落盘

`@deepseek-ai/dsh-web-app` 在 `printUrl` 打开时（默认 `true`）会打印一行：

```
dsh web: http://127.0.0.1:64961/?token=hGFrn1-…
```

插件对 `stdout` 和 `stderr` 都做行缓冲，用 `/^dsh web: (\S+)$/u` 匹配，打印到日志，
并写入：

```
$DSH_HOME/desktop-autoweb.url
```

**这一步是必需的**：Windows 上 Electron GUI 宿主的 stdout 用户根本看不到，也不会写进任何日志文件，
只 `console.log` 的话，服务器起来了但没人能访问。

### 6. 每个进程一个服务器，而不是每次插件加载一个

```js
const OWNED = Symbol.for('dsh-desktop-autoweb.owned')
if (globalThis[OWNED] !== undefined) return
…
globalThis[OWNED] = child
process.once('exit', () => child.kill())
```

状态放在 `globalThis` 而不是模块级变量，因为 Cordis 每次 HMR 重载都会销毁并重新求值模块。
Web 服务器的生命周期是**进程**，所以重载既不能杀掉它，也不能再起一个。

> 早期版本把 spawn 放在 `ctx.effect(...)` 里，结果每次重载 disposer 都杀服务器、下次加载再起一个新的，
> 出现了多个重复的 `dsh web` 子进程。这就是改成 `globalThis` 的原因。

### 7. 清理过期的 URL

启动时先删掉上一次留下的 `desktop-autoweb.url`，避免文件里的 URL 指向一个已经不存在的服务器。

---

## URL 必须带 token

DSH 的 Web 界面是带鉴权的。`@deepseek-ai/dsh-client-connection` 会用 `?token=<launch token>`
换取签名 cookie 再跳转；不带 token 时页面返回 **401**，正文是
`dsh web authentication required; reopen the URL printed by dsh web.`

实测（对接真实实例）：

```
带 token      → 303
不带 token    → 401
```

所以请使用 `$DSH_HOME/desktop-autoweb.url` 里的完整 URL，或让它自动打开浏览器。

---

## 安装

### 在 DeepSeek Harness 里（推荐）

让 agent 安装该 bundle，或用 **插件 → 添加插件** 指到本目录。底层等价于：

```
plugin_manager  action: install_bundle  target: <本目录的绝对路径>
```

已确认的返回：

```json
{ "stage": "enable", "enabled": true, "changed": true, "application": "applied" }
```

之后 profile 的 `package.json` 会带上 link 依赖，`dsh.profile.bundles` 里也会出现它。
新 bundle 通过 HMR 即可生效；重载会再次执行 `apply`，步骤 1–6 的那些防护正是为此存在。

### 手动

CLI 也能直接管理 profile —— 通过桌面端宿主包装器调用时，`desktop` profile 是被允许的：

```
dsh plugin --profile desktop add <本目录路径>
```

---

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `openBrowser` | `true` | 用默认浏览器打开带鉴权的 URL，与手敲 `dsh web` 一致。设 `false` 则只记录 URL。 |
| `port` | `0` | `0` 表示自动选空闲端口；写数字则固定端口。 |

在本 bundle 的 `cordis.patch.yml` 里改，或通过 GUI 的 **插件** 页改。

```yaml
- insert:
    - id: desktop-autoweb
      name: 'dsh-desktop-autoweb'
      config:
        openBrowser: false
        port: 3080
```

---

## 依赖条件

- DeepSeek Harness **桌面端**（其它 profile 下插件完全不动作）。
- `$DSH_INSTALL_DIR`，或标准安装目录结构，用于定位 `dsh-desktop-host/lib/cli.js`。
- 插件模块本身需要 Node ≥ 20（桌面端宿主已自带）。

---

## 关闭

禁用该 bundle 即可。额外的 Web 服务器会停止；桌面端窗口和它自己的 GUI
（按当前运行情况是 `http://127.0.0.1:60415`）不受影响 —— 它们本来就不是同一个进程。

---

## 目录结构

```
dsh-desktop-autoweb/
├── package.json          # bundle 清单：dsh.bundle.patch、exports、files
├── cordis.patch.yml      # 插入 `desktop-autoweb` 行及其配置
├── index.js              # 插件全部逻辑（约 130 行）
├── icon.svg              # ≤256 KiB，已在 files 与 exports 中声明
├── locale/
│   ├── en.json           # 插件页显示的 meta.title / meta.description
│   └── zh.json
├── README.md             # 英文说明
├── README-zh-cn.md       # 本文件
├── LICENSE               # MIT
└── .gitignore
```

## 许可证

MIT
