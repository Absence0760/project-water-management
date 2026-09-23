<script lang="ts">
	// Glossary and model help: every entry in $lib/help/content, grouped by
	// topic, searchable, with a stable anchor per term (/help#<id>) that the
	// HelpTips link to.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_TITLES, HELP, helpFor, searchHelp, type HelpCategory, type HelpEntry } from '$lib/help/content';

	let query = $state('');
	const results = $derived(searchHelp(query));
	const searching = $derived(query.trim().length > 0);
	const groups = $derived.by(() => {
		const out: { category: HelpCategory; entries: HelpEntry[] }[] = [];
		for (const category of Object.keys(CATEGORY_TITLES) as HelpCategory[]) {
			const entries = HELP.filter((e) => e.category === category);
			if (entries.length) out.push({ category, entries });
		}
		return out;
	});

	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so the browser's own jump to #id has
	// nothing to land on yet: scroll (and move focus) once the list exists.
	async function jumpToHash() {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id) return;
		query = '';
		await tick();
		const el = document.getElementById(id);
		if (!el) return;
		el.scrollIntoView({ block: 'start' });
		el.focus({ preventScroll: true });
	}
	$effect(() => {
		void page.url.hash;
		jumpToHash();
	});
</script>

<svelte:head><title>Help and glossary · Water Management</title></svelte:head>

<main class="page help">
	<header class="head">
		<h1>Help and glossary</h1>
		<p class="muted">
			What each input and result means, in hydrologists’ terms. Concepts follow the WBT b023 workbook (its Help,
			Models and configuration sheets) and the project’s model reference
			(<span class="mono">docs/model.md</span>); the wording is ours. Look for the <span aria-hidden="true">ⓘ</span> buttons next to fields for the short version.
		</p>
		<div class="search">
			<label for="help-q" class="visually-hidden">Search the glossary</label>
			<input id="help-q" type="search" placeholder="Search terms, e.g. EWR, crop factor, NSE" bind:value={query} autocomplete="off" />
			<p class="muted count" role="status" aria-live="polite">
				{#if searching}{results.length} {results.length === 1 ? 'match' : 'matches'}{/if}
			</p>
		</div>
	</header>

	{#snippet entryCard(e: HelpEntry)}
		<article class="entry panel" id={e.id} tabindex="-1" aria-labelledby="{e.id}-t">
			<h3>
				<span id="{e.id}-t">{e.term}</span>
				<a class="anchor" href="#{e.id}" aria-label="Link to {e.term}">#</a>
			</h3>
			<p class="short">{e.short}</p>
			{#each paragraphs(e.long) as para, i (i)}
				<p class="long">{para}</p>
			{/each}
			<dl class="meta">
				{#if e.units}<div><dt>Units</dt><dd>{e.units}</dd></div>{/if}
				{#if e.aliases?.length}<div><dt>Also called</dt><dd>{e.aliases.join(', ')}</dd></div>{/if}
				{#if e.related?.length}
					<div>
						<dt>See also</dt>
						<dd>
							{#each e.related as r, i (r)}
								{@const rel = helpFor(r)}
								{#if rel}<a href="{base}/help#{rel.id}">{rel.term}</a>{i < e.related.length - 1 ? ', ' : ''}{/if}
							{/each}
						</dd>
					</div>
				{/if}
				<div><dt>Source</dt><dd>{e.source}</dd></div>
			</dl>
		</article>
	{/snippet}

	{#if searching}
		<section aria-label="Search results">
			{#each results as e (e.id)}
				{@render entryCard(e)}
			{:else}
				<p class="muted">Nothing matches “{query}”. Try a shorter word or an abbreviation (EWR, MAP, NSE).</p>
			{/each}
		</section>
	{:else}
		<nav class="toc" aria-label="Topics">
			<ul>
				{#each groups as g (g.category)}
					<li><a href="#topic-{g.category}">{CATEGORY_TITLES[g.category]}</a></li>
				{/each}
			</ul>
		</nav>
		{#each groups as g (g.category)}
			<section aria-labelledby="topic-{g.category}">
				<h2 id="topic-{g.category}">{CATEGORY_TITLES[g.category]}</h2>
				{#each g.entries as e (e.id)}
					{@render entryCard(e)}
				{/each}
			</section>
		{/each}
	{/if}
</main>

<style>
	.help {
		max-width: 60rem;
	}
	.head {
		margin-bottom: 1rem;
	}
	.search {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}
	.search input {
		flex: 1 1 18rem;
		max-width: 32rem;
		padding: 0.5rem 0.65rem;
	}
	.count {
		margin: 0;
		min-height: 1.2em;
	}
	.toc ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0 0 1.25rem;
		padding: 0;
		list-style: none;
	}
	section > h2 {
		margin: 1.5rem 0 0.75rem;
		scroll-margin-top: 60px;
	}
	.entry {
		scroll-margin-top: 60px;
	}
	.entry:target,
	.entry:focus {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.entry h3 {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		font-size: 1rem;
	}
	.anchor {
		color: var(--text-muted);
		font-weight: 400;
		text-decoration: none;
	}
	.anchor:hover,
	.anchor:focus-visible {
		color: var(--accent);
	}
	.short {
		font-weight: 500;
	}
	.long {
		color: var(--text-2);
		white-space: pre-line;
	}
	.meta {
		display: grid;
		gap: 0.2rem;
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
	}
	.meta div {
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.5rem;
	}
	.meta dt {
		color: var(--text-muted);
	}
	.meta dd {
		margin: 0;
	}
	@media (max-width: 480px) {
		.meta div {
			grid-template-columns: 1fr;
			gap: 0;
		}
	}
</style>
