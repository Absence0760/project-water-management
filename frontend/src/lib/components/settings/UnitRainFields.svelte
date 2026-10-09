<!--
	Settings → Flow generation → Rain for each unit (settings.unitRain, issue
	#482, docs/model.md §2.4h, docs/ui.md § Settings & calibration): the switch
	that runs GR4J once per unit with land on its own rain, the catchment rain
	gauge's MAP with its source, and the MAP period the CHIRPS factors compare
	over. Bind the setting (null = off); `last` keeps the one switched off until
	the form is saved. The parent works out `error` (unitRainProblem), which
	blocks Save; it shows under the field it is fixed in. Its own chunk: the
	Settings tab chunk sits at its size ceiling.
-->
<script lang="ts">
	import { DEFAULT_UNIT_MAP_PERIOD, MAP_MM_MAX, MAP_MM_MIN, PE_SOURCE_MAX, type NetworkNode, type UnitRainSettings } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { mapPeriodNote, mapPeriodYears, unitMapCoverage, unitRainOn, unitRainProblem, withGaugeMap, withMapPeriodYears, withUnitRain } from './unitRain';

	let {
		value = $bindable(),
		// No fallback: bound to an unset draft.kept key, a fallback would throw (props_invalid_value).
		last = $bindable(),
		readonly = false,
		nodes = []
	}: {
		value: UnitRainSettings | null | undefined;
		last?: unknown;
		readonly?: boolean;
		/** The model's units, to say how many with land have a MAP. */
		nodes?: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'areaKm2' | 'mapMm'>[];
	} = $props();

	const uid = $props.id();
	const on = $derived(unitRainOn(value));
	const problem = $derived(unitRainProblem(value));
	const years = $derived(mapPeriodYears(value));
	const note = $derived(mapPeriodNote(value));
	const coverage = $derived(unitMapCoverage(nodes));
	const lastYear = new Date().getUTCFullYear();
	/** The units without a MAP named, each a link to its form; the rest counted. */
	const MISSING_SHOWN = 6;
	/** Years the fields take; one before CHIRPS (1981) saves, with a note. */
	const FIRST_YEAR = 1900;
	const errId = `${uid}-err`;
	const describe = (field: 'gaugeMap' | 'gaugeSource' | 'period', hint: string) => (problem?.field === field ? `${hint} ${errId}` : hint);

	function setOn(next: boolean) {
		if (!next && value) last = $state.snapshot(value);
		value = withUnitRain(next, (last as UnitRainSettings | null) ?? null);
	}
</script>

<fieldset class="plain unit-rain" data-testid="unit-rain-settings">
	<legend><h3 class="sub">Rain for each unit <HelpTip key="settings.unitRain" /></h3></legend>
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={on} onchange={(e) => setOn(e.currentTarget.checked)} aria-describedby="{uid}-h" />
		Runoff from each unit’s own rain
	</label>
	<span class="hint explain" id="{uid}-h">
		Off, GR4J runs once on the catchment rain and the units share its flow. On, it runs once for each unit with land, on that unit’s own gauge, the
		catchment gauge × the unit’s MAP ÷ the gauge’s MAP, or the unit’s own CHIRPS scaled to its MAP; a unit with none of them falls back to the catchment
		rain and the run says so. Demand and the dams keep the catchment rain. Switching it on changes the flow: refit afterwards.
	</span>
	{#if on && value}
		<p class="hint coverage" data-testid="unit-rain-coverage">
			{coverage.text} Set each unit’s MAP on its form in Network, and its CHIRPS under <a href="?tab=settings&rain=units#set-feeds">Data feeds → Rain for each unit</a>.
		</p>
		{#if coverage.without.length}
			<p class="hint coverage" data-testid="unit-rain-without-map">
				Without a MAP:
				{#each coverage.without.slice(0, MISSING_SHOWN) as n, i (n.id)}{i ? ', ' : ' '}<a href="?tab=network&edit={encodeURIComponent(n.id)}">{n.name}</a>{/each}{coverage.without.length > MISSING_SHOWN ? ` and ${coverage.without.length - MISSING_SHOWN} more` : ''}.
			</p>
		{/if}
		<div class="fields">
			<div class="field">
				<span class="lbl"><label for="{uid}-gmap">Rain gauge’s MAP <span class="u">(mm)</span> <span class="muted">(optional)</span></label></span>
				<NumberInput
					id="{uid}-gmap"
					min={MAP_MM_MIN}
					max={MAP_MM_MAX}
					step={1}
					nullable
					placeholder="not set"
					disabled={readonly}
					value={value.gaugeMapMm ?? null}
					aria-invalid={problem?.field === 'gaugeMap' || undefined}
					aria-describedby={describe('gaugeMap', `${uid}-gmap-h`)}
					onchange={(v) => {
						if (value) value = withGaugeMap(value, v);
					}}
				/>
				<span class="hint" id="{uid}-gmap-h">The catchment rain gauge’s own mean annual rain. With it, a unit with a MAP runs on the gauge’s rain × unit MAP ÷ this.</span>
				{#if problem?.field === 'gaugeMap'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
			</div>
			{#if value.gaugeMapMm !== null && value.gaugeMapMm !== undefined}
				<div class="field source">
					<span class="lbl"><label for="{uid}-gsrc">Source of the gauge’s MAP</label></span>
					<input
						id="{uid}-gsrc"
						readonly={readonly}
						required
						maxlength={PE_SOURCE_MAX}
						value={value.gaugeMapSource ?? ''}
						placeholder="e.g. the gauge’s record 1991–2020, complete years"
						aria-invalid={problem?.field === 'gaugeSource' || undefined}
						aria-describedby={describe('gaugeSource', `${uid}-gsrc-h`)}
						oninput={(e) => {
							if (value) value = { ...value, gaugeMapSource: e.currentTarget.value };
						}}
					/>
					<span class="hint" id="{uid}-gsrc-h">Required: the record or study, and its years. The run shows it beside each unit’s factor.</span>
					{#if problem?.field === 'gaugeSource'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
				</div>
			{/if}
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
			<span class="hint" id="{uid}-per-h">
				The calendar years a unit’s CHIRPS mean annual rain is taken over, to compare with its MAP. Default {DEFAULT_UNIT_MAP_PERIOD.start.slice(0, 4)}–{DEFAULT_UNIT_MAP_PERIOD.end.slice(0, 4)},
				the years CHIRPS’s own climatology uses; take the years the MAPs were made for.
			</span>
			{#if note}<span class="hint note" role="note" data-testid="unit-rain-period-note">{note}</span>{/if}
			{#if problem?.field === 'period'}<span class="err" id={errId} data-testid="unit-rain-error">{problem.message}</span>{/if}
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
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.check {
			min-height: var(--tap);
		}
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
		max-width: 75ch;
	}
	.err {
		display: block;
		color: var(--danger);
		font-size: 0.8rem;
	}
	.unit-rain {
		margin-top: 0.75rem;
	}
	.coverage {
		display: block;
		margin: 0.4rem 0;
	}
	.source input {
		width: 100%;
		max-width: 60ch;
	}
	.period {
		margin-top: 0.5rem;
	}
	.note {
		display: block;
		margin-top: 0.25rem;
	}
</style>
