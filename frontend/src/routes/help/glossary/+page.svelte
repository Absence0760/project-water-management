<script lang="ts">
	// The glossary: every entry in $lib/help/content, grouped by topic, with a
	// stable anchor per term (/help/glossary#<id>) that the HelpTips link to.
	// Its scroll spy tells the help sidebar which topic and term are on screen.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import HelpCrumbs from '$lib/components/help/HelpCrumbs.svelte';
	import { holdAnchor } from '$lib/help/anchor';
	import { CATEGORY_TITLES, HELP, countryNames, helpFor, type HelpCategory } from '$lib/help/content';
	import { glossaryPosition } from '$lib/help/nav.svelte';

	const groups = (Object.keys(CATEGORY_TITLES) as HelpCategory[])
		.map((category) => ({ category, entries: HELP.filter((e) => e.category === category) }))
		.filter((g) => g.entries.length);

	const paragraphs = (s: string) => s.split(/\n{2,}/);

	// The SPA renders after navigation, so the browser's own jump to #id has
	// nothing to land on yet: scroll (and move focus) once the list exists,
	// and hold the entry there while the page settles (lib/help/anchor.ts).
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id) return;
		let live = true;
		let release: (() => void) | undefined;
		tick().then(() => {
			const el = live ? document.getElementById(id) : null;
			if (!el) return;
			release = holdAnchor(el);
			if (el.tabIndex === -1) el.focus({ preventScroll: true });
		});
		return () => {
			live = false;
			release?.();
		};
	});

	// The current section is the last one whose top has passed just below the
	// sticky app header; at the very bottom, the last.
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
		if (topic !== glossaryPosition.topic) glossaryPosition.topic = topic;
		if (entry !== glossaryPosition.entry) glossaryPosition.entry = entry;
	}
	$effect(() => {
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
			glossaryPosition.topic = '';
			glossaryPosition.entry = '';
		};
	});
</script>

<svelte:head><title>Glossary · Help · Water Management</title></svelte:head>

<HelpCrumbs trail={[{ label: 'Help', href: `${base}/help` }, { label: 'Reference' }, { label: 'Glossary' }]} />
<header class="head">
	<h1>Glossary</h1>
	<p class="lede">
		Every input and result, in hydrologists’ terms. Concepts follow the WBT b023 workbook (its Help, Models and
		configuration sheets) and the project’s model reference (<span class="mono">docs/model.md</span>); the wording is
		ours. The <span aria-hidden="true">ⓘ</span> buttons next to fields show the short version and link here.
	</p>
</header>

{#each groups as g (g.category)}
	<section aria-labelledby="topic-{g.category}">
		<h2 id="topic-{g.category}" class="topic">{CATEGORY_TITLES[g.category]}</h2>
		{#each g.entries as e (e.id)}
			<article class="entry" id={e.id} tabindex="-1" aria-labelledby="{e.id}-t">
				<h3>
					<span id="{e.id}-t">{e.term}</span>
					<a class="anchor" href="#{e.id}" aria-label="Link to {e.term}">#</a>
				</h3>
				<p class="short">{e.short}</p>
				{#each paragraphs(e.long) as para, i (i)}
					<p class="long">{para}</p>
				{/each}
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
									{#if rel}<a href="{base}/help/glossary#{rel.id}">{rel.term}</a>{i < e.related.length - 1 ? ', ' : ''}{/if}
								{/each}
							</dd>
						</div>
					{/if}
					<div><dt>Source</dt><dd>{e.source}</dd></div>
				</dl>
			</article>
		{/each}
	</section>
{/each}

<style>
	.head {
		margin-bottom: 0.5rem;
	}
	/* The size of every help page's title (guides, search). */
	h1 {
		margin: 0 0 0.4rem;
		font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
	}
	.lede {
		max-width: 44rem;
		margin: 0;
		color: var(--text-2);
	}
	.topic {
		max-width: 46rem;
		margin: 2.25rem 0 0.25rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--border);
		font-size: 1.2rem;
		scroll-margin-top: calc(var(--header-h) + 1rem);
	}
	/* Entries are a list of definitions, not a stack of cards: a rule between
	   them, the term set as a heading. */
	.entry {
		max-width: 46rem;
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
	.entry h3 {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		margin: 0 0 0.3rem;
		font-size: 1.02rem;
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
