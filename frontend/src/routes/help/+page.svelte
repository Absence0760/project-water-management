<script lang="ts">
	// Help: the guides ($lib/help/guides, each on /help/guides/<id>) and the
	// glossary (every entry in $lib/help/content, grouped by topic, with a
	// stable anchor per term, /help#<id>, that the HelpTips link to). One
	// search box covers both.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_TITLES, HELP, helpFor, searchHelp, type HelpCategory, type HelpEntry } from '$lib/help/content';
	import { GUIDE_KIND_TITLES, GUIDES, searchGuides, type Guide, type GuideKind } from '$lib/help/guides';

	let query = $state('');
	const results = $derived(searchHelp(query));
	const guideResults = $derived(searchGuides(query));
	const guideGroups = (Object.keys(GUIDE_KIND_TITLES) as GuideKind[]).map((kind) => ({
		kind,
		guides: GUIDES.filter((g) => g.kind === kind)
	}));
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

	// Table of contents: on wide screens it stays beside the text as you
	// scroll, marks the topic and term you're reading (aria-current), and lists
	// that topic's terms. The current section is the last one whose top has
	// passed just below the sticky app header; at the very bottom, the last.
	let tocEl: HTMLElement | undefined = $state();
	let current = $state({ topic: '', entry: '' });
	function spy() {
		const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 56;
		const line = header + 24;
		const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
		let topic = '';
		let entry = '';
		for (const g of groups) {
			const h = document.getElementById(`topic-${g.category}`);
			if (!h) continue;
			if (atEnd || h.getBoundingClientRect().top <= line) {
				topic = g.category;
				entry = '';
				for (const e of g.entries) {
					const el = document.getElementById(e.id);
					if (el && (el.getBoundingClientRect().top <= line || atEnd)) entry = e.id;
				}
			}
		}
		if (!topic && groups.length) topic = groups[0]!.category;
		if (topic !== current.topic || entry !== current.entry) current = { topic, entry };
	}
	$effect(() => {
		if (searching) return;
		let frame = 0;
		const onScroll = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(spy);
		};
		tick().then(spy);
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
		};
	});
	// Keep the current link in view inside the sidebar (it scrolls on its own
	// when the list is taller than the screen), without moving the page.
	$effect(() => {
		void current;
		const link =
			tocEl?.querySelector<HTMLElement>('.terms [aria-current="location"]') ??
			tocEl?.querySelector<HTMLElement>('[aria-current="location"]');
		if (!tocEl || !link || tocEl.scrollHeight <= tocEl.clientHeight) return;
		const t = link.offsetTop - tocEl.offsetTop;
		if (t < tocEl.scrollTop) tocEl.scrollTop = t - 8;
		else if (t + link.offsetHeight > tocEl.scrollTop + tocEl.clientHeight) tocEl.scrollTop = t + link.offsetHeight - tocEl.clientHeight + 8;
	});
</script>

<svelte:head><title>Help and glossary · Water Management</title></svelte:head>

<main class="page help">
	<header class="head">
		<h1>Help and glossary</h1>
		<p class="muted">
			Guides to setting up, calibrating and reading a catchment model, and what each input and result means, in
			hydrologists’ terms. Concepts follow the WBT b023 workbook (its Help, Models and configuration sheets) and the
			project’s model reference (<span class="mono">docs/model.md</span>); the wording is ours. Look for the
			<span aria-hidden="true">ⓘ</span> buttons next to fields for the short version.
		</p>
		<div class="search">
			<label for="help-q" class="visually-hidden">Search guides and the glossary</label>
			<input id="help-q" type="search" placeholder="Search, e.g. calibrate, EWR, crop factor, NSE" bind:value={query} autocomplete="off" />
			<p class="muted count" role="status" aria-live="polite">
				{#if searching}{guideResults.length} {guideResults.length === 1 ? 'guide' : 'guides'},
					{results.length} {results.length === 1 ? 'term' : 'terms'}{/if}
			</p>
		</div>
	</header>

	{#snippet guideCard(g: Guide)}
		<li class="guide panel">
			<a href="{base}/help/guides/{g.id}">{g.title}</a>
			<p class="muted">{g.summary}</p>
		</li>
	{/snippet}

	{#snippet entryCard(e: HelpEntry)}
		<article class="entry panel" id={e.id} tabindex="-1" aria-labelledby="{e.id}-t">
			<h4>
				<span id="{e.id}-t">{e.term}</span>
				<a class="anchor" href="#{e.id}" aria-label="Link to {e.term}">#</a>
			</h4>
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
			{#if guideResults.length}
				<h2>Guides</h2>
				<ul class="guides">
					{#each guideResults as g (g.id)}{@render guideCard(g)}{/each}
				</ul>
			{/if}
			{#if results.length}
				<h2>Glossary</h2>
				{#each results as e (e.id)}
					{@render entryCard(e)}
				{/each}
			{/if}
			{#if !guideResults.length && !results.length}
				<p class="muted">Nothing matches “{query}”. Try a shorter word or an abbreviation (EWR, MAP, NSE).</p>
			{/if}
		</section>
	{:else}
		<section class="guides-all" aria-labelledby="guides-h">
			<h2 id="guides-h">Guides</h2>
			{#each guideGroups as grp (grp.kind)}
				<h3 class="kind">{GUIDE_KIND_TITLES[grp.kind]}</h3>
				<ul class="guides" class:start={grp.kind === 'start'}>
					{#each grp.guides as g (g.id)}{@render guideCard(g)}{/each}
				</ul>
			{/each}
		</section>

		<h2 id="glossary-h" class="glossary-h">Glossary</h2>
		<div class="layout">
			<nav class="toc" aria-label="Glossary topics" bind:this={tocEl}>
				<ul class="topics">
					{#each groups as g (g.category)}
						{@const here = current.topic === g.category}
						<li>
							<a href="#topic-{g.category}" aria-current={here ? 'location' : undefined}>{CATEGORY_TITLES[g.category]}</a>
							{#if here}
								<ul class="terms">
									{#each g.entries as e (e.id)}
										<li><a href="#{e.id}" aria-current={current.entry === e.id ? 'location' : undefined}>{e.term}</a></li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			</nav>
			<div class="content">
				{#each groups as g (g.category)}
					<section aria-labelledby="topic-{g.category}">
						<h3 id="topic-{g.category}" class="topic">{CATEGORY_TITLES[g.category]}</h3>
						{#each g.entries as e (e.id)}
							{@render entryCard(e)}
						{/each}
					</section>
				{/each}
			</div>
		</div>
	{/if}
</main>

<style>
	.help {
		max-width: 76rem;
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
	/* Phones and narrow windows: the topics wrap above the text. */
	.toc ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.toc .topics {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin-bottom: 1.25rem;
	}
	.toc .terms {
		display: none;
	}
	.toc a[aria-current='location'] {
		color: var(--text);
		font-weight: 600;
	}
	.content > section:first-child > .topic {
		margin-top: 0;
	}
	/* Wide screens: a sidebar that stays on screen, below the app header. */
	@media (min-width: 64rem) {
		.layout {
			display: grid;
			grid-template-columns: 15rem minmax(0, 1fr);
			gap: 2rem;
			align-items: start;
		}
		.toc {
			position: sticky;
			top: calc(var(--header-h) + 1rem);
			max-height: calc(100vh - var(--header-h) - 2rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			padding-right: 0.25rem;
		}
		.toc .topics {
			display: grid;
			gap: 0.15rem;
			margin-bottom: 0;
		}
		.toc a {
			display: block;
			padding: 0.3rem 0.6rem;
			border-left: 2px solid transparent;
			border-radius: 0 var(--radius) var(--radius) 0;
			color: var(--text-muted);
			text-decoration: none;
		}
		.toc a:hover {
			color: var(--text);
			background: var(--surface-2);
		}
		.toc a[aria-current='location'] {
			border-left-color: var(--accent);
			background: var(--accent-soft);
		}
		.toc .terms {
			display: grid;
			gap: 0.05rem;
			margin: 0.15rem 0 0.4rem 0.75rem;
			font-size: 0.85rem;
		}
		/* 24 px targets (WCAG 2.2 SC 2.5.8). */
		.terms a {
			display: flex;
			align-items: center;
			min-height: 24px;
			padding: 0.15rem 0.6rem;
		}
		.terms a[aria-current='location'] {
			background: transparent;
			font-weight: 600;
		}
	}
	.topic {
		margin: 1.5rem 0 0.75rem;
		font-size: 1.15rem;
		scroll-margin-top: 60px;
	}
	.glossary-h {
		margin: 2rem 0 1rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}
	.kind {
		margin: 1.25rem 0 0.5rem;
		font-size: 1rem;
		color: var(--text-2);
	}
	.guides {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
		margin: 0 0 1rem;
		padding: 0;
		list-style: none;
	}
	.guides.start {
		grid-template-columns: 1fr;
	}
	.guide {
		margin: 0;
	}
	.guide a {
		font-weight: 600;
	}
	.guide p {
		margin: 0.35rem 0 0;
		font-size: 0.9rem;
	}
	.guides.start .guide {
		border-left: 3px solid var(--accent);
	}
	.entry {
		scroll-margin-top: 60px;
	}
	.entry:target,
	.entry:focus {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.entry h4 {
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
