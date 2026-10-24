<!--
	Settings → Flow generation → Per unit → Units without a station (settings.unitRain, issue #482, issue #553 round 3,
	docs/model.md §2.4h, docs/ui.md § Settings & calibration): what a land unit with no rainfall station runs on, the
	rule from before stations. The catchment rain gauge's MAP (a read-out of the catchment rain station's since issue
	#553, edited in the Data tab's Series details), the MAP period the CHIRPS factors compare over, and the reference
	gauge and unit whose monthly factors level every such unit's CHIRPS (issue #500, docs/model.md §2.4h *Reference
	gauge*). The Flow generation radio switches settings.unitRain on and off (SettingsTab.svelte); this shows only
	while it is Per unit. The parent works out `error` (unitRainProblem), which blocks Save; it shows under the field
	it is fixed in. Its own chunk: the Settings tab chunk sits at its size ceiling.
-->
<script lang="ts">
	import { fmtNum, localIsoDate } from '#lib/format/number.js';
	import { DEFAULT_UNIT_MAP_PERIOD, type NetworkNode, type UnitRainSettings } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import {
		CATCHMENT_GAUGE,
		gaugeMapReadout,
		mapPeriodNote,
		mapPeriodYears,
		unitGaugeKey,
		unitMapCoverage,
		unitRainOn,
		stationHref,
		unitRainProblem,
		withMapPeriodYears,
		withReferenceGauge,
		withReferenceUnit,
		type CatchmentStation
	} from './unitRain';

	let {
		value = $bindable(),
		readonly = false,
		nodes = [],
		catchmentRain
	}: {
		value: UnitRainSettings | null | undefined;
		readonly?: boolean;
		/** The model's units, to say how many with land have a MAP. */
		nodes?: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'areaKm2' | 'mapMm'>[];
		/** The catchment rain series a run reads, whose station MAP is the gauge's (issue #553): null = none, undefined = not loaded. */
		catchmentRain?: CatchmentStation | null;
	} = $props();

	const uid = $props.id();
	const on = $derived(unitRainOn(value));
	const problem = $derived(unitRainProblem(value));
	const years = $derived(mapPeriodYears(value));
	const note = $derived(mapPeriodNote(value));
	const gauge = $derived(gaugeMapReadout(value, catchmentRain));
	const coverage = $derived(unitMapCoverage(nodes));
	/** The units with land, the reference unit's choices (and each one's own gauge, the reference gauge's). */
	const land = $derived(nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0));
	const reference = $derived(on && value ? (value.reference ?? null) : null);
	/** A stored reference unit the model no longer has as a unit with land: the run warns and ignores the reference. */
	const refGone = $derived(!!reference?.unitId && !land.some((n) => n.id === reference.unitId));
	const lastYear = Number(localIsoDate().slice(0, 4));
	/** The units without a MAP named, each a link to its form; the rest counted. */
	const MISSING_SHOWN = 6;
	/** Years the fields take; one before CHIRPS (1981) saves, with a note. */
	const FIRST_YEAR = 1900;
	const errId = `${uid}-err`;
	const describe = (field: 'period' | 'reference', hint: string) => (problem?.field === field ? `${hint} ${errId}` : hint);
</script>

<fieldset class="plain unit-rain" id="set-unit-rain" data-testid="unit-rain-settings">
	<legend><h4 class="sub">Units without a station <HelpTip key="settings.unitRain" /></h4></legend>
	<span class="hint explain" id="{uid}-h">
		A unit given no station above runs as before stations: on its own gauge, the catchment gauge × the unit’s MAP ÷ the gauge’s MAP, or its own CHIRPS
		scaled to its MAP; a unit with none of them falls back to the catchment rain and the run says so.
	</span>
	{#if on && value}
		<p class="hint coverage" data-testid="unit-rain-coverage">
			{coverage.text} Set each unit’s MAP on its form in Network or from the MAP grid below, and its CHIRPS under <a href="?tab=settings&rain=units#set-feeds">Data feeds → Rain for each unit</a>.
		</p>
		{#if coverage.without.length}
			<p class="hint coverage" data-testid="unit-rain-without-map">
				Without a MAP:
				{#each coverage.without.slice(0, MISSING_SHOWN) as n, i (n.id)}{i ? ', ' : ' '}<a href="?tab=network&edit={encodeURIComponent(n.id)}&section=area">{n.name}</a>{/each}{coverage.without.length > MISSING_SHOWN ? ` and ${coverage.without.length - MISSING_SHOWN} more` : ''}.
			</p>
		{/if}
		<!-- The gauge's MAP is the catchment rain station's (issue #553): read here, edited in the Data tab's Series details.
		     A project from before stations still shows its settings.unitRain.gaugeMapMm until a station MAP is set. -->
		<div class="gauge-map" role="group" aria-labelledby="{uid}-gmap-l" data-testid="unit-rain-gauge-map">
			<span class="lbl" id="{uid}-gmap-l">Rain gauge’s MAP</span>
			<p class="readout" data-testid="unit-rain-gauge-map-value" data-from={gauge.from ?? 'none'}>
				{#if gauge.mm !== null}
					<strong>{fmtNum(gauge.mm, 1, true)} mm</strong>{gauge.source ? ` (${gauge.source})` : ''}{#if gauge.from === 'station' && catchmentRain}, the station MAP of “{catchmentRain.name || 'Catchment rain'}”{:else if gauge.from === 'settings'}, kept from these settings: set it on the catchment rain station to move it there{/if}.
				{:else if catchmentRain === null}
					Not set: the project has no catchment rain series yet. Add one with Add data, then set its station MAP.
				{:else}
					Not set.
				{/if}
				{#if catchmentRain}
					<a href={stationHref(catchmentRain)} data-testid="unit-rain-gauge-map-edit">{readonly ? 'See it in Series details' : gauge.mm !== null && gauge.from === 'station' ? 'Change it in Series details' : 'Set it in Series details'}</a>
				{/if}
			</p>
			<span class="hint explain">The catchment rain station’s own mean annual rain. With it, a unit with a MAP runs on the station’s rain × unit MAP ÷ this.</span>
			{#if problem?.field === 'gaugeMap' || problem?.field === 'gaugeSource'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
		</div>
		<fieldset class="plain period">
			<legend>MAP period</legend>
			<div class="fields">
				<div class="field">
					<label for="{uid}-from">First year</label>
					<NumberInput
						id="{uid}-from"
						min={FIRST_YEAR}
						max={lastYear}
						step={1}
						grouped={false}
						disabled={readonly}
						value={years.from}
						aria-invalid={problem?.field === 'period' || undefined}
						aria-describedby={describe('period', `${uid}-per-h`)}
						onchange={(v) => {
							if (v !== null && value) value = withMapPeriodYears(value, Math.round(v), years.to);
						}}
					/>
				</div>
				<div class="field">
					<label for="{uid}-to">Last year</label>
					<NumberInput
						id="{uid}-to"
						min={FIRST_YEAR}
						max={lastYear}
						step={1}
						grouped={false}
						disabled={readonly}
						value={years.to}
						aria-invalid={problem?.field === 'period' || undefined}
						aria-describedby={describe('period', `${uid}-per-h`)}
						onchange={(v) => {
							if (v !== null && value) value = withMapPeriodYears(value, years.from, Math.round(v));
						}}
					/>
				</div>
			</div>
			<span class="hint explain" id="{uid}-per-h">
				The calendar years a unit’s CHIRPS mean annual rain is taken over, to compare with its MAP. Default {DEFAULT_UNIT_MAP_PERIOD.start.slice(0, 4)}–{DEFAULT_UNIT_MAP_PERIOD.end.slice(0, 4)},
				the years CHIRPS’s own climatology uses; take the years the MAPs were made for.
			</span>
			{#if note}<span class="hint note" role="note" data-testid="unit-rain-period-note">{note}</span>{/if}
			{#if problem?.field === 'period'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
		</fieldset>
		<fieldset class="plain reference" data-testid="unit-rain-reference">
			<legend>Reference gauge for the units’ CHIRPS</legend>
			<div class="fields">
				<div class="field">
					<label for="{uid}-rgauge">Reference gauge</label>
					<select
						id="{uid}-rgauge"
						disabled={readonly}
						value={reference?.gauge ?? ''}
						aria-describedby="{uid}-ref-h"
						onchange={(e) => {
							if (value) value = withReferenceGauge(value, e.currentTarget.value);
						}}
					>
						<option value="">None: each unit’s CHIRPS scaled to its MAP</option>
						<option value={CATCHMENT_GAUGE}>The catchment rain gauge</option>
						{#each land as n (n.id)}<option value={unitGaugeKey(n.id)}>{n.name}’s own gauge</option>{/each}
					</select>
				</div>
				{#if reference}
					<div class="field">
						<label for="{uid}-runit">Reference unit</label>
						<select
							id="{uid}-runit"
							disabled={readonly}
							value={reference.unitId}
							aria-invalid={problem?.field === 'reference' || refGone || undefined}
							aria-describedby={describe('reference', `${uid}-runit-h`)}
							onchange={(e) => {
								if (value) value = withReferenceUnit(value, e.currentTarget.value);
							}}
						>
							<option value="" disabled>Pick the unit the gauge stands in</option>
							{#each land as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
						</select>
						<span class="hint explain" id="{uid}-runit-h">The CHIRPS cell at this unit’s centre is what the gauge is compared with.</span>
						{#if problem?.field === 'reference'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
						{#if refGone}<span class="err" data-testid="unit-rain-reference-gone">The reference unit is no longer a unit with land: runs ignore the reference until another is picked.</span>{/if}
					</div>
				{/if}
			</div>
			<span class="hint explain" id="{uid}-ref-h">
				With a reference gauge, every unit’s CHIRPS is scaled by 12 monthly factors, the gauge’s rain ÷ the CHIRPS at the reference unit’s cell on the days
				both have a reading, then rescaled so each unit’s long-term yearly total over the MAP period above is its own MAP. A month with fewer than 90 shared
				days, or under 50 mm of CHIRPS, keeps a factor of 1.
			</span>
		</fieldset>
	{/if}
	<!-- A stored setting that is off but can't be saved (another client wrote it) has no field to show its problem under. -->
	{#if problem && !on}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
	<FieldHistoryLine field="settings:unitRain" />
</fieldset>

<style>
	/* The Settings tab's own field styles are scoped to it: the same rules here. */
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.plain legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
	}
	legend .sub {
		margin: 0;
	}
	legend :global(.helptip) {
		margin-left: 0.15rem;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.field :global(input:not([type='checkbox'])) {
		width: 100%;
	}
	/* A block of its own: inline, the switch's explanation ran on after its label (issue #521). */
	.hint {
		display: block;
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.err {
		display: block;
		color: var(--danger);
		font-size: var(--font-sm);
	}
	.unit-rain {
		margin-top: 0.75rem;
	}
	.coverage {
		display: block;
		margin: 0.4rem 0;
	}
	.gauge-map {
		margin-top: 0.5rem;
	}
	.gauge-map .lbl {
		display: block;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.readout {
		margin: 0.15rem 0;
		max-width: 75ch;
	}
	.readout a {
		margin-left: 0.25rem;
	}
	.period,
	.reference {
		margin-top: 0.5rem;
	}
	.field select {
		width: 100%;
	}
	.note {
		display: block;
		margin-top: 0.25rem;
	}
</style>
