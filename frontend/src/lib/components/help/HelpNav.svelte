<script lang="ts">
	// The help contents, on every /help page: the landing page, each guide by
	// group, and the glossary's topics (the search box heads the page,
	// routes/help/+layout.svelte). Every group is static: its name a heading
	// (not a link), its pages indented under a thin rule, so each group reads
	// as a block (issue #162). The glossary is one page per topic; its terms
	// are found by search, not listed here.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_TITLES, HELP, type HelpCategory } from '$lib/help/content';
	import { topicPath } from '$lib/help/glossaryLinks';
	import { GUIDE_KIND_TITLES, GUIDES, type GuideKind } from '$lib/help/guides';

	let navEl: HTMLElement | undefined = $state();

	const path = $derived(page.url.pathname.slice(base.length).replace(/\/$/, '') || '/');
	const here = (href: string) => (path === href ? 'page' : undefined);

	const kinds: GuideKind[] = ['start', 'concept', 'howto'];
	const topics = (Object.keys(CATEGORY_TITLES) as HelpCategory[]).filter((c) => HELP.some((e) => e.category === c));

	// Keep the current link in view inside the sidebar (it scrolls on its own
	// when the list is taller than the screen), without moving the page.
	$effect(() => {
		void path;
		const box = navEl?.parentElement; // the sidebar's scrolling box (help layout)
		const link = navEl?.querySelector<HTMLElement>('[aria-current]');
		if (!box || !link || box.scrollHeight <= box.clientHeight) return;
		const top = link.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
		if (top < box.scrollTop) box.scrollTop = top - 8;
		else if (top + link.offsetHeight > box.scrollTop + box.clientHeight)
			box.scrollTop = top + link.offsetHeight - box.clientHeight + 8;
	});
</script>

{#snippet group(id: string, title: string, links: { href: string; label: string }[])}
	<h2 class="group" id="help-nav-{id}">{title}</h2>
	<ul class="links" aria-labelledby="help-nav-{id}">
		{#each links as l (l.href)}
			<li><a href="{base}{l.href}" aria-current={here(l.href)}>{l.label}</a></li>
		{/each}
	</ul>
{/snippet}

<nav class="help-nav" aria-label="Help" bind:this={navEl}>
	<ul class="top">
		<li><a href="{base}/help" aria-current={here('/help')}>Overview</a></li>
	</ul>
	{#each kinds as kind (kind)}
		{@render group(
			kind,
			GUIDE_KIND_TITLES[kind],
			GUIDES.filter((g) => g.kind === kind).map((g) => ({ href: `/help/guides/${g.id}`, label: g.title }))
		)}
	{/each}
	{@render group('reference', 'Reference', [
		{ href: '/help/glossary', label: 'Glossary' },
		...topics.map((c) => ({ href: topicPath(c), label: CATEGORY_TITLES[c] }))
	])}
</nav>

<style>
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* A group's name is a heading, not an item: the text colour, bold, at the
	   links' outer edge, with a rule down the left of its links below. */
	.group {
		margin: 1.25rem 0 0.35rem;
		color: var(--text);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.links {
		margin-left: 0.2rem;
		border-left: 1px solid var(--border);
	}
	a {
		display: flex;
		align-items: center;
		min-height: 28px;
		padding: 0.2rem 0.6rem;
		border-left: 2px solid transparent;
		border-radius: 0 var(--radius) var(--radius) 0;
		color: var(--text-2);
		font-size: 0.9rem;
		line-height: 1.3;
		text-decoration: none;
	}
	/* The current page's marker sits on the group's rule. */
	.links a {
		margin-left: -1px;
		padding-left: 0.75rem;
	}
	a:hover {
		color: var(--text);
		background: var(--surface-2);
	}
	a[aria-current] {
		border-left-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
	}
</style>
