<!--
	Settings → Data quality (settings.dataQuality, docs/model.md §2.10a): the
	limits of the input checks the Data tab and a run's warnings report. The
	gauge-vs-logger, outlier and flat-line limits only change what is flagged;
	the zero-rain run and low-vs-CHIRPS limits (engine ≥ 1.20.0, issue #66)
	change results, because a run treats flagged zero runs as missing (§2.4c)
	and leaves flagged water years out of the CHIRPS factor fit (§2.4b). Part
	of the Settings form: the save bar saves it, and `error` blocks saving.
-->
<script lang="ts">
	import type { DataQualitySettings } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '$lib/components/notes/notes';
	import { LOW_VS_CHIRPS_BASELINE_OPTIONS, LOW_VS_CHIRPS_MINIMUM_OPTIONS, ZERO_RUN_RULE_OPTIONS } from './dataQuality';

	let {
		value = $bindable(),
		projectId,
		readonly = false,
		error = null
	}: { value: DataQualitySettings; projectId: string; readonly?: boolean; error?: string | null } = $props();

	const rule = $derived(ZERO_RUN_RULE_OPTIONS.find((o) => o.value === value.zeroRunRule));
</script>

<section class="panel" id="set-quality" aria-labelledby="dq-h" data-testid="data-quality-settings">
	<div class="panel-head">
		<h2 id="dq-h">Data quality <HelpTip key="settings.dataQuality" /></h2>
		<span class="muted small">Input checks, and the zero-rain and low-vs-CHIRPS limits runs use</span>
		<NotesDrawer {projectId} target={settingTarget('quality')} />
	</div>

	<h3 class="sub">Gauge vs logger</h3>
	<div class="fields">
		<div class="field">
			<label for="dq-min">Lowest gauge/logger ratio <span class="u">(%)</span></label>
			<NumberInput id="dq-min" decimals={1} min={1} max={100} scale={100} disabled={readonly} bind:value={value.agreementMinRatio} aria-describedby="dq-min-h" />
			<span class="hint" id="dq-min-h">Flag a water year when the gauge reads less than this share of the logger. Default 66.7 % (two thirds).</span>
			<FieldHistoryLine field="settings:dataQuality.agreementMinRatio" />
		</div>
		<div class="field">
			<label for="dq-max">Highest gauge/logger ratio <span class="u">(%)</span></label>
			<NumberInput id="dq-max" decimals={1} min={100} max={10_000} scale={100} disabled={readonly} bind:value={value.agreementMaxRatio} aria-describedby="dq-max-h" />
			<span class="hint" id="dq-max-h">… or more than this share. Default 150 %.</span>
			<FieldHistoryLine field="settings:dataQuality.agreementMaxRatio" />
		</div>
		<div class="field">
			<label for="dq-days">Minimum shared days <span class="u">(days)</span></label>
			<NumberInput id="dq-days" min={1} max={366} step={1} disabled={readonly} bind:value={value.agreementMinDays} aria-describedby="dq-days-h" />
			<span class="hint" id="dq-days-h">Water years with fewer days on which both records have a reading are not judged. Default 90.</span>
			<FieldHistoryLine field="settings:dataQuality.agreementMinDays" />
		</div>
	</div>

	<h3 class="sub">Outliers and flat stretches</h3>
	<div class="fields">
		<div class="field">
			<label for="dq-out-rain">Rain outlier factor <span class="u">(× 99th percentile)</span></label>
			<NumberInput id="dq-out-rain" decimals={1} min={1.1} max={1000} disabled={readonly} bind:value={value.outlierFactorRain} aria-describedby="dq-out-rain-h" />
			<span class="hint" id="dq-out-rain-h">Flag a rain or daily A-pan value above this many times the 99th percentile of the series’ positive values. Default 5.</span>
			<FieldHistoryLine field="settings:dataQuality.outlierFactorRain" />
		</div>
		<div class="field">
			<label for="dq-out-flow">Flow outlier factor <span class="u">(× 99th percentile)</span></label>
			<NumberInput id="dq-out-flow" decimals={1} min={1.1} max={1000} disabled={readonly} bind:value={value.outlierFactorFlow} aria-describedby="dq-out-flow-h" />
			<span class="hint" id="dq-out-flow-h">The same for flow. Default 10.</span>
			<FieldHistoryLine field="settings:dataQuality.outlierFactorFlow" />
		</div>
		<div class="field">
			<label for="dq-flat-rain">Rain flat stretch <span class="u">(days)</span></label>
			<NumberInput id="dq-flat-rain" min={2} max={366} step={1} disabled={readonly} bind:value={value.flatlineRainDays} aria-describedby="dq-flat-rain-h" />
			<span class="hint" id="dq-flat-rain-h">Flag this many days in a row of one non-zero rain value. Default 5.</span>
			<FieldHistoryLine field="settings:dataQuality.flatlineRainDays" />
		</div>
		<div class="field">
			<label for="dq-flat-evap">A-pan flat stretch <span class="u">(days)</span></label>
			<NumberInput id="dq-flat-evap" min={2} max={366} step={1} disabled={readonly} bind:value={value.flatlineEvapDays} aria-describedby="dq-flat-evap-h" />
			<span class="hint" id="dq-flat-evap-h">The same for daily A-pan evaporation. Default 7.</span>
			<FieldHistoryLine field="settings:dataQuality.flatlineEvapDays" />
		</div>
		<div class="field">
			<label for="dq-flat-flow-min">Shortest flow flat stretch <span class="u">(days)</span></label>
			<NumberInput id="dq-flat-flow-min" min={2} max={366} step={1} disabled={readonly} bind:value={value.flatlineFlowMinDays} aria-describedby="dq-flat-flow-min-h" />
			<span class="hint" id="dq-flat-flow-min-h">A flow flat stretch lasts longer the lower the flow, at the record’s resolution; never fewer days than this. Default 14.</span>
			<FieldHistoryLine field="settings:dataQuality.flatlineFlowMinDays" />
		</div>
		<div class="field">
			<label for="dq-flat-flow-max">Longest flow flat stretch <span class="u">(days)</span></label>
			<NumberInput id="dq-flat-flow-max" min={2} max={366} step={1} disabled={readonly} bind:value={value.flatlineFlowMaxDays} aria-describedby="dq-flat-flow-max-h" />
			<span class="hint" id="dq-flat-flow-max-h">… and never more; zero flow (a river that stops) needs this many. Default 90.</span>
			<FieldHistoryLine field="settings:dataQuality.flatlineFlowMaxDays" />
		</div>
	</div>
	<p class="hint muted">These only decide what is flagged; they never change the model results.</p>

	<h3 class="sub">Catchment rain recorded as zero</h3>
	<div class="field mode">
		<label for="dq-zero-rule">Judge a zero-rain run by</label>
		<select id="dq-zero-rule" disabled={readonly} bind:value={value.zeroRunRule} aria-describedby="dq-zero-rule-h">
			{#each ZERO_RUN_RULE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<span class="hint" id="dq-zero-rule-h">{rule?.help}</span>
		<FieldHistoryLine field="settings:dataQuality.zeroRunRule" />
	</div>
	<div class="fields">
		{#if value.zeroRunRule === 'usualRain'}
			<div class="field">
				<label for="dq-zero-share">Share of the usual annual rain <span class="u">(%)</span></label>
				<NumberInput id="dq-zero-share" decimals={1} min={0.1} max={100} scale={100} disabled={readonly} bind:value={value.zeroRunUsualShare} aria-describedby="dq-zero-share-h" />
				<span class="hint" id="dq-zero-share-h">Default 25 %.</span>
				<FieldHistoryLine field="settings:dataQuality.zeroRunUsualShare" />
			</div>
			<div class="field">
				<label for="dq-zero-min">Shortest run <span class="u">(days)</span></label>
				<NumberInput id="dq-zero-min" min={1} max={366} step={1} disabled={readonly} bind:value={value.zeroRunMinDays} aria-describedby="dq-zero-min-h" />
				<span class="hint" id="dq-zero-min-h">Default 60.</span>
				<FieldHistoryLine field="settings:dataQuality.zeroRunMinDays" />
			</div>
		{:else}
			<div class="field">
				<label for="dq-zero-wet">Days in the wet season <span class="u">(days)</span></label>
				<NumberInput id="dq-zero-wet" min={1} max={366} step={1} disabled={readonly} bind:value={value.zeroRunMinWetDays} aria-describedby="dq-zero-wet-h" />
				<span class="hint" id="dq-zero-wet-h">Default 60. A record too short to tell the seasons flags 180 days in any season.</span>
				<FieldHistoryLine field="settings:dataQuality.zeroRunMinWetDays" />
			</div>
		{/if}
	</div>
	<label class="check">
		<input type="checkbox" disabled={readonly} bind:checked={value.zeroRunChirpsCheck} aria-describedby="dq-zero-chirps-h" />
		Check each zero-rain run against CHIRPS
	</label>
	<span class="hint block" id="dq-zero-chirps-h">
		When CHIRPS read at least half its usual rain over a run, the run is probably missing data and stays flagged. When CHIRPS was dry too,
		it may be a real dry spell: it is listed, not flagged, and a run keeps it as recorded. Off by default.
	</span>
	<FieldHistoryLine field="settings:dataQuality.zeroRunChirpsCheck" />
	<div class="fields">
		<div class="field">
			<label for="dq-low-ratio">Low vs CHIRPS: flag below <span class="u">(% of the usual ratio)</span></label>
			<NumberInput id="dq-low-ratio" decimals={1} min={0.1} max={99.9} scale={100} disabled={readonly} bind:value={value.lowVsChirpsRatio} aria-describedby="dq-low-ratio-h" />
			<span class="hint" id="dq-low-ratio-h">Flag a water year whose catchment / CHIRPS rain ratio is below this share of the usual one. Default 50 %.</span>
			<FieldHistoryLine field="settings:dataQuality.lowVsChirpsRatio" />
		</div>
		<div class="field">
			<label for="dq-low-base">Usual ratio</label>
			<select id="dq-low-base" disabled={readonly} bind:value={value.lowVsChirpsBaseline} aria-describedby="dq-low-base-h">
				{#each LOW_VS_CHIRPS_BASELINE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
			<span class="hint" id="dq-low-base-h">A moving median follows a record whose ratio drifts over the decades, such as a gauge network that changed.</span>
			<FieldHistoryLine field="settings:dataQuality.lowVsChirpsBaseline" />
		</div>
		<div class="field">
			<label for="dq-low-min">CHIRPS rain a year needs</label>
			<select id="dq-low-min" disabled={readonly} bind:value={value.lowVsChirpsMinimum} aria-describedby="dq-low-min-h">
				{#each LOW_VS_CHIRPS_MINIMUM_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
			</select>
			<span class="hint" id="dq-low-min-h">A water year with less CHIRPS rain on its shared days is not judged.</span>
			<FieldHistoryLine field="settings:dataQuality.lowVsChirpsMinimum" />
		</div>
	</div>
	<p class="hint muted">
		These change results: a run treats flagged zero-rain runs as missing (<a href="#set-rain">Rain gaps</a>, Zero-rain runs) and leaves flagged water years out
		of the CHIRPS factor fit, and a fit made under other limits asks to be redone. The defaults are the rules runs used before these were
		settings; the alternatives follow a hydrologist review and are still to be tested on a semi-arid record.
	</p>
	{#if error}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
	.sub {
		font-size: 0.95rem;
		margin: 1rem 0 0;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.field :global(input:not([type='checkbox'])),
	.field select {
		width: 100%;
	}
	.mode {
		max-width: 75ch;
		margin-top: 0.5rem;
	}
	.mode select {
		max-width: 320px;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	.hint.block {
		display: block;
	}
	.panel > .hint {
		margin: 0.5rem 0 0.75rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		margin: 0.75rem 0 0.25rem;
		font-weight: 500;
	}
	.err {
		color: var(--danger);
	}
</style>
