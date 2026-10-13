<!-- i18n-section: farm.forecast -->
<script lang="ts">
	// "Next 14 days" (design §3 Q1, E2; WP-2.12): only when the published run is
	// a forecast run (the page checks forecastCard() first). Marked apart from
	// the cards about what happened: a dashed edge and "Forecast" in words.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/locale.svelte';
	import type { ForecastVm } from './forecastCard';
	import { wordsHref } from './load';

	let { vm }: { vm: ForecastVm } = $props();
</script>

<section class="card forecast" aria-labelledby="forecast-h" data-testid="farm-forecast">
	<p class="kicker">{t('Forecast')}</p>
	<h2 id="forecast-h">{vm.title}</h2>
	{#if vm.old}<p class="old" role="note">{vm.old}</p>{/if}
	{#if vm.dam}<p>{vm.dam}</p>{/if}
	<p>{vm.short}</p>
	<p class="fine">{vm.fine}</p>
	<a class="link" href={wordsHref(base, page.url, 'farm-forecast')}>{t('What is the forecast?')}</a>
</section>

<style>
	.forecast {
		border-left: 4px dashed var(--brand-outlet, currentColor);
	}
	.kicker {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.old {
		font-weight: 600;
	}
</style>
