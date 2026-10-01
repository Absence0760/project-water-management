<!-- i18n-section: share.summary -->
<script lang="ts">
	// The /share page's "Print a summary for members" card (issue #118): the
	// period, and the button that opens the browser's print dialog, where
	// Save as PDF makes the file. What prints is MemberSummary.svelte.
	import type { SharedCatchmentView } from '$lib/api/types';
	import { t } from '$lib/i18n/locale.svelte';
	import { SUMMARY_WINDOWS, windowDates, windowName, type SummaryWindow } from './summary';

	let { cv, period = $bindable() }: { cv: SharedCatchmentView; period: SummaryWindow } = $props();
</script>

<section class="card" aria-labelledby="summary-h">
	<h2 id="summary-h">{t('Print a summary for members')}</h2>
	<div class="row">
		<label class="period">
			<span>{t('Period')}</span>
			<select bind:value={period} aria-describedby="summary-dates summary-hint">
				{#each SUMMARY_WINDOWS as w (w)}
					<option value={w}>{windowName(w)}</option>
				{/each}
			</select>
		</label>
		<button type="button" class="btn" onclick={() => window.print()}>{t('Print or save as PDF')}</button>
	</div>
	<p class="fine" id="summary-dates">{windowDates(cv, period)}</p>
	<p class="fine" id="summary-hint">{t('One or two pages of this result over the period you choose, to print or save as a PDF and send to members. The link itself isn’t printed.')}</p>
</section>

<style>
	/* One row on a laptop, the button under the period on a phone: it sits under the reserve, so the laptop layout still fits 1440 × 960 (docs/ui.md § Share page). */
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 8px 12px;
	}
	.period {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1 1 16rem;
		min-width: 0;
		font-weight: 600;
	}
	select {
		width: 100%;
		min-height: var(--tap);
		font-weight: 400;
	}
	.btn {
		min-height: var(--tap);
	}
</style>
