<!--
	Calibration locations (issue #659, engine 1.110.0, docs/model.md §2.10n;
	calibrate at several gauges since #555): Calibration → Calibration record's
	table of every place calibration can fit on, none special: the outlet (when
	it has a record) and every gauge inside the network with a record of its
	own. Each has its Calibrate here tick (the outlet's settings.calibrateAtOutlet,
	a gauge's settings.calibrationZones[].enabled), its record's coverage and its
	parameters, and the Headline radio (settings.calibrationSiteNodeId, auto when
	none is picked) names the location whose statistics a run reports. Then the
	rest rule (settings.calibrationRest), the state with none ticked, and a fold
	per gauge row with its window, record, exclusions and suspect-day rule; the
	outlet's are the fields under the table (CalibrationSettings.svelte). It
	never writes the draft itself: `onedit` gets the settings as they should be.
	`error` is the first row whose window or exclusions can't be saved.
-->
<script lang="ts">
	import type { CalibrationFlowKind, CalibrationRest, CalibrationSite, CalibrationZone, NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
	import { CALIBRATION_RESTS } from '@water-management/engine';
	import type { Component } from 'svelte';
	import { api } from '#lib/api/index.js';
	import DayInput from '#lib/components/common/DayInput.svelte';
	import Fold from '#lib/components/common/Fold.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import CalibrationExclusions from './CalibrationExclusions.svelte';
	import { FLOW_KIND_LABEL } from './metrics';
	import { fitRecordLine } from './provenance';
	import {
		coverageText,
		locationCoverage,
		locationRows,
		locationsState,
		REST_LABEL,
		withHeadline,
		withLocationTicked,
		withRest,
		withZoneFields,
		zoneParamsText,
		zonesError
	} from '#lib/calibration/zones.js';
	import { fmtNum } from '#lib/format/number.js';

	type S = Partial<ProjectSettings>;

	let {
		settings,
		onedit,
		error = $bindable(null),
		projectId,
		nodes,
		sites,
		outletRecords,
		readonly
	}: {
		/** The form's settings, in the calibration-locations shape (zones.ts normalizedLocations). */
		settings: S;
		/** Writes the settings' location keys as given (the draft, unsaved). */
		onedit: (next: S) => void;
		error?: string | null;
		projectId: string;
		/** The model's nodes (the outlet, the gauges, the land units the rest rule counts). */
		nodes: readonly NetworkNode[];
		/** The gauges inside the network with a record (engine calibrationSites). */
		sites: CalibrationSite[];
		/** The outlet's flow records (no site): the outlet is a location only with one. */
		outletRecords: CalibrationFlowKind[];
		readonly: boolean;
	} = $props();

	const uid = $props.id();
	const s = $derived(settings);
	const rows = $derived(locationRows(nodes, sites, outletRecords, s));
	const st = $derived(locationsState(nodes, rows, s));
	const nameOf = (id: string) => rows.find((r) => r.nodeId === id)?.name ?? 'a gauge no longer in the model';
	// The records' spans, for the coverage column: the series list, fetched once (the page's list holds no dates here).
	let series = $state.raw<SeriesMeta[] | null>(null);
	$effect(() => {
		let live = true;
		api.series.list(projectId).then(
			(x) => live && (series = x),
			() => {}
		);
		return () => {
			live = false;
		};
	});

	// Each row's exclusions report their own error (PeriodList), as the outlet's do.
	let exclErrors = $state<Record<string, string | null>>({});
	$effect(() => {
		const bad = rows.find((r) => r.zone && exclErrors[r.nodeId]);
		error = zonesError(s.calibrationZones, nameOf) ?? (bad ? `Calibration location at ${bad.name}: ${exclErrors[bad.nodeId]}` : null);
	});

	const tick = (key: string | null, on: boolean) => onedit(withLocationTicked(s, nodes, key, on));
	const set = (nodeId: string, patch: Partial<Omit<CalibrationZone, 'nodeId'>>) => onedit({ ...s, calibrationZones: withZoneFields(s.calibrationZones, nodeId, patch) });
	const windowLine = (z: CalibrationZone) =>
		`${z.calibrationStart ?? 'start of record'} – ${z.calibrationEnd ?? 'end of record'}${z.calibrationExclusions.length ? ` · ${z.calibrationExclusions.length} exclusion${z.calibrationExclusions.length === 1 ? '' : 's'}` : ''}${z.qualityFlags ? ` · suspect days ${z.qualityFlags.suspect === 'include' ? 'scored' : 'left out'}` : ''}`;
	const units = (n: number) => `${fmtNum(n)} land unit${n === 1 ? '' : 's'}`;
	// What the rest rule reaches now: under 'default' the units on the catchment parameters, else those it sends to a location.
	const restReach = $derived(st.rest === 'default' ? st.defaultUnits : st.restUnits);

	// Parameters from (issue #659 option 2, slice D): its table mounts here once it exists, so this chunk never
	// depends on it. A glob, not an import: an absent file is no entry.
	const unitParamsModules = import.meta.glob<{ default: Component<Record<string, unknown>> }>('./UnitParamsTable.svelte');
	const loadUnitParams = Object.values(unitParamsModules)[0];
	let UnitParams = $state.raw<Component<Record<string, unknown>> | null>(null);
	$effect(() => {
		if (!loadUnitParams || UnitParams) return;
		let live = true;
		loadUnitParams().then((m) => live && (UnitParams = m.default));
		return () => {
			live = false;
		};
	});
</script>

<!-- id: the Warnings page lands on the table (`?field=fld-cal-zones`, issue #611). -->
<fieldset class="plain zones" id="fld-cal-zones" data-testid="calibration-locations" aria-describedby="{uid}-h">
	<legend class="label">Calibration locations <HelpTip key="calibration-zones" label="About calibration locations" /></legend>
	<p class="hint explain" id="{uid}-h">
		A ticked location fits GR4J X1–X4 for the land units draining to it, on its own record and window, after the locations those units depend
		on. None is required: unticked, a record stays a check. The headline is the location whose statistics a run reports.
	</p>
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">Calibration locations</caption>
			<thead>
				<tr>
					<th scope="col">Location</th>
					<th scope="col">Calibrate here</th>
					<th scope="col">Headline</th>
					<th scope="col" class="num">Record</th>
					<th scope="col">Parameters</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.nodeId)}
					<tr data-testid="calibration-location-row" data-node={r.nodeId} data-kind={r.kind}>
						<th scope="row">{r.name}{#if r.kind === 'outlet'}{' '}<span class="muted small">(outlet)</span>{/if}</th>
						<td>
							<label class="check">
								<input
									type="checkbox"
									checked={r.ticked}
									disabled={readonly || (!r.ticked && !!r.problem)}
									onchange={(e) => tick(r.key, e.currentTarget.checked)}
									aria-label="Calibrate here: {r.name}"
									aria-describedby={r.problem ? `${uid}-${r.nodeId}-p` : undefined}
								/>
								Calibrate here
							</label>
							{#if r.problem}<span class="warn small" id="{uid}-{r.nodeId}-p">Can’t be fitted: {r.problem}.</span>{/if}
						</td>
						<td>
							<label class="check">
								<input
									type="radio"
									name="{uid}-headline"
									checked={r.ticked && !r.unusable && !st.auto && st.headline === r.key}
									disabled={readonly || !r.ticked || r.unusable}
									onchange={() => onedit(withHeadline(s, r.nodeId))}
									aria-label="Headline: {r.name}"
								/>
								{#if r.ticked && !r.unusable && st.auto && st.headline === r.key}<span class="muted small" data-testid="calibration-headline-auto">Auto</span>{/if}
							</label>
						</td>
						<td class="num">{coverageText(locationCoverage(series, r.key, r.records, r.kind === 'outlet' ? (s.calibrationFlowKind ?? null) : (r.zone?.calibrationFlowKind ?? null)))}</td>
						<td class="small">{r.kind === 'outlet' ? `${zoneParamsText(r.params)} (the catchment parameters)` : r.zone ? zoneParamsText(r.params) : '–'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if st.ticked.length}
		<label class="check auto">
			<input type="radio" name="{uid}-headline" checked={st.auto} disabled={readonly} onchange={() => onedit(withHeadline(s, null))} aria-describedby="{uid}-auto-h" />
			Pick the headline automatically
		</label>
		<p class="hint" id="{uid}-auto-h" data-testid="calibration-locations-ticked">
			Fit automatically fits {st.ticked.length === 1 ? '1 location' : `${fmtNum(st.ticked.length)} locations`}. Headline: <strong>{st.headlineName}</strong>{st.auto
				? ' (picked automatically: the outlet when it is ticked, else the ticked gauge with the largest area above it)'
				: ''}.
		</p>
	{:else}
		<p class="alert alert-warning" role="status" data-testid="calibration-none">
			No location is calibrated: every unit runs on the catchment parameters (GR4J parameters, above). Tick Calibrate here at a location to fit
			it.
		</p>
	{/if}
	<div class="field rest">
		<label for="{uid}-rest">Units with no ticked location downstream take</label>
		<select
			id="{uid}-rest"
			disabled={readonly}
			value={st.rest}
			onchange={(e) => onedit(withRest(s, e.currentTarget.value as CalibrationRest))}
			aria-describedby="{uid}-rest-h"
		>
			{#each CALIBRATION_RESTS as r (r)}<option value={r}>{REST_LABEL[r]}</option>{/each}
		</select>
		<span class="hint" id="{uid}-rest-h" data-testid="calibration-rest-reach">
			{#if !st.ticked.length}
				No location is ticked, so every unit runs on the catchment parameters.
			{:else if restReach}
				{units(restReach)} now.
			{:else}
				None now: every land unit has a ticked location downstream.
			{/if}
		</span>
	</div>
	{#if UnitParams}
		<UnitParams
			bind:assignments={() => s.unitParamsFrom ?? null, (v: Record<string, string> | null) => onedit({ ...s, unitParamsFrom: v })}
			{nodes}
			settings={s}
			{readonly}
		/>
	{/if}
	{#each rows as r (r.nodeId)}
		{#if r.zone}
			{@const z = r.zone}
			<Fold name="{r.name}:" line={windowLine(z)} atDefaults={!z.enabled} {readonly} problem={!!zonesError([z], nameOf)} testid="calibration-zone-fold">
				<div class="field">
					<label for="{uid}-{z.nodeId}-from">From</label>
					<DayInput id="{uid}-{z.nodeId}-from" {readonly} value={z.calibrationStart ?? ''} onchange={(v) => set(z.nodeId, { calibrationStart: v || null })} />
				</div>
				<div class="field">
					<label for="{uid}-{z.nodeId}-to">To</label>
					<DayInput id="{uid}-{z.nodeId}-to" {readonly} value={z.calibrationEnd ?? ''} onchange={(v) => set(z.nodeId, { calibrationEnd: v || null })} />
				</div>
				<div class="field">
					<label for="{uid}-{z.nodeId}-kind">Record</label>
					<select id="{uid}-{z.nodeId}-kind" disabled={readonly} value={z.calibrationFlowKind ?? ''} onchange={(e) => set(z.nodeId, { calibrationFlowKind: (e.currentTarget.value || null) as CalibrationFlowKind | null })}>
						<option value="">Default (gauge record, else logger)</option>
						{#each r.records as k (k)}<option value={k}>{FLOW_KIND_LABEL[k]}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="{uid}-{z.nodeId}-suspect">Suspect days</label>
					<select
						id="{uid}-{z.nodeId}-suspect"
						disabled={readonly}
						value={z.qualityFlags?.suspect ?? ''}
						onchange={(e) => {
							const v = e.currentTarget.value;
							set(z.nodeId, { qualityFlags: v ? { ...(z.qualityFlags ?? {}), suspect: v as 'include' | 'exclude' } : null });
						}}
						aria-describedby="{uid}-{z.nodeId}-suspect-h"
					>
						<option value="">As the outlet’s quality flags</option>
						<option value="exclude">Left out of the fit</option>
						<option value="include">Scored</option>
					</select>
					<span class="hint" id="{uid}-{z.nodeId}-suspect-h">A gauge’s record has no gauged range or gap filling (those are the outlet records’).</span>
				</div>
				<CalibrationExclusions
					bind:list={() => z.calibrationExclusions, (v) => set(z.nodeId, { calibrationExclusions: v })}
					bind:error={() => exclErrors[z.nodeId] ?? null, (v) => (exclErrors[z.nodeId] = v ?? null)}
					{readonly}
				/>
				{#if z.fitRecord}<p class="small muted" data-testid="calibration-zone-fit">Fit record: {fitRecordLine(z.fitRecord)}</p>{/if}
			</Fold>
		{/if}
	{/each}
</fieldset>

<style>
	/* A fieldset's min-width is its content's by default: 0, so the table scrolls in its wrap and the select narrows on a phone. */
	.zones {
		margin-top: 0.75rem;
		min-width: 0;
		border: 0;
		padding: 0;
	}
	.check {
		display: inline-flex;
		gap: 0.375rem;
		align-items: center;
	}
	.check.auto {
		min-height: 36px;
		margin-top: 0.25rem;
	}
	.rest {
		max-width: 40rem;
		margin: 0.5rem 0;
	}
	.rest select {
		width: 100%;
		max-width: 100%;
	}
	.warn {
		display: block;
		color: var(--warning);
	}
</style>
