<script lang="ts">
	// The report's disclaimer (WP-3.13, Step 2 decision D10). A wording the
	// engine marks draft says so where it is shown. `{site}` becomes this
	// site's address, so the Terms URL prints in full.
	import { base } from '$app/paths';
	import { DISCLAIMER, DISCLAIMER_DRAFT_NOTE, withSite } from '@water-management/engine';

	const site = `${location.origin}${base}`;
</script>

<div class="disclaimer" data-disclaimer-version={DISCLAIMER.version}>
	{#if DISCLAIMER.status === 'draft'}<p class="draft"><strong>{DISCLAIMER_DRAFT_NOTE}</strong></p>{/if}
	{#each DISCLAIMER.paragraphs as p, i (i)}<p>{withSite(p, site)}</p>{/each}
	<p class="muted small">Disclaimer version {DISCLAIMER.version}.</p>
</div>

<style>
	.disclaimer p {
		max-width: 72ch;
		line-height: 1.5;
	}
	.draft {
		border-left: 3px solid var(--warning, currentColor);
		padding-left: 0.6rem;
	}
</style>
