<!--
	Settings → Flow generation → The catchment's rainfall station (issue #612 follow-up, docs/ui.md
	§ Model settings, docs/model.md §2.4i): settings.rainStations.catchment, the station whose rain is the catchment
	rain (demand and the dams, and GR4J for a unit with no rain of its own or one scaled from the gauge), and its patching priority
	(PatchChain.svelte, as a unit's, with each station's fill of the main station's gaps over the run's history or why
	it can't help, patchChoices.ts), whether its rain is scaled to the catchment MAP, and the station the catchment's
	CHIRPS is corrected against. "No station" keeps the catchment rain series, as before stations, so a project from
	before them runs as it did. With a station (or a MAP already stored), the catchment's MAP and its source
	(settings.rainStations.catchmentMapMm / catchmentMapSource): blank is the land units' area-weighted mean MAP, as the
	engine takes it when none is stored (shown when `nodes` is given), with the ratio the station's rain is scaled by.
	Bind the setting (null = none). In lazySections.ts's chunk with the Per unit table.
-->
<script lang="ts">
	import type { RainStationSettings } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import PatchChain from './PatchChain.svelte';
	import { stationHref } from './unitRain';
	import {
		catchmentMapFormError,
		catchmentMapReadout,
		MAP_MM_MAX,
		MAP_MM_MIN,
		PE_SOURCE_MAX,
		patchFromValues,
		withCatchmentMap,
		type PatchUsability,
		type StationOption,
		type UnitNode
	} from './flowGeneration';
	import { catchmentStationRow, withCatchmentCorrectAgainst, withCatchmentPatch, withCatchmentScale, withCatchmentStation } from './catchmentRainStation';

	let {
		value = $bindable(),
		readonly = false,
		stations,
		projectId,
		nodes
	}: {
		value: RainStationSettings | null | undefined;
		readonly?: boolean;
		/** The project's rainfall stations (flowGeneration.ts stationOptions); undefined until the series list loads. */
		stations?: readonly StationOption[];
		/** The project, for each patch station's fill count (patchChoices.ts); without it the counts aren't shown. */
		projectId?: string;
		/** The model's nodes, for the land units' area-weighted mean MAP a blank catchment MAP stands for; without them the mean isn't shown. */
		nodes?: readonly (UnitNode & { mapMm?: number | null })[];
	} = $props();

	const uid = $props.id();
	const list = $derived(stations ?? []);
	const row = $derived(catchmentStationRow(value, list));
	const map = $derived(catchmentMapReadout(value, nodes, row.station));
	const mapError = $derived(catchmentMapFormError(value));
	const mapSource = $derived(value?.catchmentMapSource ?? '');
	const showMap = $derived(!!row.station || value?.catchmentMapMm != null || !!value?.catchmentMapSource);
	const mm = (v: number) => `${fmtNum(v, 0)} mm`;
	/** What a blank MAP stands for. */
	const meanText = $derived(
		map.unitsMean === undefined
			? 'the land units’ area-weighted mean MAP'
			: map.unitsMean !== null
				? `the land units’ area-weighted mean, ${mm(map.unitsMean)}`
				: map.missing.length
					? 'the land units’ area-weighted mean, which needs every land unit’s MAP'
					: 'the land units’ area-weighted mean, but there is no land unit'
	);
	const ratioText = $derived.by(() => {
		if (!row.station) return 'Not used without a station: clear it, or pick a station above.';
		if (map.noRatioWhy) return `× 1: ${map.noRatioWhy}.`;
		if (map.inUse == null) return null;
		const r = map.ratio;
		const sMap = row.station.station?.mapMm ?? 0;
		const tail = r.clamped ? ` (clamped from ${fmtNum(r.own ?? 0, 3, true)})` : r.outsideBand ? ', outside 0.5–2: check both MAPs' : '';
		return `The station’s rain × ${fmtNum(r.ratio, 3, true)}: ${mm(map.inUse)} ÷ its ${mm(sMap)}${tail}.`;
	});

	// Each patch station's fill of the main station's gaps, or why it can't help: asked for once per main station,
	// scaling and set of stations (patchChoices.ts holds the input and its preparation for the visit).
	let usability = $state<Record<string, Record<string, PatchUsability>>>({});
	let choicesFailed = $state(false);
	const keyOf = (main: string, scale: boolean) => `${main}|${scale}|${list.map((st) => st.id).join(',')}`;
	const asked = new Set<string>();
	$effect(() => {
		if (!projectId || !row.station) return;
		const [main, scale, ids] = [row.station.id, row.scale, list.map((st) => st.id)];
		const k = keyOf(main, scale);
		if (asked.has(k)) return;
		asked.add(k);
		import('./patchChoices')
			.then((m) => m.patchChoices(projectId, main, scale, ids))
			.then((c) => (usability = { ...usability, [k]: c }))
			.catch(() => (choicesFailed = true));
	});
	const use = $derived(row.station ? (usability[keyOf(row.station.id, row.scale)] ?? null) : null);
</script>

<div class="flowgen-catchment" id="fld-catchment-station" data-testid="flowgen-catchment">
	{#if stations !== undefined && !list.length}
		<p class="hint" role="note" data-testid="flowgen-catchment-no-stations">
			The project has no rainfall station yet, so the catchment runs on its rain series. Add one in the Data tab with Add data → Rainfall: station, with its MAP and source.
		</p>
	{:else}
		<div class="fields">
			<div class="field">
				<label for="{uid}-station">Station</label>
				<select id="{uid}-station" disabled={readonly} value={row.assignment?.stationId ?? ''} aria-invalid={row.missing || undefined} aria-describedby="{uid}-h" onchange={(e) => (value = withCatchmentStation(value, e.currentTarget.value || null))}>
					<option value="">No station: the catchment rain series, as before stations</option>
					{#if row.missing}<option value={row.assignment?.stationId}>A station the project no longer has</option>{/if}
					{#each list as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
				</select>
				{#if row.missing}
					<span class="err small" data-testid="flowgen-catchment-missing">Its station was deleted: runs warn and keep the catchment rain series until another is picked.</span>
				{:else if row.station}
					<span class="small"><a href={stationHref(row.station)}>{readonly ? 'See it in Series details' : row.station.station?.mapMm == null ? 'Set its MAP in Series details' : 'Change it in Series details'}</a></span>
				{/if}
			</div>
			{#if row.station}
				<div class="field">
					<span class="lbl" id="{uid}-patch-l">Then patch gaps from</span>
					<div role="group" aria-labelledby="{uid}-patch-l">
						<PatchChain
							values={row.patch}
							set={(v) => (value = withCatchmentPatch(value, patchFromValues(v)))}
							mainId={row.station.id}
							who="the catchment"
							{use}
							stations={list}
							{readonly}
							chirpsText="the catchment’s CHIRPS, corrected month by month against the station’s rain at the catchment’s MAP"
						/>
					</div>
				</div>
				<div class="field">
					<label class="check">
						<input type="checkbox" disabled={readonly} checked={row.scale} onchange={(e) => (value = withCatchmentScale(value, e.currentTarget.checked))} />
						Scale to catchment MAP
					</label>
					<span class="small muted">{row.scale ? '× catchment MAP ÷ station MAP' : '× 1, as recorded'}</span>
				</div>
				<div class="field">
					<label for="{uid}-correct">Gaps: CHIRPS corrected against</label>
					<select id="{uid}-correct" disabled={readonly} value={row.correctAgainst === row.station.id ? '' : (row.correctAgainst ?? '')} onchange={(e) => (value = withCatchmentCorrectAgainst(value, e.currentTarget.value || null))}>
						<option value="">Its station ({row.station.name})</option>
						{#each list.filter((st) => st.id !== row.station?.id) as st (st.id)}<option value={st.id}>{st.name}</option>{/each}
					</select>
				</div>
			{/if}
		</div>
		{#if showMap}
			<div class="fields map" id="fld-catchment-map" data-testid="flowgen-catchment-map">
				<div class="field">
					<label for="{uid}-map">Catchment MAP <span class="u">(mm)</span></label>
					<NumberInput
						id="{uid}-map"
						nullable
						min={MAP_MM_MIN}
						max={MAP_MM_MAX}
						step={1}
						decimals={1}
						disabled={readonly}
						value={value?.catchmentMapMm ?? null}
						placeholder={map.unitsMean ? `${fmtNum(map.unitsMean, 0)} (units’ mean)` : 'Units’ mean'}
						aria-describedby="{uid}-map-now{mapError ? ` ${uid}-map-err` : ''}"
						onchange={(v) => (value = withCatchmentMap(value, v, value?.catchmentMapSource ?? null))}
					/>
					<span class="small muted" id="{uid}-map-now" data-testid="flowgen-catchment-map-now">
						{map.entered !== null
							? `Entered: replaces ${meanText}.`
							: `Blank: ${meanText}.`}
						{#if ratioText}<span data-testid="flowgen-catchment-ratio">{ratioText}</span>{/if}
					</span>
				</div>
				<div class="field">
					<label for="{uid}-map-src">MAP source</label>
					<input
						id="{uid}-map-src"
						type="text"
						maxlength={PE_SOURCE_MAX}
						readonly={readonly}
						value={mapSource}
						placeholder="e.g. WR2012 isohyets, 1920–2009"
						aria-invalid={mapError ? true : undefined}
						aria-describedby={mapError ? `${uid}-map-err` : undefined}
						onchange={(e) => (value = withCatchmentMap(value, value?.catchmentMapMm ?? null, e.currentTarget.value))}
					/>
					{#if mapError}<span class="err small" id="{uid}-map-err" role="alert" data-testid="flowgen-catchment-map-error">{mapError}</span>{/if}
				</div>
			</div>
		{/if}
		{#if choicesFailed}
			<p class="hint" role="note" data-testid="flowgen-catchment-patch-unknown">How many gaps each station fills shows once the project has rain to run on.</p>
		{/if}
		<span class="hint explain" id="{uid}-h">
			The catchment rain is what demand and the dams read, and what GR4J runs on for a unit scaled from the catchment gauge or with no rain of its own. With a station, its days
			are its rain × catchment MAP ÷ station MAP, and its gaps and unreliable days take the
			first source in the patching priority with a reading, as a unit’s do. A station’s fill count covers the run’s days before any forecast:
			forecast days are never patched. Without a station the catchment rain series runs as before stations.
			{#if showMap}
				The catchment MAP is the one the station’s rain is taken to (and each patch station’s, and the rain CHIRPS is corrected against): enter one from a
				study, with its source, when it differs from the land units’ area-weighted mean MAP; leave it blank to use that mean.
			{/if}
		</span>
	{/if}
</div>

<style>
	.flowgen-catchment {
		margin-top: 0.5rem;
	}
	.hint {
		display: block;
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.small {
		display: block;
		font-size: var(--font-sm);
	}
	.err {
		color: var(--danger);
	}
	.muted {
		color: var(--text-2);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 36px;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.5rem 1.25rem;
	}
	.lbl {
		display: block;
	}
	.fields.map {
		margin-top: 0.5rem;
	}
	.u {
		color: var(--text-2);
	}
	input[type='text'] {
		width: 100%;
		max-width: 40ch;
	}
	select {
		max-width: 100%;
	}
	@media (pointer: coarse), (max-width: 640px) {
		select,
		input[type='text'] {
			min-height: var(--tap);
		}
	}
</style>
