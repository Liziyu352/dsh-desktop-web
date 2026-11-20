/**
 * dsh-desktop-autoweb — run `dsh web` once, at Desktop startup.
 *
 * The Desktop application is itself a Web runtime over the `desktop` profile.
 * This bundle adds one row: when the running profile is `desktop`, it launches
 * a single `dsh web` (that is, `dsh --profile web`), which serves the browser
 * surface of DeepSeek Harness, and records the authenticated URL that process
 * prints at `$DSH_HOME/desktop-autoweb.url`.
 *
 * The row stays inert under every other profile — notably `web`, the profile
 * the launched child itself boots — so no spawn chain can form.
 *
 * @module dsh-desktop-autoweb
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'desktop-autoweb'

/** Current-profile facts; `name` is the profile this process booted. */
export const inject = ['profileContext']

/**
 * Editable fields. Only `.volatile()` fields reach the settings form, and a
 * volatile edit is committed into the running plugin without a restart — so
 * `apply` reads them through `.get()` and re-reads them on every change.
 */
export const Config = z.object({
	/** Preferred port for the Web build; `0` lets the operating system choose. */
	port: z.number().step(1).min(0).max(65535).default(0).volatile(),
	/** Boot the Web build over the Desktop profile instead of the `web` one. */
	sharedProfile: z.boolean().default(false).volatile(),
	/** Hand the authenticated URL to a browser window once the server is up. */
	openBrowser: z.boolean().default(true),
})

/** Set for the child process so a nested load can never spawn a third server. */
const CHILD_MARK = 'DSH_DESKTOP_AUTOWEB_CHILD'

/** The file holding the URL of the Web build this row started. */
const URL_FILE = 'desktop-autoweb.url'

/** The line `@deepseek-ai/dsh-web-app` prints when its `printUrl` is on. */
const URL_LINE = /^dsh web: (\S+)$/u

/**
 * The one child this host process may own. It is process-lifetime state, not
 * plugin-lifetime state: a plugin reload must not restart it, and a reload must
 * not leave the previous server orphaned either.
 */
const RUNTIME = Symbol.for('dsh-desktop-autoweb.runtime')

/** Set once the process-exit hook that stops the child has been installed. */
const HOOKED = Symbol.for('dsh-desktop-autoweb.hooked')

/**
 * Where releases before the settings page kept their child. A module reload
 * swaps in this file without disposing the old one, so the previous version's
 * server would survive as an orphan; `apply` reaps it through this key.
 */
const LEGACY_OWNED = Symbol.for('dsh-desktop-autoweb.owned')

/**
 * Profile the Web build boots when it shares the Desktop profile. The CLI
 * refuses `--profile desktop` outright, so sharing goes through a directory
 * junction at `$DSH_HOME/profiles/<this name>` and an overlay patch.
 */
const SHARED_PROFILE = 'desktop-shared'

/** Overlay written next to the URL file while the shared profile is in use. */
const SHARED_PATCH_FILE = 'desktop-autoweb.shared.yml'

/**
 * The Desktop profile configures itself for the Electron carrier: its LAN
 * bundle binds a wildcard address, and its connection block reads a service
 * that only exists there. Outside that carrier the Web runtime rejects both, so
 * the overlay rebinds the server to loopback and restates the required fields.
 */
const SHARED_PATCH = `# Written by dsh-desktop-autoweb — do not edit; it is regenerated on every start.
- id: webserver
  config:
    host: '127.0.0.1'
    port: !!js ctx.webStartup?.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
- id: connection
  config:
    trustedHosts: ['127.0.0.1', 'localhost']
`

/**
 * Read one configured value whether or not the loader wrapped it as a volatile
 * reference.
 * @param config - the row configuration.
 * @param key - field name.
 * @returns the current value, or `undefined`.
 */
function field(config, key) {
	const value = config?.[key]
	if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
	return value
}

/**
 * Locate the CLI entry the `dsh` shim runs, so the child starts exactly the way
 * `dsh web` would start it.
 * @returns the CLI script path.
 */
function desktopCliPath() {
	const installDir = process.env.DSH_INSTALL_DIR
	const anchor = installDir === undefined || installDir === ''
		? join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
		: installDir
	return join(anchor, '..', 'dsh-desktop-host', 'lib', 'cli.js')
}

/**
 * Build the child environment: the parent's, without this profile's own
 * markers — the child boots its own profile and must not inherit the facts of
 * the `desktop` one. `DSH_HOME` is the one `DSH_*` variable the child still
 * needs, because it says which home the profiles live under.
 * @returns an environment for the child process.
 */
function childEnvironment() {
	const environment = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue
		if (key.toUpperCase().startsWith('DSH_') && key !== 'DSH_HOME') continue
		environment[key] = value
	}
	environment.ELECTRON_RUN_AS_NODE = '1'
	environment[CHILD_MARK] = '1'
	return environment
}

/**
 * Point `link` at `target` through a directory junction, replacing a stale one.
 * A junction is a reparse point, so removing it must never touch its target.
 * @param link - the profile directory the loader will open.
 * @param target - the profile directory it stands for.
 */
function ensureJunction(link, target) {
	mkdirSync(dirname(link), { recursive: true })
	let current
	try {
		current = readlinkSync(link)
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw new Error(`${link} exists and is not a directory junction; move it away to share the Desktop profile`)
		}
	}
	if (current !== undefined) {
		if (resolve(current) === resolve(target)) return
		try {
			rmdirSync(link)
		} catch (error) {
			throw new Error(`could not replace the junction ${link}: ${error.message}`)
		}
	}
	symlinkSync(target, link, 'junction')
}

/**
 * Prepare the profile alias and overlay the shared Desktop profile needs.
 * @param home - the Harness home holding `profiles/`.
 * @returns the overlay patch path.
 */
function prepareSharedProfile(home) {
	ensureJunction(join(home, 'profiles', SHARED_PROFILE), join(home, 'profiles', 'desktop'))
	const patch = join(home, SHARED_PATCH_FILE)
	writeFileSync(patch, SHARED_PATCH, 'utf8')
	return patch
}

/**
 * Stop the child this host owns, if there is one.
 * @param state - the process-lifetime runtime record.
 */
function stopServer(state) {
	const child = state.child
	state.child = undefined
	if (child === undefined) return
	if (child.exitCode !== null || child.signalCode !== null) return
	try {
		child.kill()
	} catch {}
}

/**
 * Start one `dsh web` for this Desktop process.
 * @param state - the process-lifetime runtime record.
 * @param config - row configuration from `cordis.patch.yml`.
 */
function startServer(state, config) {
	const port = Number(field(config, 'port') ?? 0)
	const shared = field(config, 'sharedProfile') === true
	const args = ['--expose-internals', desktopCliPath()]

	if (shared) {
		try {
			const patch = prepareSharedProfile(state.home)
			args.push('--profile', SHARED_PROFILE, '--patch', patch)
		} catch (error) {
			console.error(`desktop-autoweb: not sharing the Desktop profile: ${error.message}`)
			args.push('web')
		}
	} else {
		args.push('web')
	}

	args.push('--port', String(Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0))
	if (field(config, 'openBrowser') === false) args.push('--no-open')

	// A URL left behind by a previous run points at a server that is gone.
	try {
		rmSync(state.urlPath, { force: true })
	} catch {}

	const child = spawn(process.execPath, args, {
		cwd: state.cwd,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: childEnvironment(),
	})
	state.child = child
	state.port = port
	state.shared = shared
	state.startedAt = Date.now()

	if (globalThis[HOOKED] !== true) {
		globalThis[HOOKED] = true
		process.once('exit', () => stopServer(state))
	}

	let announced = false
	const readLine = (text) => {
		const url = URL_LINE.exec(text)?.[1]
		if (url === undefined) {
			if (text.trim() !== '') console.log(`desktop-autoweb[dsh web]: ${text}`)
			return
		}
		announced = true
		console.log(`desktop-autoweb: web build listening at ${url}`)
		try {
			writeFileSync(state.urlPath, `${url}\n`)
		} catch (error) {
			console.error(`desktop-autoweb: could not write ${String(state.urlPath)}: ${error.message}`)
		}
	}

	for (const stream of [child.stdout, child.stderr]) {
		let pending = ''
		stream.setEncoding('utf8')
		stream.on('data', (chunk) => {
			pending += chunk
			for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
				readLine(pending.slice(0, at).replace(/\r$/u, ''))
				pending = pending.slice(at + 1)
			}
		})
	}

	child.once('error', (error) => {
		console.error(`desktop-autoweb: could not run dsh web: ${error.message}`)
	})
	child.once('exit', (code, signal) => {
		if (state.child === child) state.child = undefined
		const how = signal === null ? `code ${String(code)}` : `signal ${signal}`
		console.warn(`desktop-autoweb: dsh web stopped with ${how}${announced ? '' : ' before printing a URL'}`)
	})
}

/**
 * Kill a child a previous release of this plugin left behind.
 *
 * HMR replaces the module but never runs a disposer for a plain `apply`, so an
 * upgraded file inherits the process without the old child's handle. Nothing
 * else can reach it, and it holds a port the new server will try to bind.
 */
function reapLegacyChild() {
	const legacy = globalThis[LEGACY_OWNED]
	if (legacy === undefined) return
	delete globalThis[LEGACY_OWNED]
	try {
		if (legacy.exitCode === null && legacy.signalCode === null) legacy.kill()
	} catch {}
}

/**
 * Start `dsh web` once for this Desktop process, and keep the child in step
 * with the two settings a user can change while it runs.
 * @param ctx - plugin context carrying `profileContext`.
 * @param config - row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
	if (process.env[CHILD_MARK] === '1') return
	const profile = ctx.get('profileContext')
	if (profile?.name !== 'desktop') return

	reapLegacyChild()

	const home = profile.home ?? join(homedir(), '.dsh')
	const state = globalThis[RUNTIME] ?? (globalThis[RUNTIME] = {
		home,
		cwd: profile.cwd ?? process.cwd(),
		urlPath: join(home, URL_FILE),
		child: undefined,
		port: undefined,
		shared: undefined,
	})
	if (state.child === undefined) startServer(state, config)

	// A volatile edit reaches a running plugin without a restart, so the child
	// has to be rebuilt here — a new port or a new profile only exists in argv.
	ctx.on('loader/volatile-update', () => {
		const port = Number(field(config, 'port') ?? 0)
		const shared = field(config, 'sharedProfile') === true
		if (port === state.port && shared === state.shared) return
		stopServer(state)
		startServer(state, config)
	})
}


