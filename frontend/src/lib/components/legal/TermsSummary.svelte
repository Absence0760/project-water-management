<script lang="ts">
	// The main points of the terms of use, in a bordered box (termsSummary.ts),
	// in the reader's language: above the sign-up button and on the
	// re-acceptance notice. The Terms themselves stay English, which the last
	// line says whenever the page is in another language.
	import { i18n, t } from '$lib/i18n/locale.svelte';
	import { SUMMARY_LANGUAGE_NOTE, SUMMARY_POINTS, SUMMARY_TITLE } from './termsSummary';

	let { id = 'terms-summary' }: { id?: string } = $props();
</script>

<section class="summary" aria-labelledby="{id}-h">
	<h2 id="{id}-h">{t(SUMMARY_TITLE)}</h2>
	<ul>
		{#each SUMMARY_POINTS as point (point)}<li>{t(point)}</li>{/each}
	</ul>
	{#if i18n.locale !== 'en'}<p class="lang">{t(SUMMARY_LANGUAGE_NOTE)}</p>{/if}
</section>

<style>
	.summary {
		margin: 0 0 0.75rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 1rem;
		color: var(--text);
	}
	h2 {
		margin: 0 0 0.35rem;
		font-size: 1rem;
		font-weight: 600;
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	li + li {
		margin-top: 0.3rem;
	}
	.lang {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
		color: var(--text-2);
	}
</style>
