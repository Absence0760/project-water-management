<script lang="ts">
	// One guide from $lib/help/guides: sections of text, steps, notes,
	// formulas and diagrams, with links into the glossary (/help#<id>) and to
	// other guides. Guide text is plain strings with a small markup that
	// inline() parses, so nothing here is {@html}.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import Diagram from '$lib/components/help/Diagram.svelte';
	import { helpFor } from '$lib/help/content';
	import { GUIDE_KIND_TITLES, GUIDES, TAB_TITLES, guideFor, inline, sectionId } from '$lib/help/guides';

	const guide = $derived(guideFor(page.params.id ?? ''));
	const index = $derived(guide ? GUIDES.indexOf(guide) : -1);
	const prev = $derived(index > 0 ? GUIDES[index - 1] : undefined);
	const next = $derived(index >= 0 && index < GUIDES.length - 1 ? GUIDES[index + 1] : undefined);
	const terms = $derived((guide?.terms ?? []).map((id) => helpFor(id)).filter((e) => e !== undefined));
	const related = $derived((guide?.related ?? []).map((id) => guideFor(id)).filter((g) => g !== undefined));
</script>

<svelte:head><title>{guide ? `${guide.title} · Help` : 'Guide not found'} · Water Management</title></svelte:head>

{#snippet rich(text: string)}
	{#each inline(text) as part, i (i)}
		{#if part.kind === 'strong'}<strong>{part.text}</strong>
		{:else if part.kind === 'term'}<a href="{base}/help#{part.id}">{part.text}</a>
		{:else if part.kind === 'guide'}<a href="{base}/help/guides/{part.id}">{part.text}</a>
		{:else}{part.text}{/if}
	{/each}
{/snippet}

<main class="page guide-page">
	<nav aria-label="Breadcrumb" class="crumbs">
		<ol>
			<li><a href="{base}/help">Help</a></li>
			<li><a href="{base}/help#guides-h">Guides</a></li>
			{#if guide}<li aria-current="page">{guide.title}</li>{/if}
		</ol>
	</nav>

	{#if !guide}
		<h1>Guide not found</h1>
		<p>There is no guide called “{page.params.id}”. <a href="{base}/help">See all guides and the glossary</a>.</p>
	{:else}
		<header class="head">
			<p class="kind">{GUIDE_KIND_TITLES[guide.kind]}</p>
			<h1>{guide.title}</h1>
			<p class="lede">{guide.summary}</p>
			{#if guide.tab}
				<p class="muted where">In a project: the <strong>{TAB_TITLES[guide.tab]}</strong> tab.</p>
			{/if}
		</header>

		{#if guide.sections.length > 1}
			<nav class="panel onpage" aria-label="On this page">
				<p class="muted">On this page</p>
				<ul>
					{#each guide.sections as s (s.heading)}
						<li><a href="#{sectionId(s.heading)}">{s.heading}</a></li>
					{/each}
				</ul>
			</nav>
		{/if}

		{#each guide.sections as s (s.heading)}
			<section aria-labelledby={sectionId(s.heading)}>
				<h2 id={sectionId(s.heading)}>{s.heading}</h2>
				{#each s.blocks as b, i (i)}
					{#if b.type === 'p'}
						<p>{@render rich(b.text)}</p>
					{:else if b.type === 'steps'}
						<ol class="steps">
							{#each b.items as item, j (j)}<li>{@render rich(item)}</li>{/each}
						</ol>
					{:else if b.type === 'list'}
						<ul class="list">
							{#each b.items as item, j (j)}<li>{@render rich(item)}</li>{/each}
						</ul>
					{:else if b.type === 'note'}
						<aside class="note {b.tone}" aria-label={b.tone === 'tip' ? 'Tip' : 'Caution'}>
							<strong class="tag">{b.tone === 'tip' ? 'Tip' : 'Caution'}</strong>
							<p>{@render rich(b.text)}</p>
						</aside>
					{:else if b.type === 'formula'}
						<p class="formula mono">{b.text}</p>
					{:else if b.type === 'diagram'}
						<Diagram id={b.id} caption={b.caption} />
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
							<dt><a href="{base}/help#{e.id}">{e.term}</a></dt>
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
						<li class="panel">
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
</main>

<style>
	.guide-page {
		max-width: 52rem;
	}
	.crumbs ol {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin: 0 0 1rem;
		padding: 0;
		list-style: none;
		font-size: 0.875rem;
	}
	.crumbs li:not(:last-child)::after {
		content: '›';
		margin-left: 0.35rem;
		color: var(--text-muted);
	}
	.crumbs [aria-current='page'] {
		color: var(--text-muted);
	}
	.kind {
		margin: 0;
		color: var(--accent);
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.head h1 {
		margin: 0.2rem 0 0.4rem;
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
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.related li {
		margin: 0;
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
