<!-- i18n-section: common -->
<!--
	The language switch (WP-2.5; docs/ui.md § Language), drawn from the
	engine's language table (LANGUAGES), so a new language needs no change
	here. With two languages it is a button pair, English | Afrikaans; with
	three or more a <select>. Either way each language is named in its own
	language and marked with its `lang`, so a screen reader says each name
	right. The choice applies at once, is kept on this device (sign-in pages)
	and, signed in, saved to the account (PATCH /auth/me { locale }), where the
	emails read it too. `compact` shows EN | AF for a phone header; the full
	names stay the accessible names. `segmented` joins the buttons into one
	control sized like the form fields around it (the account page), 44 px on
	touch and phones. `addressOf` makes each language a link to its own
	address (the landing page, `/welcome` and `/welcome/af`, issue #137),
	however many languages there are: it works before any script runs, the
	chosen one is marked `aria-current`, and a click keeps the choice like a
	button does; the address sets the words.
-->
<script lang="ts">
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { i18n, isLocale, LANGUAGES, setLocale, storeLocale, t, type Locale } from './locale.svelte';

	let {
		compact = false,
		segmented = false,
		addressOf
	}: { compact?: boolean; segmented?: boolean; addressOf?: (locale: Locale) => string } = $props();
	let failed = $state(false);

	/** Past two languages a row of buttons gets long on a phone: a <select> instead. */
	const asList = LANGUAGES.length > 2;

	/** Keep the choice on this device and, signed in, on the account. */
	async function keep(locale: Locale) {
		failed = false;
		storeLocale(locale);
		if (session.user) {
			try {
				session.user = await api.auth.updateMe({ locale });
			} catch {
				failed = true;
			}
		}
	}

	async function choose(locale: Locale) {
		if (locale === i18n.locale) return;
		const switching = setLocale(locale);
		await keep(locale);
		await switching;
	}
</script>

{#if addressOf}
	<!-- Not preloaded on hover: the other language's catalogue loads on the click. -->
	<div class="lang" class:compact class:segmented role="group" aria-label={t('Language')} data-sveltekit-preload-data="off">
		{#each LANGUAGES as l (l.code)}
			<a
				href={addressOf(l.code)}
				hreflang={l.code}
				lang={l.code}
				aria-current={i18n.locale === l.code ? 'true' : undefined}
				aria-label={compact ? l.name : undefined}
				onclick={() => void keep(l.code)}
			>
				{compact ? l.code.toUpperCase() : l.name}
			</a>
		{/each}
	</div>
{:else if asList}
	<select
		class="lang-select"
		class:compact
		class:segmented
		aria-label={t('Language')}
		lang={i18n.locale}
		value={i18n.locale}
		onchange={(e) => {
			const v = e.currentTarget.value;
			if (isLocale(v)) void choose(v);
		}}
	>
		{#each LANGUAGES as l (l.code)}
			<option value={l.code} lang={l.code}>{l.name}</option>
		{/each}
	</select>
{:else}
	<div class="lang" class:compact class:segmented role="group" aria-label={t('Language')}>
		{#each LANGUAGES as l (l.code)}
			<button type="button" lang={l.code} aria-pressed={i18n.locale === l.code} aria-label={compact ? l.name : undefined} onclick={() => choose(l.code)}>
				{compact ? l.code.toUpperCase() : l.name}
			</button>
		{/each}
	</div>
{/if}
<p class="lang-status" role="status">{failed ? t('Couldn’t save your choice to your account. It applies on this device.') : ''}</p>

<style>
	.lang {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.lang button,
	.lang a {
		min-height: var(--tap, 44px);
		min-width: var(--tap, 44px);
		padding: 0 12px;
		font: inherit;
		font-size: 15px;
		color: var(--accent);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	/* A link looks like the button pair (the landing page's addresses, issue #137). */
	.lang a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		text-decoration: none;
	}
	.lang button[aria-pressed='true'],
	.lang a[aria-current='true'] {
		color: var(--accent-contrast, #fff);
		background: var(--accent);
		border-color: var(--accent);
		font-weight: 600;
	}
	/* The compact pair sits in a header (the farm view, the sign-in pages, the
	   landing page, /share): kept on one row, so at 320 px it doesn't stack EN
	   over AF and double the sticky header's height (WCAG 1.4.10). */
	.lang.compact {
		flex-wrap: nowrap;
	}
	.lang.compact button,
	.lang.compact a {
		padding: 0 8px;
		font-size: 14px;
	}
	.lang.segmented {
		gap: 0;
	}
	.lang.segmented button {
		min-height: 2.25rem;
		padding: 0 14px;
		font-size: 0.9rem;
		color: var(--text);
		border-radius: 0;
	}
	.lang.segmented button:first-child {
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}
	.lang.segmented button:last-child {
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	}
	.lang.segmented button + button {
		margin-left: -1px;
	}
	.lang.segmented button:hover:not([aria-pressed='true']) {
		background: var(--surface-2);
	}
	.lang.segmented button[aria-pressed='true'] {
		color: var(--accent-contrast, #fff);
		position: relative;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.lang.segmented button {
			min-height: var(--tap, 44px);
		}
	}
	.lang-select {
		min-height: var(--tap, 44px);
		padding: 0 8px;
		font: inherit;
		font-size: 15px;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}
	.lang-select.compact {
		font-size: 14px;
	}
	.lang-select.segmented {
		min-height: 2.25rem;
		font-size: 0.9rem;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.lang-select.segmented {
			min-height: var(--tap, 44px);
		}
	}
	.lang-status {
		margin: 0;
		font-size: 14px;
		color: var(--warning);
	}
	.lang-status:empty {
		display: none;
	}
</style>
