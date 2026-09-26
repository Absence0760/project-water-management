<script lang="ts">
	// "What do these words mean?" for farmers (docs/design/farmer-view.md §5.1):
	// the glossary's farmer entries ($lib/help/content, category 'farmer') in the
	// farm pages' frame, each with an anchor the pages link to. The same entries
	// appear in the workspace's /help glossary.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import FarmShell from '$lib/components/farm/FarmShell.svelte';
	import { HELP } from '$lib/help/content';

	const entries = HELP.filter((e) => e.category === 'farmer');
	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so jump to #id once the list exists.
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id) return;
		tick().then(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
	});
</script>

<svelte:head><title>What do these words mean? · My farm</title></svelte:head>

<FarmShell back={{ href: `${base}/farm`, label: 'My farm' }}>
	<h1>What do these words mean?</h1>
	{#each entries as e (e.id)}
		<section class="card" id={e.id} aria-labelledby="{e.id}-h">
			<h2 id="{e.id}-h">{e.term}</h2>
			<p><strong>{e.short}</strong></p>
			{#each paragraphs(e.long) as para, i (i)}<p>{para}</p>{/each}
		</section>
	{/each}
</FarmShell>

<style>
	section {
		scroll-margin-top: 72px;
	}
</style>
