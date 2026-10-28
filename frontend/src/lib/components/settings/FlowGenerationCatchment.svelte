<!--
	Settings → Model selection for flow generation → The catchment's rainfall station (issue #612 follow-up, docs/ui.md
	§ Model settings, docs/model.md §2.4i): settings.rainStations.catchment, the station whose rain is the catchment
	rain (GR4J's one run under Fragmentation; demand and the dams under either method), and its patching priority
	(PatchChain.svelte, as a unit's, with each station's fill of the main station's gaps over the run's history or why
	it can't help, patchChoices.ts), whether its rain is scaled to the catchment MAP, and the station the catchment's
	CHIRPS is corrected against. "No station" keeps the catchment rain series, as before stations, so a project from
	before them runs as it did. The catchment MAP itself (settings.rainStations.catchmentMapMm) has no field yet: the
	units' area-weighted mean MAP, as the engine takes it when none is stored. Bind the setting (null = none). In
	lazySections.ts's chunk with the Per unit table.
-->
<script lang="ts">
	import type { RainStationSettings } from '@water-management/engine';
	import PatchChain from './PatchChain.svelte';
	import { stationHref } from './unitRain';
	import { patchFromValues, type PatchUsability, type StationOption } from './flowGeneration';
	import { catchmentStationRow, withCatchmentCorrectAgainst, withCatchmentPatch, withCatchmentScale, withCatchmentStation } from './catchmentRainStation';

	let {
		value = $bindable(),
		readonly = false,
		stations,
		projectId
	}: {
		value: RainStationSettings | null | undefined;
		readonly?: boolean;
		/** The project's rainfall stations (flowGeneration.ts stationOptions); undefined until the series list loads. */
		stations?: readonly StationOption[];
		/** The project, for each patch station's fill count (patchChoices.ts); without it the counts aren't shown. */
		projectId?: string;
	} = $props();

	const uid = $props.id();
	const list = $derived(stations ?? []);
	const row = $derived(catchmentStationRow(value, list));

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
		{#if choicesFailed}
			<p class="hint" role="note" data-testid="flowgen-catchment-patch-unknown">How many gaps each station fills shows once the project has rain to run on.</p>
		{/if}
		<span class="hint explain" id="{uid}-h">
			The catchment rain is what GR4J runs on under Fragmentation, and what demand and the dams read under either method. With a station, its days
			are its rain × catchment MAP ÷ station MAP (the catchment MAP is the units’ area-weighted mean), and its gaps and unreliable days take the
			first source in the patching priority with a reading, as a unit’s do. A station’s fill count covers the run’s days before any forecast:
			forecast days are never patched. Without a station the catchment rain series runs as before stations.
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
	select {
		max-width: 100%;
	}
	@media (pointer: coarse), (max-width: 640px) {
		select {
			min-height: var(--tap);
		}
	}
</style>
