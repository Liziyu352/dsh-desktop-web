/**
 * dsh-desktop-web — the browser half.
 *
 * One settings page: the port the Web build should listen on, and the
 * experimental switch that boots that Web build over the Desktop profile
 * instead of the `web` one.
 *
 * The page is a projection of the plugin's own volatile Config — it writes
 * through `configForms`, so persistence, validation and secret handling stay
 * with the Harness and this file only draws the two controls.
 *
 * @module dsh-desktop-web/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-desktop-web',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace and the Loader entry id this page edits. */
		const NS = 'dsh-desktop-web'
		const ENTRY_ID = 'desktop-autoweb'

		const zh = {
			section: '桌面端自动启动网页版',
			intro: '桌面端启动时，会在后台再跑一个 `dsh web`，把网页版 DeepSeek Harness 开在一个独立进程里。这里的设置会立即重建那个进程。',
			portTitle: '网页版端口',
			portDescription: '留 0 由系统挑选空闲端口。默认 0；被占用时建议换一个具体的端口。',
			portInvalid: '端口必须是 0 到 65535 之间的整数。',
			portSave: '保存',
			portBusy: '保存中…',
			sharedTitle: '让网页版共享桌面端的插件和配置',
			sharedDescription: '开启后，网页版不再使用只有基础插件的 `web` Profile，而是直接以桌面端的 Profile 启动，于是网页版里也能看到桌面端安装的全部插件和设置。',
			sharedWarning: '尽管绝大多数插件都是Web/Desktop全兼容，但谁都无法保证某个插件是Desktop-only(例如dsh-wallpaper-engine)，所以请三思而后行',
			sharedBadge: '实验性功能',
			unavailable: '这份 Profile 没有提供可编辑的配置表单，设置页无法读写。',
			failed: '保存失败',
			urlHint: '网页版的完整地址（带访问令牌）会写到 Harness 主目录下的 `desktop-autoweb.url`。',
		}

		const en = {
			section: 'Desktop Auto-Web',
			intro: 'When Desktop starts it also runs a `dsh web` in the background, serving the browser surface of DeepSeek Harness from its own process. Changes here rebuild that process immediately.',
			portTitle: 'Web build port',
			portDescription: 'Leave 0 to let the operating system pick a free port. A specific port is useful when the chosen one is taken.',
			portInvalid: 'The port must be an integer between 0 and 65535.',
			portSave: 'Save',
			portBusy: 'Saving…',
			sharedTitle: 'Share Desktop plugins and configuration with the Web build',
			sharedDescription: 'When this is on the Web build no longer boots the minimal `web` profile; it boots the Desktop profile itself, so every plugin and setting installed for Desktop is present in the browser too.',
			sharedWarning: 'Almost every plugin works on both Web and Desktop, but nobody can guarantee that a given plugin is not Desktop-only (dsh-wallpaper-engine, for example). Turn this on only after weighing that risk.',
			sharedBadge: 'Experimental',
			unavailable: 'This profile exposes no editable configuration form, so this page has nothing to read or write.',
			failed: 'Could not save',
			urlHint: 'The full address of the Web build, token included, is written to `desktop-autoweb.url` in the Harness home.',
		}

		const DICTIONARIES = { zh, en }

		/** Last locale this plugin observed, used only by the defensive fallback. */
		let activeLocale = 'en'

		/**
		 * Read a translated string for the locale the Host is showing.
		 * @param locale - active locale id.
		 * @param key - dictionary key.
		 * @returns the translated text.
		 */
		function translate(locale, key) {
			const dictionary = DICTIONARIES[locale] ?? en
			return dictionary[key] ?? en[key] ?? key
		}

		/**
		 * Resolve the translate seat a component was rendered with, falling back to
		 * the last locale this plugin observed so a component never throws when a
		 * seat is missing.
		 * @param t - the injected translate function, when the slot provided one.
		 * @returns a translate function.
		 */
		function translateSeat(t) {
			if (typeof t === 'function') return t
			return (key) => translate(activeLocale, key)
		}

		/**
		 * Follow one configuration form.
		 * @param form - the form controller, when the Host serves one.
		 * @returns the current snapshot.
		 */
		function useFormSnapshot(form) {
			const [snapshot, setSnapshot] = React.useState(() => form?.getSnapshot?.())
			React.useEffect(() => {
				if (form?.subscribe === undefined) {
					setSnapshot(undefined)
					return undefined
				}
				setSnapshot(form.getSnapshot())
				return form.subscribe(() => setSnapshot(form.getSnapshot()))
			}, [form])
			return snapshot
		}

		const styles = {
			page: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '8px' },
			heading: { fontSize: '16px', lineHeight: '24px', fontWeight: 600, margin: '0 0 4px' },
			intro: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px', maxWidth: '56ch' },
			row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '24px', padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
			rowLast: { borderBottom: 'none' },
			title: { fontSize: '14px', lineHeight: '20px', display: 'flex', alignItems: 'center', gap: '8px' },
			description: { marginTop: '4px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px', maxWidth: '52ch' },
			badge: { fontSize: '10px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px', color: 'var(--dsw-alias-brand-primary, #247bbf)', border: '0.5px solid var(--dsw-alias-brand-primary, #247bbf)' },
			warning: { marginTop: '8px', padding: '8px 10px', borderRadius: '6px', fontSize: '12px', lineHeight: '18px', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))', borderLeft: '2px solid var(--dsw-alias-brand-primary, #247bbf)' },
			control: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 },
			input: { width: '96px', padding: '4px 8px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px' },
			save: { padding: '4px 10px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
			switch: (checked, busy) => ({
				position: 'relative', flexShrink: 0, width: '40px', height: '22px', padding: 0, borderRadius: '11px', border: 'none',
				cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, transition: 'background 120ms',
				background: checked ? 'var(--dsw-alias-brand-primary, #247bbf)' : 'var(--dsw-alias-border-l2)',
			}),
			knob: (checked) => ({
				position: 'absolute', top: '3px', left: checked ? '21px' : '3px', width: '16px', height: '16px',
				borderRadius: '50%', background: '#fff', transition: 'left 120ms',
			}),
			alert: { marginTop: '8px', color: 'var(--dsw-alias-label-error, #d43)', fontSize: '12px' },
			hint: { marginTop: '12px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
		}

		/**
		 * Render the port row, which commits on Save or Enter.
		 * @param props - injected form, locale and translate function.
		 * @returns the row.
		 */
		function PortRow({ form, value, t }) {
			const say = translateSeat(t)
			const [draft, setDraft] = React.useState(String(value ?? 0))
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(undefined)

			React.useEffect(() => {
				setDraft(String(value ?? 0))
			}, [value])

			const commit = async () => {
				const port = Number(draft.trim())
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					setError(say('portInvalid'))
					return
				}
				if (port === value) {
					setError(undefined)
					return
				}
				setBusy(true)
				setError(undefined)
				try {
					await form.set('port', port)
				} catch (failure) {
					setError(`${say('failed')}: ${failure?.message ?? String(failure)}`)
				} finally {
					setBusy(false)
				}
			}

			return h('div', { style: styles.row },
				h('div', null,
					h('div', { style: styles.title }, say('portTitle')),
					h('div', { style: styles.description }, say('portDescription')),
					error === undefined ? null : h('div', { role: 'alert', style: styles.alert }, error),
				),
				h('div', { style: styles.control },
					h('input', {
						type: 'number', inputMode: 'numeric', min: 0, max: 65535, step: 1,
						value: draft, disabled: busy, style: styles.input, 'aria-label': say('portTitle'),
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') void commit()
						},
					}),
					h('button', { type: 'button', disabled: busy, style: styles.save, onClick: () => void commit() },
						busy ? say('portBusy') : say('portSave')),
				),
			)
		}

		/**
		 * Render the experimental sharing row.
		 * @param props - injected form and translate function.
		 * @returns the row.
		 */
		function SharedRow({ form, checked, t }) {
			const say = translateSeat(t)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(undefined)

			const toggle = async () => {
				setBusy(true)
				setError(undefined)
				try {
					await form.set('sharedProfile', checked !== true)
				} catch (failure) {
					setError(`${say('failed')}: ${failure?.message ?? String(failure)}`)
				} finally {
					setBusy(false)
				}
			}

			return h('div', { style: { ...styles.row, ...styles.rowLast } },
				h('div', null,
					h('div', { style: styles.title },
						say('sharedTitle'),
						h('span', { style: styles.badge }, say('sharedBadge')),
					),
					h('div', { style: styles.description }, say('sharedDescription')),
					// The caution belongs to the feature, not to its current state: it
					// stays visible whether the switch is on or off.
					h('div', { style: styles.warning }, say('sharedWarning')),
					error === undefined ? null : h('div', { role: 'alert', style: styles.alert }, error),
				),
				h('button', {
					type: 'button', role: 'switch', 'aria-checked': checked === true, disabled: busy,
					'aria-label': say('sharedTitle'), style: styles.switch(checked === true, busy),
					onClick: () => void toggle(),
				}, h('span', { style: styles.knob(checked === true) })),
			)
		}

		/**
		 * The settings page itself.
		 * @param props - values injected when the slot renders this component.
		 * @returns the page.
		 */
		function Section({ form, t }) {
			const say = translateSeat(t)
			const snapshot = useFormSnapshot(form)
			const value = snapshot?.value ?? {}

			if (snapshot?.status === 'unavailable' || form === undefined) {
				return h('div', { style: styles.page },
					h('h2', { style: styles.heading }, say('section')),
					h('div', { role: 'alert', style: styles.alert }, say('unavailable')),
				)
			}

			return h('div', { style: styles.page },
				h('h2', { style: styles.heading }, say('section')),
				h('p', { style: styles.intro }, say('intro')),
				h(PortRow, { form, value: value.port, t: say }),
				h(SharedRow, { form, checked: value.sharedProfile === true, t: say }),
				h('p', { style: styles.hint }, say('urlHint')),
			)
		}

		return {
			name: 'dsh-desktop-web-client',
			inject: ['slots', 'locale'],

			apply(ctx) {
				const forms = ctx.get('configForms')
				if (forms === undefined || typeof forms.get !== 'function') return
				const form = forms.get(ENTRY_ID)

				// The nav label and the injected `t` are thunks: `settings.section`
				// re-reads them on every projection, so resolving the active locale
				// inside them follows a locale change without re-registering.
				const locale = () => {
					activeLocale = ctx.locale?.getSnapshot?.().active ?? activeLocale
					return activeLocale
				}

				ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
					name: 'settings.section',
					id: NS,
					order: 120,
					label: () => translate(locale(), 'section'),
					inject: () => ({ form, t: (key) => translate(locale(), key) }),
				}, Section)), 'dsh-desktop-web: settings page')
			},
		}
	},
})
