<script lang="ts">
	// The help contents, on every /help page: the landing page, each guide by
	// group, and the glossary's topics (the search box heads the page,
	// routes/help/+layout.svelte). Each group's name is a heading (not a link),
	// its pages indented under a thin rule, so each group reads as a block
	// (issue #162). One group shows its pages at a time: the heading is a
	// disclosure button, and the group holding the page you're on opens by
	// itself. All four open were ~1180 px tall, so the sticky column scrolled
	// on its own at 1440×960 and 1280×800; one open fits both (help.spec.ts).
	// The glossary is one page per topic; its terms are found by search, not
	// listed here.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_TITLES, HELP, type HelpCategory } from '$lib/help/content';
	import { topicPath } from '$lib/help/glossaryLinks';
	import { GUIDE_KIND_TITLES, GUIDES, type GuideKind } from '$lib/help/guides';

	let navEl: HTMLElement | undefined = $state();

	const path = $derived(page.url.pathname.slice(base.length).replace(/\/$/, '') || '/');
	const here = (href: string) => (path === href ? 'page' : undefined);

	const kinds: GuideKind[] = ['start', 'concept', 'howto', 'use', 'page'];
	const topics = (Object.keys(CATEGORY_TITLES) as HelpCategory[]).filter((c) => HELP.some((e) => e.category === c));

	type Group = { id: string; title: string; links: { href: string; label: string }[] };
	const groups: Group[] = [
		...kinds.map((kind) => ({
			id: kind,
			title: GUIDE_KIND_TITLES[kind],
			links: GUIDES.filter((g) => g.kind === kind).map((g) => ({ href: `/help/guides/${g.id}`, label: g.title }))
		})),
		{
			id: 'reference',
			title: 'Reference',
			links: [
				{ href: '/help/glossary', label: 'Glossary' },
				...topics.map((c) => ({ href: topicPath(c), label: CATEGORY_TITLES[c] })),
				// Every upload and paste box's Expected format (issue #477).
				{ href: '/help/formats', label: 'File formats' }
			]
		}
	];

	// The open group: the one holding the page you're on, followed as you move
	// between pages; on a page outside every group (the overview, search) the
	// last one opened stays open. Opening a group closes the others.
	let open = $state('');
	$effect(() => {
		const holder = groups.find((g) => g.links.some((l) => l.href === path));
		if (holder) open = holder.id;
	});
	const toggle = (id: string) => (open = open === id ? '' : id);

	// Keep the current link in view inside the column when it scrolls on its
	// own (a window shorter than the overview plus the longest group, ~640 px),
	// without moving the page.
	$effect(() => {
		void path;
		void open;
		const box = navEl?.parentElement; // the sidebar's scrolling box (help layout)
		const link = navEl?.querySelector<HTMLElement>('[aria-current]');
		if (!box || !link || box.scrollHeight <= box.clientHeight) return;
		const top = link.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
		if (top < box.scrollTop) box.scrollTop = top - 8;
		else if (top + link.offsetHeight > box.scrollTop + box.clientHeight)
			box.scrollTop = top + link.offsetHeight - box.clientHeight + 8;
	});
</script>


<nav class="help-nav" aria-label="Help" bind:this={navEl}>
	<ul class="top">
		<li><a href="{base}/help" aria-current={here('/help')}>Overview</a></li>
	</ul>
	{#each groups as g (g.id)}
		<h2 class="group">
			<button
				type="button"
				id="help-nav-{g.id}"
				aria-expanded={open === g.id}
				aria-controls="help-nav-{g.id}-links"
				onclick={() => toggle(g.id)}
				>{g.title}</button
			>
		</h2>
		<ul class="links" id="help-nav-{g.id}-links" aria-labelledby="help-nav-{g.id}" hidden={open !== g.id}>
			{#each g.links as l (l.href)}
				<li><a href="{base}{l.href}" aria-current={here(l.href)}>{l.label}</a></li>
			{/each}
		</ul>
	{/each}
</nav>

<style>
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* A group's name is a heading, not an item: the text colour, bold, at the
	   links' outer edge, with a rule down the left of its links below. It is
	   also the group's disclosure button, with a chevron turned down while
	   open. */
	.group {
		margin: 0.75rem 0 0.2rem;
	}
	.group button {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		min-height: 28px;
		padding: 0.2rem 0.6rem 0.2rem 0;
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-align: left;
		text-transform: uppercase;
		cursor: pointer;
	}
	.group button::before {
		content: '';
		flex: none;
		width: 0.4rem;
		height: 0.4rem;
		margin: 0 0.15rem 0 0.1rem;
		border-right: 1.5px solid currentColor;
		border-bottom: 1.5px solid currentColor;
		transform: rotate(-45deg);
	}
	.group button[aria-expanded='true']::before {
		transform: rotate(45deg) translate(-1px, -1px);
	}
	.group button:hover {
		background: var(--surface-2);
	}
	.links[hidden] {
		display: none;
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
