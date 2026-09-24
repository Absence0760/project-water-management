<!--
	Settings for settings.zeroRainRuns (engine ≥ 0.15.0, CR-20, docs/model.md
	§2.4c): what a run does with the zero-rain runs the Data tab flags, plus
	keep-dry and missing periods. `error` is set while either list is invalid,
	so the parent form can block saving.
-->
<script lang="ts">
	import type { ZeroRainSettings } from '@water-management/engine';
	import PeriodList from '$lib/components/common/PeriodList.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { ZERO_RAIN_OPTIONS } from './rain';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false
	}: {
		value: ZeroRainSettings;
		error?: string | null;
		readonly?: boolean;
	} = $props();

	let keepDryError = $state<string | null>(null);
	let missingError = $state<string | null>(null);
	$effect(() => {
		error = keepDryError ?? missingError;
	});
	const option = $derived(ZERO_RAIN_OPTIONS.find((o) => o.value === value.mode));
</script>

<div class="zero-rain" data-testid="zero-rain-settings">
	<h3 class="sub">Zero-rain runs in the catchment rain</h3>
	<div class="field mode">
		<span class="lbl"><label for="st-zero-rain">Flagged zero runs</label><HelpTip key="settings.zeroRainRuns" /></span>
		<select id="st-zero-rain" disabled={readonly} bind:value={value.mode} aria-describedby="st-zero-rain-h">
			{#each ZERO_RAIN_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint" id="st-zero-rain-h">{option?.help}</span>
	</div>
	{#if value.mode === 'missing'}
		<PeriodList
			bind:list={value.keepDry}
			bind:error={keepDryError}
			{readonly}
			legend="Keep dry"
			helpKey="settings.zeroRainRuns"
			hint="Flagged zero runs you have confirmed as real dry spells. Days inside these periods stay 0 mm; other flagged runs are still filled."
			empty="None: every flagged zero run is treated as missing."
			addYearLabel="Keep a water year dry"
			addRangeLabel="Keep a date range dry"
			placeholder="e.g. confirmed drought, farm records agree"
			noun="keep-dry period"
		/>
	{/if}
	<PeriodList
		bind:list={value.missing}
		bind:error={missingError}
		{readonly}
		legend="Also treat as missing"
		helpKey="settings.zeroRainRuns"
		hint="Other periods whose catchment rain is bad, whatever it reads: for example the gap days inside a year the Data tab flags as far below CHIRPS. CHIRPS fills them, and they are left out of the CHIRPS factor fit."
		empty="None."
		addYearLabel="Add a water year"
		addRangeLabel="Add a date range"
		placeholder="e.g. logger fault; values copied from a neighbour"
		noun="missing-rain period"
	/>
</div>

<style>
	.zero-rain {
		display: grid;
		gap: 0.75rem;
		margin: 0.25rem 0 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.sub {
		font-size: 0.95rem;
		margin: 0;
	}
	.mode {
		max-width: 75ch;
	}
	.mode select {
		max-width: 320px;
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
		font-size: 0.8rem;
		color: var(--text-muted);
	}
</style>
