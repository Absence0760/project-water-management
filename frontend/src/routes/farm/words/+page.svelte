<!-- i18n-section: farm -->
<script lang="ts">
	// "What do these words mean?" for farmers (docs/design/farmer-view.md §5.1):
	// the glossary's farmer entries ($lib/help/farmer, category 'farmer') in the
	// farm pages' frame, each with an anchor the pages link to. The same entries
	// appear in the workspace's /help glossary. In Afrikaans an entry shows its
	// reviewed translation ($lib/help/content.af) when it has one, else the
	// English, marked with its own `lang` (WP-2.5).
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import FarmShell from '$lib/components/farm/FarmShell.svelte';
	import { holdAnchor } from '$lib/help/anchor';
	import { FARMER_HELP } from '$lib/help/farmer';
	import { HELP_AF } from '$lib/help/content.af';
	import { i18n, t, wordsLang } from '$lib/i18n/locale.svelte';

	const entries = $derived(
		FARMER_HELP.map((e) => {
			const af = i18n.locale === 'af' ? HELP_AF[e.id] : undefined;
			return af ? { id: e.id, term: af.term, short: af.short, long: af.long, lang: 'af' } : { id: e.id, term: e.term, short: e.short, long: e.long, lang: 'en' };
		})
	);
	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so jump to #id once the list exists,
	// and hold the entry there while the page settles (lib/help/anchor.ts).
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id) return;
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

<svelte:head><title>{t('{page} · My farm', { page: t('What do these words mean?') })}</title></svelte:head>

<FarmShell back={{ href: `${base}/farm`, label: t('My farm') }}>
	<h1>{t('What do these words mean?')}</h1>
	{#each entries as e (e.id)}
		<section class="card" id={e.id} aria-labelledby="{e.id}-h" lang={e.lang !== wordsLang() ? e.lang : undefined}>
			<h2 id="{e.id}-h">{e.term}</h2>
			<p><strong>{e.short}</strong></p>
			{#each paragraphs(e.long) as para, i (i)}<p>{para}</p>{/each}
		</section>
	{/each}
</FarmShell>
