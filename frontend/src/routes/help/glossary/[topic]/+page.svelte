<script lang="ts">
	// One glossary topic (issue #162): its entries from $lib/help/content, each
	// with a stable anchor (/help/glossary/<topic>#<id>, lib/help/glossaryLinks)
	// that the HelpTips, guides and search link to. Beside the entries, an
	// "On this page" rail pinned to the right edge (as on a guide) lists the
	// topic's terms and marks the one being read.
	//
	// Each entry's `source` (a workbook sheet, a section of docs/model.md, an
	// issue) stays in the data for maintainers and is not shown: it points
	// readers at developer documents they can't open.
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import HelpCrumbs from '$lib/components/help/HelpCrumbs.svelte';
	import { hashId, holdAnchor } from '$lib/help/anchor';
	import { CATEGORY_TITLES, HELP, countryNames, helpFor } from '$lib/help/content';
	import { glossaryPath, topicForSlug } from '$lib/help/glossaryLinks';
	import { currentSection } from '$lib/help/spy';

	const category = $derived(topicForSlug(page.params.topic ?? ''));
	const entries = $derived(category ? HELP.filter((e) => e.category === category) : []);
	const title = $derived(category ? CATEGORY_TITLES[category] : 'Topic not found');

	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so the browser's own jump to #id has
	// nothing to land on yet: scroll (and move focus) once the entries exist,
	// and hold the entry there while the page settles (lib/help/anchor.ts).
	// An entry that lives under another topic (a moved term, a hand-typed
	// link) goes on to its own page.
	$effect(() => {
		const id = hashId(page.url.hash);
		if (!id) return;
		const here = entries.some((e) => e.id === id);
		if (!here) {
			const e = helpFor(id);
			if (e && e.id === id) goto(`${base}${glossaryPath(e)}`, { replaceState: true });
			return;
		}
		let live = true;
		let release: (() => void) | undefined;
		tick().then(() => {
			const el = live ? document.getElementById(id) : null;
			if (!el) return;
			release = holdAnchor(el);
			el.focus({ preventScroll: true });
		});
		return () => {
			live = false;
			release?.();
		};
	});

	// "On this page" marks the term being read, as a guide's rail marks its
	// section (lib/help/spy.ts): nothing while the intro shows.
	let reading = $state('');
	$effect(() => {
		const ids = entries.map((e) => e.id);
		if (ids.length < 2) {
			reading = '';
			return;
		}
		let frame = 0;
		const spy = () => {
			const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
			const doc = document.documentElement;
			const atEnd = window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
			const tops = ids.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? Infinity);
			const i = currentSection(tops, header + 64, atEnd, ids.indexOf(hashId(page.url.hash)), window.innerHeight);
			reading = i >= 0 ? ids[i]! : '';
		};
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

	// Keep the marked term in view inside the rail when the rail scrolls on
	// its own (a topic with more terms than the window holds), without
	// moving the page.
	let rail: HTMLElement | undefined = $state();
	$effect(() => {
		void reading;
		const link = rail?.querySelector<HTMLElement>('[aria-current]');
		if (!rail || !link || rail.scrollHeight <= rail.clientHeight) return;
		const top = link.offsetTop; // the sticky rail is the link's offset parent
		if (top < rail.scrollTop) rail.scrollTop = top - 8;
		else if (top + link.offsetHeight > rail.scrollTop + rail.clientHeight)
			rail.scrollTop = top + link.offsetHeight - rail.clientHeight + 8;
	});
</script>

<svelte:head><title>{category ? `${title} · Glossary` : 'Topic not found'} · Help · Water Management</title></svelte:head>

<div class="topic-page">
	<HelpCrumbs
		trail={category
			? [
					{ label: 'Help', href: `${base}/help` },
					{ label: 'Reference' },
					{ label: 'Glossary', href: `${base}/help/glossary` },
					{ label: title }
				]
			: [{ label: 'Help', href: `${base}/help` }]}
	/>

	{#if !category}
		<h1>Topic not found</h1>
		<p>There is no glossary topic called “{page.params.topic}”. <a href="{base}/help/glossary">See every topic</a>.</p>
	{:else}
		<header class="head">
			<h1>{title}</h1>
			<p class="lede">
				{entries.length}
				{entries.length === 1 ? 'term' : 'terms'} from the glossary. Search above to find a word in another topic.
			</p>
		</header>

		{#if entries.length > 1}
			<nav class="onpage" aria-label="On this page" bind:this={rail}>
				<p class="muted">On this page</p>
				<ul>
					{#each entries as e (e.id)}
						<li><a href="#{e.id}" aria-current={reading === e.id ? 'location' : undefined}>{e.term}</a></li>
					{/each}
				</ul>
			</nav>
		{/if}

		<div class="entries">
			{#each entries as e (e.id)}
				<article class="entry" id={e.id} tabindex="-1" aria-labelledby="{e.id}-t">
					<h2>
						<span id="{e.id}-t">{e.term}</span>
						<a class="anchor" href="#{e.id}" aria-label="Link to {e.term}">#</a>
					</h2>
					<p class="short">{e.short}</p>
					{#each paragraphs(e.long) as para, i (i)}
						<p class="long">{para}</p>
					{/each}
					{#if e.countries?.length || e.units || e.aliases?.length || e.related?.length}
						<dl class="meta">
							{#if e.countries?.length}<div><dt>Applies in</dt><dd>{countryNames(e.countries)}</dd></div>{/if}
							{#if e.units}<div><dt>Units</dt><dd>{e.units}</dd></div>{/if}
							{#if e.aliases?.length}<div><dt>Also called</dt><dd>{e.aliases.join(', ')}</dd></div>{/if}
							{#if e.related?.length}
								<div>
									<dt>See also</dt>
									<dd>
										{#each e.related as r, i (r)}
											{@const rel = helpFor(r)}
											{#if rel}<a href="{base}{glossaryPath(rel)}">{rel.term}</a>{i < e.related.length - 1 ? ', ' : ''}{/if}
										{/each}
									</dd>
								</div>
							{/if}
						</dl>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* Body text keeps a readable measure; the page itself spans the Help
	   column, with "On this page" pinned to its right edge (as a guide's). */
	.head,
	.entry > * {
		max-width: 46rem;
	}
	.head {
		margin-bottom: 0.5rem;
	}
	/* The size of every help page's title (guides, search). */
	h1 {
		margin: 0 0 0.4rem;
		font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
	}
	.lede {
		margin: 0;
		color: var(--text-2);
	}
	.onpage {
		margin: 1.25rem 0 0.5rem;
		padding: 0.6rem 0.9rem;
		border-left: 3px solid var(--border-strong);
		background: var(--surface-2);
		border-radius: 0 var(--radius) var(--radius) 0;
	}
	.onpage p {
		margin: 0 0 0.25rem;
		font-size: 0.85rem;
	}
	/* Under the intro (a narrow column), the terms run on as a wrapped line
	   rather than a list a screen tall; beside the text they are a list. */
	.onpage ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	.onpage li a {
		display: inline-block;
		min-height: 24px;
		padding: 0.1rem 0;
	}
	.onpage a[aria-current] {
		color: var(--text);
		font-weight: 600;
	}
	@container help-main (min-width: 56rem) {
		.topic-page {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 12rem;
			column-gap: 2.5rem;
			align-items: start;
		}
		.topic-page > :global(*) {
			grid-column: 1;
		}
		/* In view while reading; it scrolls on its own when the topic has more
		   terms than the window holds, and ends as far above the window's foot
		   as it sticks below its top. */
		.topic-page > .onpage {
			grid-column: 2;
			grid-row: 1 / span 999;
			position: sticky;
			top: 1.25rem;
			max-height: calc(100vh - 2.5rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			margin: 0;
		}
		.topic-page > .onpage ul {
			display: block;
		}
		.topic-page > .onpage li a {
			display: block;
			padding: 0.2rem 0;
			line-height: 1.35;
		}
	}
	/* Entries are a list of definitions, not a stack of cards: a rule between
	   them, the term set as a heading. */
	.entry {
		padding: 1rem 0 1.1rem;
		border-bottom: 1px solid var(--border);
		scroll-margin-top: calc(var(--header-h) + 1rem);
	}
	.entry:last-child {
		border-bottom: 0;
	}
	.entry:target,
	.entry:focus {
		outline: 2px solid var(--focus);
		outline-offset: 4px;
		border-radius: var(--radius-sm);
	}
	.entry h2 {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		margin: 0 0 0.3rem;
		font-size: 1.05rem;
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
		margin: 0 0 0.4rem;
		font-weight: 500;
	}
	.long {
		margin: 0 0 0.4rem;
		color: var(--text-2);
		line-height: 1.55;
		white-space: pre-line;
	}
	.meta {
		display: grid;
		gap: 0.15rem;
		margin: 0.6rem 0 0;
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
