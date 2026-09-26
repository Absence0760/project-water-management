<!--
	The language switch (WP-2.5; docs/ui.md § Language): English | Afrikaans,
	each named in its own language and marked with its `lang`, so a screen
	reader says each name right. The choice applies at once, is kept on this
	device (sign-in pages) and, signed in, saved to the account
	(PATCH /auth/me { locale }), where the emails read it too. `compact` shows
	EN | AF for a phone header; the full names stay the accessible names.
-->
<script lang="ts">
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { i18n, LANGUAGE_NAMES, LOCALES, setLocale, storeLocale, t, type Locale } from './locale.svelte';

	let { compact = false }: { compact?: boolean } = $props();
	let failed = $state(false);

	async function choose(locale: Locale) {
		if (locale === i18n.locale) return;
		failed = false;
		storeLocale(locale);
		const switching = setLocale(locale);
		if (session.user) {
			try {
				session.user = await api.auth.updateMe({ locale });
			} catch {
				failed = true;
			}
		}
		await switching;
	}
</script>

<div class="lang" class:compact role="group" aria-label={t('common.language')}>
	{#each LOCALES as l (l)}
		<button type="button" lang={l} aria-pressed={i18n.locale === l} aria-label={compact ? LANGUAGE_NAMES[l] : undefined} onclick={() => choose(l)}>
			{compact ? l.toUpperCase() : LANGUAGE_NAMES[l]}
		</button>
	{/each}
</div>
<p class="lang-status" role="status">{failed ? t('common.languageSaveFailed') : ''}</p>

<style>
	.lang {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.lang button {
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
	.lang button[aria-pressed='true'] {
		color: var(--accent-contrast, #fff);
		background: var(--accent);
		border-color: var(--accent);
		font-weight: 600;
	}
	.lang.compact button {
		padding: 0 8px;
		font-size: 14px;
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
