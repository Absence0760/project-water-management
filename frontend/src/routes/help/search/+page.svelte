<script lang="ts">
	// Help search results for ?q=: guides first, then glossary terms. The
	// search box itself is in the help layout's sidebar.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { searchHelp } from '$lib/help/content';
	import { searchGuides } from '$lib/help/guides';

	const q = $derived(page.url.searchParams.get('q')?.trim() ?? '');
	const guides = $derived(searchGuides(q));
	const terms = $derived(q ? searchHelp(q) : []);
</script>

<svelte:head><title>{q ? `“${q}”` : 'Search'} · Help · Water Management</title></svelte:head>

<header>
	<h1>Search help</h1>
	<p class="muted" role="status" aria-live="polite">
		{#if !q}Type in the search box to find guides and glossary terms.
		{:else}{guides.length} {guides.length === 1 ? 'guide' : 'guides'} and {terms.length}
			{terms.length === 1 ? 'term' : 'terms'} match “{q}”.{/if}
	</p>
</header>

{#if q}
	{#if guides.length}
		<section aria-labelledby="res-guides">
			<h2 id="res-guides">Guides</h2>
			<ul class="results">
				{#each guides as g (g.id)}
					<li>
						<a href="{base}/help/guides/{g.id}">{g.title}</a>
						<p>{g.summary}</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	{#if terms.length}
		<section aria-labelledby="res-terms">
			<h2 id="res-terms">Glossary</h2>
			<ul class="results">
				{#each terms as e (e.id)}
					<li>
						<a href="{base}/help/glossary#{e.id}">{e.term}</a>
						<p>{e.short}</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	{#if !guides.length && !terms.length}
		<p>Nothing matches. Try a shorter word or an abbreviation (EWR, MAP, NSE).</p>
	{/if}
{/if}

<style>
	h1 {
		margin: 0 0 0.3rem;
	}
	h2 {
		margin: 1.75rem 0 0.25rem;
		font-size: 1.1rem;
	}
	.results {
		max-width: 46rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.results li {
		padding: 0.7rem 0;
		border-bottom: 1px solid var(--border);
	}
	.results a {
		font-weight: 600;
	}
	.results p {
		margin: 0.2rem 0 0;
		color: var(--text-2);
		font-size: 0.9rem;
	}
</style>
