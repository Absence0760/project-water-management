<script lang="ts">
	import { hashId } from '$lib/help/anchor';
	// The glossary's index: one page per topic (glossary/[topic], issue #162),
	// each listed here with its terms, so a reader can scan for a word; search
	// (the box at the head of every help page) is the other way to find one.
	// The glossary used to be this one page: an old /help/glossary#<term> link
	// goes on to the term's topic page.
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import HelpCrumbs from '$lib/components/help/HelpCrumbs.svelte';
	import { CATEGORY_TITLES, HELP, helpFor, type HelpCategory } from '$lib/help/content';
	import { glossaryPath, topicPath } from '$lib/help/glossaryLinks';

	const topics = (Object.keys(CATEGORY_TITLES) as HelpCategory[])
		.map((category) => ({ category, entries: HELP.filter((e) => e.category === category) }))
		.filter((t) => t.entries.length);

	$effect(() => {
		const e = helpFor(hashId(page.url.hash));
		if (e) goto(`${base}${glossaryPath(e)}`, { replaceState: true });
	});
</script>

<svelte:head><title>Glossary · Help · Water Management</title></svelte:head>

<HelpCrumbs trail={[{ label: 'Help', href: `${base}/help` }, { label: 'Reference' }, { label: 'Glossary' }]} />
<header class="head">
	<h1>Glossary</h1>
	<p class="lede">
		Every input and result, in hydrologists’ terms, one page per topic. The <span aria-hidden="true">ⓘ</span> buttons
		next to fields show the short version and link to the full entry. To find one word, search for it above.
	</p>
</header>

<ul class="topics">
	{#each topics as t (t.category)}
		<li>
			<h2 class="topic"><a href="{base}{topicPath(t.category)}">{CATEGORY_TITLES[t.category]}</a></h2>
			<p class="count">{t.entries.length} {t.entries.length === 1 ? 'term' : 'terms'}</p>
			<ul class="terms" aria-label="Terms in {CATEGORY_TITLES[t.category]}">
				{#each t.entries as e (e.id)}
					<li><a href="{base}{glossaryPath(e)}">{e.term}</a></li>
				{/each}
			</ul>
		</li>
	{/each}
</ul>

<style>
	.head {
		max-width: 46rem;
		margin-bottom: 1.25rem;
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
	/* The topics in columns across the text column (the overview's guide list),
	   each a block: its name, its count, its terms. */
	.topics {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 1.5rem 2.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.topic {
		margin: 0;
		font-size: 1.05rem;
	}
	.count {
		margin: 0.1rem 0 0.4rem;
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	.terms {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.9rem;
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	.terms a {
		display: inline-block;
		min-height: 24px;
		padding: 0.1rem 0;
	}
</style>
