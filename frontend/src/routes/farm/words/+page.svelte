<!-- i18n-section: farm -->
<script lang="ts">
	// "What do these words mean?" for farmers (docs/design/farmer-view.md §5.1):
	// the glossary's farmer entries ($lib/help/farmer, category 'farmer') in the
	// farm pages' frame, each with an anchor the pages link to. The same entries
	// appear in the workspace's /help glossary. In another language an entry
	// shows its reviewed translation (that language's $lib/help/content.<code>,
	// loaded on first use) when it has one, else the English, marked with its
	// own `lang` (WP-2.5).
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import FarmShell from '$lib/components/farm/FarmShell.svelte';
	import { holdAnchor } from '$lib/help/anchor';
	import { FARMER_HELP } from '$lib/help/farmer';
	import { helpTranslations, type HelpTranslation } from '$lib/help/translations';
	import { DEFAULT_LOCALE, i18n, t, wordsLang } from '$lib/i18n/locale.svelte';

	/**
	 * The chosen language's glossary, once loaded ({} for English). If its
	 * chunk can't load, the entries show in English, each marked lang="en".
	 */
	let translated = $state.raw<{ lang: string; entries: Record<string, HelpTranslation> }>({ lang: DEFAULT_LOCALE, entries: {} });
	$effect(() => {
		const lang = i18n.locale;
		let live = true;
		if (lang === DEFAULT_LOCALE) translated = { lang, entries: {} };
		else
			void helpTranslations(lang)
				.catch(() => ({}))
				.then((entries) => {
					if (live) translated = { lang, entries };
				});
		return () => {
			live = false;
		};
	});

	/** The entries wait for the chosen language's glossary, so they never show in English first. */
	const ready = $derived(translated.lang === i18n.locale);
	const entries = $derived(
		FARMER_HELP.map((e) => {
			const own = ready ? translated.entries[e.id] : undefined;
			return own
				? { id: e.id, term: own.term, short: own.short, long: own.long, lang: translated.lang }
				: { id: e.id, term: e.term, short: e.short, long: e.long, lang: DEFAULT_LOCALE };
		})
	);
	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so jump to #id once the list exists,
	// and hold the entry there while the page settles (lib/help/anchor.ts).
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id || !ready) return;
		let live = true;
		let release: (() => void) | undefined;
		tick().then(() => {
			const el = live ? document.getElementById(id) : null;
			if (el) release = holdAnchor(el);
		});
		return () => {
			live = false;
			release?.();
		};
	});
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: t('What do these words mean?') })}</title></svelte:head>

<FarmShell back={{ href: `${base}/farm`, label: t('My hydrological unit') }} busy={!ready}>
	<h1>{t('What do these words mean?')}</h1>
	{#each ready ? entries : [] as e (e.id)}
		<section class="card" id={e.id} aria-labelledby="{e.id}-h" lang={e.lang !== wordsLang() ? e.lang : undefined}>
			<h2 id="{e.id}-h">{e.term}</h2>
			<p><strong>{e.short}</strong></p>
			{#each paragraphs(e.long) as para, i (i)}<p>{para}</p>{/each}
		</section>
	{/each}
</FarmShell>
