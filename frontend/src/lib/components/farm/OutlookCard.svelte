<!-- i18n-section: farm.outlook -->
<script lang="ts">
	// "This season" (issue #53 R5, E3): only while the WUA has a seasonal
	// outlook published (the page checks outlookCard() first). Marked apart
	// from the cards about what happened, like the forecast: an edge and
	// "Season outlook" in words.
	import { t } from '$lib/i18n/locale.svelte';
	import type { OutlookVm } from './outlookCard';

	let { vm }: { vm: OutlookVm } = $props();
</script>

<section class="card outlook" aria-labelledby="outlook-h" data-testid="farm-outlook">
	<p class="kicker">{t('Season outlook')}</p>
	<h2 id="outlook-h">{vm.title}</h2>
	<p><strong>{vm.level}</strong></p>
	<p>{vm.got}</p>
	{#if vm.dam}<p>{vm.dam}</p>{/if}
	{#if vm.review}<p>{vm.review}</p>{/if}
	<p class="fine">{vm.fine}</p>
</section>

<style>
	.outlook {
		border-left: 4px dotted var(--brand-outlet, currentColor);
	}
	.kicker {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>
