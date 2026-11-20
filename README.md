# dsh-desktop-autoweb

A minimal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
**at Desktop startup, it launches `dsh web` — exactly the command you would type
by hand — and records the authenticated URL that command prints.**

One file of logic (`index.js`, ~130 lines), zero dependencies, zero build step.

```
Desktop app starts
        │
        ▼
  profileContext.name === 'desktop' ?
        │ yes
        ▼
  spawn ── DeepSeek Harness.exe --expose-internals …/dsh-desktop-host/lib/cli.js web --port 0
        │
        ▼
  child prints  "dsh web: http://127.0.0.1:64961/?token=…"
        │
        ▼
  plugin writes  $DSH_HOME/desktop-autoweb.url
```

---

## Why a child process is required

`dsh web` is not a library function; it is a **process launch**:

```
dsh web
  → resources/runtime/cli/bin/dsh.cmd
  → "DeepSeek Harness.exe" --expose-internals …/dsh-desktop-host/lib/cli.js web
  → runProfile({ profile: "web", … })
```

Three hard constraints make an in-process switch impossible:

| Constraint | Detail |
| --- | --- |
| One profile per process | `profileContext.name` is `provide()`d once by `profile-boot` and never changes. The Desktop host is `desktop`, permanently. |
| Startup-injected config | The host's port, host, TLS and patch layers are fixed at boot (`--no-open --host 127.0.0.1 --port 0`). |
| Different content | The Desktop window already serves a page at `127.0.0.1:60415` — but that is the **`desktop`** profile (dshmarket, sidebar, pet, workbuddy …). `dsh web` serves the clean **`web`** profile (`dsh-base` + `dsh-web-app` only). Two profiles ⇒ two processes. |

So the plugin does not "write an HTTP server". It runs the same CLI the shim
runs, with the same binary and the same entry point.

---

## How it works, step by step

`index.js` exports a Cordis plugin (`name`, `inject`, `apply`). Its patch layer
inserts one row into the profile:

```yaml
# cordis.patch.yml
- insert:
    - id: desktop-autoweb
      name: 'dsh-desktop-autoweb'
      config:
        openBrowser: true
        port: 0
```

### 1. Detect the Desktop side

```js
const profile = ctx.get('profileContext')
if (profile?.name !== 'desktop') return
```

This is the **same idiom DeepSeek Harness itself uses** in
`@deepseek-ai/dsh-web-app/cordis.patch.yml:303`:

```yaml
disabled: !!js "ctx.get('profileContext')?.name !== 'desktop' || !process.env.DSH_PRIMARY_RUNTIME"
```

Under any other profile — including `web`, the profile the child boots — the row
returns immediately, so no spawn chain can form.

### 2. Guard against a nested spawn

The child inherits `DSH_DESKTOP_AUTOWEB_CHILD=1`, and the row bails out if it
sees that marker. Belt and braces on top of step 1.

### 3. Spawn exactly what `dsh web` does

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

`desktopCliPath()` resolves `…/@deepseek-ai/dsh-desktop-host/lib/cli.js` from
`$DSH_INSTALL_DIR` (or, failing that, from
`dirname(process.execPath)/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`).

### 4. Give the child a clean environment

The child must boot the **`web`** profile, not inherit the parent's `desktop`
identity. So every `DSH_*` variable is dropped — except `DSH_HOME`, which only
says where the profile tree lives:

```js
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue
  if (key.toUpperCase().startsWith('DSH_') && key !== 'DSH_HOME') continue
  environment[key] = value
}
environment.ELECTRON_RUN_AS_NODE = '1'
environment[CHILD_MARK] = '1'
```

This mirrors `scrubbedParentEnv()` in `@deepseek-ai/dsh-subprocess`.

### 5. Parse the URL and persist it

`@deepseek-ai/dsh-web-app` prints one line when its `printUrl` option is on
(default `true`):

```
dsh web: http://127.0.0.1:64961/?token=hGFrn1-…
```

The plugin line-buffers both `stdout` and `stderr`, matches
`/^dsh web: (\S+)$/u`, logs it, and writes it to:

```
$DSH_HOME/desktop-autoweb.url
```

**The file matters.** On Windows the Electron GUI host's stdout is not visible
to the user and is not logged anywhere, so a bare `console.log` would leave a
running server nobody can reach.

### 6. One server per process — not per plugin load

```js
const OWNED = Symbol.for('dsh-desktop-autoweb.owned')
if (globalThis[OWNED] !== undefined) return
…
globalThis[OWNED] = child
process.once('exit', () => child.kill())
```

State lives on `globalThis`, not on a module variable, because Cordis disposes
and re-evaluates the module on every HMR reload. A web server's lifetime is the
**process**, so a reload must neither kill it nor start a second one.

### 7. Clear the stale URL

At startup the plugin deletes any leftover `desktop-autoweb.url`, so a URL from
a previous run never points at a server that no longer exists.

---

## The URL needs its token

DSH's web surface is authenticated. `@deepseek-ai/dsh-client-connection`
exchanges `?token=<launch token>` for a signed cookie and redirects; without it
the page answers **401** with `dsh web authentication required; reopen the URL
printed by dsh web.`

Verified against a live instance:

```
with token     → 303
without token  → 401
```

So use the URL from `$DSH_HOME/desktop-autoweb.url`, bookmark it, or let
`openBrowser` open it for you.

---

## Install

### Inside DeepSeek Harness (recommended)

Ask the agent to install the bundle, or use **Plugins → Add plugin** and point
it at this directory. Under the hood that is:

```
plugin_manager  action: install_bundle  target: <absolute path to this folder>
```

Confirmed result:

```json
{ "stage": "enable", "enabled": true, "changed": true, "application": "applied" }
```

The profile's `package.json` then carries the link dependency and the bundle is
added to `dsh.profile.bundles`. Installing a new bundle activates through HMR;
a reload runs `apply` again, which is exactly why the guards in steps 1–6 exist.

### Manual

The CLI can also manage the profile directly — the Desktop-managed `desktop`
profile is accepted when invoked through the Desktop host wrapper:

```
dsh plugin --profile desktop add <path-to-this-folder>
```

---

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `openBrowser` | `true` | Open the authenticated URL in the default browser, like a hand-run `dsh web`. Set `false` to only record the URL. |
| `port` | `0` | `0` picks a free port. A number pins one. |

Edit them in the bundle's `cordis.patch.yml`, or through **Plugins** in the GUI.

```yaml
- insert:
    - id: desktop-autoweb
      name: 'dsh-desktop-autoweb'
      config:
        openBrowser: false
        port: 3080
```

---

## Requirements

- DeepSeek Harness **Desktop** (the plugin is inert under any other profile).
- `$DSH_INSTALL_DIR`, or a standard install layout, to locate
  `dsh-desktop-host/lib/cli.js`.
- Node ≥ 20 for the plugin module itself (the Desktop host already ships one).

---

## Turning it off

Disable the bundle. The extra Web server stops; the Desktop window and its own
GUI (`http://127.0.0.1:60415` in a typical run) are unaffected — they were never
the same process.

---

## Repository layout

```
dsh-desktop-autoweb/
├── package.json          # bundle manifest: dsh.bundle.patch, exports, files
├── cordis.patch.yml      # inserts the `desktop-autoweb` row with its config
├── index.js              # the whole plugin (~130 lines)
├── icon.svg              # ≤256 KiB, listed in `files` and `exports`
├── locale/
│   ├── en.json           # meta.title / meta.description shown in Plugins
│   └── zh.json
├── README.md             # this file
├── README-zh-cn.md       # Chinese version of this file
├── LICENSE               # MIT
└── .gitignore
```

## License

MIT
