<script lang="ts">
	// One guide from $lib/help/guides: sections of text, steps, notes,
	// formulas and diagrams, with links into the glossary (/help/glossary#<id>) and to
	// other guides. Guide text is plain strings with a small markup that
	// inline() parses, so nothing here is {@html}.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import Diagram from '$lib/components/help/Diagram.svelte';
	import HelpCrumbs from '$lib/components/help/HelpCrumbs.svelte';
	import PictureTour from '$lib/components/help/PictureTour.svelte';
	import RichText from '$lib/components/help/RichText.svelte';
	import { holdAnchor } from '$lib/help/anchor';
	import { helpFor } from '$lib/help/content';
	import { GUIDE_KIND_TITLES, GUIDES, TAB_TITLES, guideFor, sectionId } from '$lib/help/guides';
	import { currentSection } from '$lib/help/spy';

	const guide = $derived(guideFor(page.params.id ?? ''));
	const index = $derived(guide ? GUIDES.indexOf(guide) : -1);
	const prev = $derived(index > 0 ? GUIDES[index - 1] : undefined);
	const next = $derived(index >= 0 && index < GUIDES.length - 1 ? GUIDES[index + 1] : undefined);
	const terms = $derived((guide?.terms ?? []).map((id) => helpFor(id)).filter((e) => e !== undefined));
	const related = $derived((guide?.related ?? []).map((id) => guideFor(id)).filter((g) => g !== undefined));
	const sectionIds = $derived(guide ? guide.sections.map((s) => sectionId(s.heading)) : []);

	// A link to one section (#<section>, copied from "On this page"): the SPA
	// renders after navigation, so land it once the guide exists and hold it
	// while the pictures and fonts settle (lib/help/anchor.ts), focusing its
	// heading, as the glossary does for a term.
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id || !sectionIds.includes(id)) return;
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

	// "On this page" marks the section being read (aria-current), like the
	// glossary's contents: the last heading that has passed a line a little
	// below the top of the window (under the phone bar), or the last section at
	// the end of the page. Nothing while the intro is still in view.
	let reading = $state('');
	$effect(() => {
		const ids = sectionIds;
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
			const i = currentSection(tops, header + 64, atEnd);
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
</script>

<svelte:head><title>{guide ? `${guide.title} · Help` : 'Guide not found'} · Water Management</title></svelte:head>

<article class="guide-page">
	<HelpCrumbs
		trail={guide
			? [{ label: 'Help', href: `${base}/help` }, { label: GUIDE_KIND_TITLES[guide.kind] }, { label: guide.title }]
			: [{ label: 'Help', href: `${base}/help` }]}
	/>

	{#if !guide}
		<h1 class="title">Guide not found</h1>
		<p>There is no guide called “{page.params.id}”. <a href="{base}/help">See all guides and the glossary</a>.</p>
	{:else}
		<header class="head">
			<h1 class="title">{guide.title}</h1>
			<p class="lede">{guide.summary}</p>
			{#if guide.tab}
				<p class="muted where">In a project: the <strong>{TAB_TITLES[guide.tab]}</strong> tab.</p>
			{/if}
		</header>

		{#if guide.sections.length > 1}
			<nav class="onpage" aria-label="On this page">
				<p class="muted">On this page</p>
				<ul>
					{#each guide.sections as s (s.heading)}
						{@const id = sectionId(s.heading)}
						<li><a href="#{id}" aria-current={reading === id ? 'location' : undefined}>{s.heading}</a></li>
					{/each}
				</ul>
			</nav>
		{/if}

		{#each guide.sections as s (s.heading)}
			<section aria-labelledby={sectionId(s.heading)}>
				<h2 id={sectionId(s.heading)} tabindex="-1">{s.heading}</h2>
				{#each s.blocks as b, i (i)}
					{#if b.type === 'p'}
						<p><RichText text={b.text} /></p>
					{:else if b.type === 'steps'}
						<ol class="steps">
							{#each b.items as item, j (j)}<li><RichText text={item} /></li>{/each}
						</ol>
					{:else if b.type === 'list'}
						<ul class="list">
							{#each b.items as item, j (j)}<li><RichText text={item} /></li>{/each}
						</ul>
					{:else if b.type === 'note'}
						<aside class="note {b.tone}" aria-label={b.tone === 'tip' ? 'Tip' : 'Caution'}>
							<strong class="tag">{b.tone === 'tip' ? 'Tip' : 'Caution'}</strong>
							<p><RichText text={b.text} /></p>
						</aside>
					{:else if b.type === 'formula'}
						<p class="formula mono">{b.text}</p>
					{:else if b.type === 'diagram'}
						<Diagram id={b.id} caption={b.caption} />
					{:else if b.type === 'picture'}
						<figure class="picture">
							<figcaption>{b.caption}</figcaption>
							<PictureTour shot={b.shot} stops={b.stops} sizes="(min-width: 64rem) 46rem, 100vw" />
						</figure>
					{/if}
				{/each}
			</section>
		{/each}

		{#if terms.length}
			<section aria-labelledby="terms-h" class="terms">
				<h2 id="terms-h">Terms in this guide</h2>
				<dl>
					{#each terms as e (e.id)}
						<div>
							<dt><a href="{base}/help/glossary#{e.id}">{e.term}</a></dt>
							<dd class="muted">{e.short}</dd>
						</div>
					{/each}
				</dl>
			</section>
		{/if}

		{#if related.length}
			<section aria-labelledby="related-h">
				<h2 id="related-h">Related guides</h2>
				<ul class="related">
					{#each related as g (g.id)}
						<li>
							<a href="{base}/help/guides/{g.id}">{g.title}</a>
							<p class="muted">{g.summary}</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<nav class="pager" aria-label="Previous and next guide">
			{#if prev}<a href="{base}/help/guides/{prev.id}" rel="prev"><span class="muted">Previous</span> {prev.title}</a>{:else}<span></span>{/if}
			{#if next}<a href="{base}/help/guides/{next.id}" rel="next" class="next"><span class="muted">Next</span> {next.title}</a>{/if}
		</nav>
	{/if}
</article>

<style>
	.guide-page {
		max-width: 46rem;
	}
	/* With room beside the text (the Help column's own width), "On this page"
	   becomes a rail on the right that stays in view while reading, instead of
	   a box in the text; the article keeps its reading width. */
	@container help-main (min-width: 56rem) {
		.guide-page {
			display: grid;
			grid-template-columns: minmax(0, 42rem) 12rem;
			column-gap: 2rem;
			max-width: none;
			align-items: start;
		}
		.guide-page > :global(*) {
			grid-column: 1;
		}
		.guide-page > .onpage {
			grid-column: 2;
			grid-row: 1 / span 999;
			position: sticky;
			top: 1.25rem;
			margin: 0;
		}
		/* In the narrow rail a wrapped heading reads better as a plain block link than a bullet. */
		.guide-page > .onpage ul {
			list-style: none;
			padding-left: 0;
		}
		.guide-page > .onpage li a {
			display: block;
			padding: 0.2rem 0;
			line-height: 1.35;
		}
	}
	/* Every help page's title has this size (the overview, the glossary, search). */
	.title {
		margin: 0 0 0.4rem;
		font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem);
	}
	.lede {
		margin: 0;
		font-size: 1.05rem;
		color: var(--text-2);
	}
	.where {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
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
	.onpage ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	.onpage li a {
		display: inline-block;
		min-height: 24px;
		padding: 0.1rem 0;
	}
	/* The section being read: in words' weight as well as colour. */
	.onpage a[aria-current] {
		color: var(--text);
		font-weight: 600;
	}
	section > h2 {
		margin: 1.75rem 0 0.6rem;
		scroll-margin-top: calc(var(--header-h) + 1rem);
	}
	p,
	li {
		line-height: 1.55;
	}
	.steps,
	.list {
		padding-left: 1.4rem;
	}
	.steps li,
	.list li {
		margin: 0.35rem 0;
	}
	.steps li::marker {
		color: var(--accent);
		font-weight: 600;
	}
	.note {
		margin: 1rem 0;
		padding: 0.65rem 0.85rem;
		border-left: 3px solid var(--accent);
		border-radius: 0 var(--radius) var(--radius) 0;
		background: var(--accent-soft);
	}
	.note.caution {
		border-left-color: var(--warning);
		background: var(--warning-soft);
	}
	.note .tag {
		display: block;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.note p {
		margin: 0.2rem 0 0;
	}
	.picture {
		margin: 1rem 0 1.5rem;
	}
	.picture figcaption {
		margin-bottom: 0.6rem;
		color: var(--text-2);
		font-size: 0.875rem;
	}
	.formula {
		margin: 0.75rem 0;
		padding: 0.6rem 0.8rem;
		overflow-x: auto;
		background: var(--surface-sunken);
		border-radius: var(--radius);
		font-size: 0.875rem;
		white-space: pre-wrap;
	}
	.terms dl {
		display: grid;
		gap: 0.4rem;
		margin: 0;
	}
	.terms dl div {
		display: grid;
		grid-template-columns: 14rem 1fr;
		gap: 0.75rem;
	}
	.terms dd {
		margin: 0;
		font-size: 0.9rem;
	}
	.related {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.related li {
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--border);
	}
	.related a {
		font-weight: 600;
	}
	.related p {
		margin: 0.35rem 0 0;
		font-size: 0.9rem;
	}
	.pager {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 2rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	.pager a {
		display: grid;
		max-width: 48%;
	}
	.pager .next {
		text-align: right;
	}
	@media (max-width: 480px) {
		.terms dl div {
			grid-template-columns: 1fr;
			gap: 0;
		}
	}
</style>
