<!--
	Settings → Rain gaps → Gap-filling product (settings.gapRain, engine ≥
	1.101.0, issue #604; docs/model.md §2.4b *Gap-filling product*): which
	product fills the catchment rain's blank days (CHIRPS, the default;
	ERA5-Land instead; or ERA5-Land only where CHIRPS has none), and IMERG Late
	for the recent days. A card of its own, first in the fold: it decides what
	the CHIRPS card below it corrects. Both controls at their defaults store
	null (rain.ts withGapRain), so a project that never chose runs as it did.
	The reasons go under the explain switch; what the choice does now stays.
-->
<script lang="ts">
	import type { GapRainSettings } from '@water-management/engine';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import { GAP_RAIN_OPTIONS, withGapRain } from './rain';

	let {
		value = $bindable(),
		readonly = false,
		station = false
	}: {
		value?: GapRainSettings | null;
		readonly?: boolean;
		/** The catchment runs on a rainfall station (settings.rainStations.catchment): its pairing fills its own gaps, so a run ignores this. */
		station?: boolean;
	} = $props();

	const uid = $props.id();
	const product = $derived(value?.product ?? 'chirps');
	const imergLate = $derived(value?.imergLate ?? false);
	const option = $derived(GAP_RAIN_OPTIONS.find((o) => o.value === product) ?? GAP_RAIN_OPTIONS[0]!);
</script>

<div class="sub-card gap-rain" data-testid="gap-rain-card">
	<h3 class="title">Gap-filling product</h3>
	<div class="field">
		<span class="lbl"><label for="{uid}-product">Fill blank catchment-rain days from</label><HelpTip key="settings.gapRain" /></span>
		<select
			id="{uid}-product"
			disabled={readonly}
			value={product}
			onchange={(e) => (value = withGapRain(e.currentTarget.value as GapRainSettings['product'], imergLate))}
			aria-describedby="{uid}-product-h"
		>
			{#each GAP_RAIN_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint explain" id="{uid}-product-h">{option.help}</span>
	</div>
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={imergLate} onchange={(e) => (value = withGapRain(product, e.currentTarget.checked))} aria-describedby="{uid}-imerg-h" />
		Fill the last few days from IMERG Late
	</label>
	<span class="hint explain" id="{uid}-imerg-h">
		IMERG Late arrives about 14 hours after the day, so it covers the days before CHIRPS’ first values appear, 2 to 7 days back. It fills only days after the
		last reading of the product above, never a gap inside the record, and each IMERG version is corrected on its own fit.
	</span>
	{#if product !== 'chirps' || imergLate}
		<!-- What the choice needs and where its rain shows: a state line, not an explanation, so it stays with the switch off. -->
		<p class="hint" data-testid="gap-rain-note">
			{#if station}A run ignores this and says so: the catchment runs on a rainfall station, whose pairing fills its own gaps.{:else}ERA5-Land and IMERG Late come
				from our copy of the rain data over the CHIRPS feed’s cells, on its next fetch; a CHIRPS series no feed writes has none, and a run says so. Data →
				<a href="?tab=series#data-gap-rain">Rain products side by side</a> draws them beside CHIRPS.{/if}
		</p>
	{/if}
	<FieldHistoryLine field="settings:gapRain" />
</div>

<style>
	.gap-rain {
		display: grid;
		gap: 0.5rem;
	}
	.title {
		font-size: 1rem;
		margin: 0;
	}
	.field {
		max-width: 75ch;
	}
	.field select {
		max-width: 360px;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 75ch;
		margin: 0;
	}
</style>
