<script lang="ts">
	// The report's disclaimer (WP-3.13, Step 2 decision D10). The wording is a
	// draft until the client's legal adviser agrees it, and says so where it
	// is shown (docs/followups.md § Blocking releases).
	import { DISCLAIMER, DISCLAIMER_DRAFT_NOTE } from '@water-management/engine';
</script>

<div class="disclaimer" data-disclaimer-version={DISCLAIMER.version}>
	{#if DISCLAIMER.status === 'draft'}<p class="draft"><strong>{DISCLAIMER_DRAFT_NOTE}</strong></p>{/if}
	{#each DISCLAIMER.paragraphs as p, i (i)}<p>{p}</p>{/each}
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
