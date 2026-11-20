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
import { rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'desktop-autoweb'

/** Current-profile facts; `name` is the profile this process booted. */
export const inject = ['profileContext']

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
const OWNED = Symbol.for('dsh-desktop-autoweb.owned')

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
 * markers — the child boots the `web` profile and must not inherit the facts of
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
 * Start `dsh web` once for this Desktop process.
 * @param ctx - plugin context carrying `profileContext`.
 * @param config - row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
	if (globalThis[OWNED] !== undefined) return
	const profile = ctx.get('profileContext')
	if (profile?.name !== 'desktop') return
	if (process.env[CHILD_MARK] === '1') return

	const args = ['--expose-internals', desktopCliPath(), 'web', '--port', String(config.port ?? 0)]
	if (config.openBrowser === false) args.push('--no-open')
	const urlPath = join(profile.home ?? join(homedir(), '.dsh'), URL_FILE)

	// A URL left behind by a previous run points at a server that is gone.
	try {
		rmSync(urlPath, { force: true })
	} catch {}

	const child = spawn(process.execPath, args, {
		cwd: profile.cwd ?? process.cwd(),
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: childEnvironment(),
	})
	globalThis[OWNED] = child
	process.once('exit', () => child.kill())

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
			writeFileSync(urlPath, `${url}\n`)
		} catch (error) {
			console.error(`desktop-autoweb: could not write ${String(urlPath)}: ${error.message}`)
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
		const how = signal === null ? `code ${String(code)}` : `signal ${signal}`
		console.warn(`desktop-autoweb: dsh web stopped with ${how}${announced ? '' : ' before printing a URL'}`)
	})
}
