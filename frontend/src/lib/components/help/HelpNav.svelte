<script lang="ts">
	// The help contents, on every /help page: the landing page, each guide by
	// group, and the glossary with its topics (the search box heads the page,
	// routes/help/+layout.svelte). On the glossary page
	// it marks the topic and term being read (aria-current) and lists that
	// topic's terms.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { CATEGORY_TITLES, HELP, type HelpCategory } from '$lib/help/content';
	import { GUIDE_KIND_TITLES, GUIDES, type GuideKind } from '$lib/help/guides';
	import { glossaryPosition } from '$lib/help/nav.svelte';

	let navEl: HTMLElement | undefined = $state();

	const path = $derived(page.url.pathname.slice(base.length).replace(/\/$/, '') || '/');
	const onGlossary = $derived(path === '/help/glossary');
	const here = (href: string) => (path === href ? 'page' : undefined);

	const kinds: GuideKind[] = ['start', 'concept', 'howto'];
	const topics = (Object.keys(CATEGORY_TITLES) as HelpCategory[])
		.map((category) => ({ category, entries: HELP.filter((e) => e.category === category) }))
		.filter((t) => t.entries.length);

	// Keep the current link in view inside the sidebar (it scrolls on its own
	// when the list is taller than the screen), without moving the page.
	$effect(() => {
		void glossaryPosition.topic;
		void glossaryPosition.entry;
		void path;
		const box = navEl?.parentElement; // the sidebar's scrolling box (help layout)
		// The deepest marked link: the term, else its topic, else the page.
		const link =
			navEl?.querySelector<HTMLElement>('.terms [aria-current]') ??
			navEl?.querySelector<HTMLElement>('.topics [aria-current]') ??
			navEl?.querySelector<HTMLElement>('[aria-current]');
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
	{#each kinds as kind (kind)}
		<p class="group">{GUIDE_KIND_TITLES[kind]}</p>
		<ul>
			{#each GUIDES.filter((g) => g.kind === kind) as g (g.id)}
				<li><a href="{base}/help/guides/{g.id}" aria-current={here(`/help/guides/${g.id}`)}>{g.title}</a></li>
			{/each}
		</ul>
	{/each}
	<p class="group">Reference</p>
	<ul>
		<li>
			<a href="{base}/help/glossary" aria-current={here('/help/glossary')}>Glossary</a>
			{#if onGlossary}
				<ul class="topics">
					{#each topics as t (t.category)}
						{@const current = glossaryPosition.topic === t.category}
						<li>
							<a href="#topic-{t.category}" aria-current={current ? 'location' : undefined}>{CATEGORY_TITLES[t.category]}</a>
							{#if current}
								<ul class="terms">
									{#each t.entries as e (e.id)}
										<li>
											<a href="#{e.id}" aria-current={glossaryPosition.entry === e.id ? 'location' : undefined}>{e.term}</a>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</li>
	</ul>
</nav>

<style>
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.group {
		margin: 1.1rem 0 0.3rem;
		padding-left: 0.6rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
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
	.topics {
		margin: 0.15rem 0 0.25rem 0.75rem;
	}
	.topics a {
		font-size: 0.85rem;
	}
	.terms {
		margin: 0.1rem 0 0.35rem 0.75rem;
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	.terms a {
		min-height: 24px;
		padding: 0.1rem 0.6rem;
		font-size: 0.8rem;
	}
	.terms a[aria-current] {
		background: transparent;
	}
</style>
