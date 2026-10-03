<!--
	Settings for settings.zeroRainRuns (engine ≥ 0.15.0, CR-20, docs/model.md
	§2.4c): what a run does with the zero-rain runs the Data tab flags, plus
	keep-dry and missing periods; and (engine ≥ 0.20.0, audit B4, §2.4d) what
	it does with multi-day accumulations, plus readings kept as recorded and
	windows listed by hand. `error` is set while any list is invalid, so the
	parent form can block saving.
-->
<script lang="ts">
	import type { ZeroRainSettings } from '@water-management/engine';
	import PeriodList from '$lib/components/common/PeriodList.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { ACCUMULATION_OPTIONS, ZERO_RAIN_OPTIONS } from './rain';

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
	let keepReadingsError = $state<string | null>(null);
	let addError = $state<string | null>(null);
	$effect(() => {
		error = keepDryError ?? missingError ?? keepReadingsError ?? addError;
	});
	const option = $derived(ZERO_RAIN_OPTIONS.find((o) => o.value === value.mode));
	const accOption = $derived(ACCUMULATION_OPTIONS.find((o) => o.value === value.accumulationMode));
</script>

<div class="zero-rain" data-testid="zero-rain-settings">
	<h3 class="sub">Zero-rain runs in the catchment rain</h3>
	<div class="field mode">
		<span class="lbl"><label for="st-zero-rain">Flagged zero runs</label><HelpTip key="settings.zeroRainRuns" label="About how zero runs are treated" /></span>
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
			helpLabel="About keeping zero runs dry"
			hint="Flagged zero runs you have confirmed as real dry spells. Days inside these periods stay 0 mm and count in the CHIRPS factor fit as readings; other flagged runs are still filled, and their days left out of the fit. If CHIRPS reads a lot of rain over a kept-dry run, each run warns and leaves that water year out of the fit."
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
		helpLabel="About other periods treated as missing"
		hint="Other periods whose catchment rain is bad, whatever it reads: for example the gap days inside a year the Data tab flags as far below CHIRPS. CHIRPS fills them, and they are left out of the CHIRPS factor fit."
		empty="None."
		addYearLabel="Add a water year"
		addRangeLabel="Add a date range"
		placeholder="e.g. logger fault; values copied from a neighbour"
		noun="missing-rain period"
	/>

	<h3 class="sub" id="st-acc-h">Multi-day accumulations</h3>
	<div class="field mode" data-testid="accumulation-settings">
		<span class="lbl"><label for="st-acc">Accumulated readings</label><HelpTip key="rain-accumulations" label="About rain read as a multi-day total" /></span>
		<select id="st-acc" disabled={readonly} bind:value={value.accumulationMode} aria-describedby="st-acc-h2">
			{#each ACCUMULATION_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint" id="st-acc-h2">{accOption?.help}</span>
	</div>
	{#if value.accumulationMode === 'spread'}
		<PeriodList
			bind:list={value.keepReadings}
			bind:error={keepReadingsError}
			{readonly}
			legend="Keep as recorded"
			helpKey="rain-accumulations"
			helpLabel="About accumulations kept as recorded"
			hint="Readings a run flags as accumulations that you know were one day's rain, such as a thunderstorm CHIRPS missed. A flagged reading whose day falls inside one of these periods stays on its day, and its days count in the CHIRPS factor fit."
			empty="None: every flagged accumulation is spread."
			addYearLabel="Keep a water year's readings"
			addRangeLabel="Keep a date range's readings"
			placeholder="e.g. thunderstorm, farm records agree"
			noun="keep-reading period"
		/>
	{/if}
	<PeriodList
		bind:list={value.addAccumulations}
		bind:error={addError}
		{readonly}
		legend="Also spread"
		helpKey="rain-accumulations"
		helpLabel="About other periods spread as accumulations"
		hint="Accumulations the check misses, listed by hand: the period's last day is the reading day, and the catchment rain recorded over the period is spread over it by CHIRPS. A period listed as missing above wins over one listed here."
		empty="None."
		addYearLabel="Add a water year"
		addRangeLabel="Add a date range"
		placeholder="e.g. station log: gauge read weekly in 1985"
		noun="listed accumulation"
	/>
</div>

<style>
	.zero-rain {
		display: grid;
		/* One column that may shrink below its content's min-content width, so a
		   long select option never widens the page at 320 px (WCAG 1.4.10, #38). */
		grid-template-columns: minmax(0, 1fr);
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
		width: 100%;
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
