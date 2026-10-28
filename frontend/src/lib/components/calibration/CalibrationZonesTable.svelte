<!--
	Calibrate at several gauges (issue #555, engine 1.106.0, docs/model.md §2.10n):
	Settings & calibration → Calibration record's table of the calibration site
	(the outlet, or Scored at's gauge) and every other gauge inside the network
	with a flow record of its own. Each gauge's Calibrate here tick
	(settings.calibrationZones[].enabled) gives the land units draining to it
	their own GR4J parameters, fitted on its record; its fold holds the row's
	window, record, exclusions and suspect-day rule. The site's own row is the
	form's fields above, always ticked. Only under Per unit flow generation:
	under Fragmentation the ticks are disabled, with a note. Bind `zones`;
	`error` is the first row whose window can't be saved.
-->
<script lang="ts">
	import type { CalibrationFlowKind, CalibrationSite, CalibrationZone, SeriesMeta } from '@water-management/engine';
	import { api } from '#lib/api/index.js';
	import DayInput from '#lib/components/common/DayInput.svelte';
	import Fold from '#lib/components/common/Fold.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import CalibrationExclusions from './CalibrationExclusions.svelte';
	import { FLOW_KIND_LABEL } from './metrics';
	import { fitRecordLine } from './provenance';
	import { coverageText, withZoneFields, withZoneTicked, zoneCoverage, zoneParamsText, zoneRows, zonesError } from '#lib/calibration/zones.js';

	let {
		zones = $bindable(),
		error = $bindable(null),
		projectId,
		sites,
		siteNodeId,
		siteName,
		siteKind,
		perUnit,
		readonly
	}: {
		/** settings.calibrationZones; undefined on settings saved before it (none). */
		zones: CalibrationZone[] | null | undefined;
		error?: string | null;
		projectId: string;
		/** The gauges inside the network with a record (engine calibrationSites). */
		sites: CalibrationSite[];
		/** Scored at: null = the outlet. */
		siteNodeId: string | null;
		/** The site's own row's name: the outlet node's, or the Scored at gauge's. */
		siteName: string;
		/** The record the site's own zone fits (settings.calibrationFlowKind). */
		siteKind: CalibrationFlowKind | null;
		/** Per unit flow generation (settings.unitRain perUnit): the only method zones apply under. */
		perUnit: boolean;
		readonly: boolean;
	} = $props();

	const uid = $props.id();
	const rows = $derived(zoneRows(sites, zones, siteNodeId));
	const nameOf = (id: string) => sites.find((s) => s.nodeId === id)?.name ?? 'a gauge no longer in the model';
	// The records' spans, for the coverage column: the series list, fetched once (the page's list holds no dates here).
	let series = $state.raw<SeriesMeta[] | null>(null);
	$effect(() => {
		let live = true;
		api.series.list(projectId).then(
			(s) => live && (series = s),
			() => {}
		);
		return () => {
			live = false;
		};
	});
	const siteCoverage = $derived.by(() => {
		if (!series) return null;
		if (siteNodeId) {
			const s = sites.find((x) => x.nodeId === siteNodeId);
			return s ? zoneCoverage(series, s, siteKind) : null;
		}
		const kinds = ['flow_observed_m3s', 'flow_logger_m3s'] as CalibrationFlowKind[];
		const records = kinds.filter((k) => series!.some((x) => !x.siteNodeId && x.kind === k));
		return records.length ? zoneCoverage(series, { nodeId: '', name: '', records }, siteKind) : null;
	});

	// Each row's exclusions report their own error (PeriodList), as the site's do.
	let exclErrors = $state<Record<string, string | null>>({});
	$effect(() => {
		const bad = rows.find((r) => r.zone && exclErrors[r.site.nodeId]);
		error = zonesError(zones, nameOf) ?? (bad ? `Calibration zone at ${bad.site.name}: ${exclErrors[bad.site.nodeId]}` : null);
	});

	const tick = (nodeId: string, on: boolean) => (zones = withZoneTicked(zones, nodeId, on));
	const set = (nodeId: string, patch: Partial<Omit<CalibrationZone, 'nodeId'>>) => (zones = withZoneFields(zones, nodeId, patch));
	const windowLine = (z: CalibrationZone) =>
		`${z.calibrationStart ?? 'start of record'} – ${z.calibrationEnd ?? 'end of record'}${z.calibrationExclusions.length ? ` · ${z.calibrationExclusions.length} exclusion${z.calibrationExclusions.length === 1 ? '' : 's'}` : ''}${z.qualityFlags ? ` · suspect days ${z.qualityFlags.suspect === 'include' ? 'scored' : 'left out'}` : ''}`;
	const ticked = $derived(rows.filter((r) => r.zone?.enabled).length);
</script>

<!-- id: the Warnings page lands on the table (`?field=fld-cal-zones`, issue #611). -->
<fieldset class="plain zones" id="fld-cal-zones" data-testid="calibration-zones" aria-describedby="{uid}-h">
	<legend class="label">Calibrate at several gauges <HelpTip key="calibration-zones" label="About calibration zones" /></legend>
	<p class="hint explain" id="{uid}-h">
		A ticked gauge gives the land units draining to it their own GR4J parameters, fitted on its record before the zones below it; the
		calibration site fits the rest. Unticked, a gauge’s record stays a check and its units join the next ticked site downstream.
	</p>
	{#if !perUnit}
		<p class="alert alert-info small" data-testid="calibration-zones-fragmentation">
			Calibrating at several gauges needs Per unit flow generation: under Fragmentation one GR4J runs for the whole catchment. Switch
			<a href="?tab=settings#set-share">Model selection for flow generation</a> (Model settings) to Per unit to tick a gauge.
		</p>
	{:else if ticked}
		<p class="hint" data-testid="calibration-zones-ticked">Fit automatically fits {ticked + 1} zones, upstream first.</p>
	{/if}
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">Calibration sites</caption>
			<thead>
				<tr>
					<th scope="col">Site</th>
					<th scope="col">Calibrate here</th>
					<th scope="col" class="num">Record</th>
					<th scope="col">Parameters</th>
				</tr>
			</thead>
			<tbody>
				<tr data-testid="calibration-zone-site">
					<th scope="row">{siteName} <span class="muted small">({siteNodeId ? 'Scored at' : 'outlet'})</span></th>
					<td><label class="check"><input type="checkbox" checked disabled aria-describedby="{uid}-site-h" /> <span id="{uid}-site-h" class="muted small">Always: the window above</span></label></td>
					<td class="num">{coverageText(siteCoverage)}</td>
					<td class="muted small">The parameters above</td>
				</tr>
				{#each rows as r (r.site.nodeId)}
					<tr data-testid="calibration-zone-row" data-node={r.site.nodeId}>
						<th scope="row">{r.site.name}</th>
						<td>
							<label class="check">
								<input
									type="checkbox"
									checked={!!r.zone?.enabled}
									disabled={readonly || !perUnit}
									onchange={(e) => tick(r.site.nodeId, e.currentTarget.checked)}
									aria-label="Calibrate here: {r.site.name}"
								/>
								Calibrate here
							</label>
						</td>
						<td class="num">{coverageText(series ? zoneCoverage(series, r.site, r.zone?.calibrationFlowKind ?? null) : null)}</td>
						<td class="small">{r.zone ? zoneParamsText(r.zone.gr4j) : '–'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#each rows as r (r.site.nodeId)}
		{#if r.zone}
			{@const z = r.zone}
			<Fold name="{r.site.name}:" line={windowLine(z)} atDefaults={!z.enabled} {readonly} problem={!!zonesError([z], nameOf)} testid="calibration-zone-fold">
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
						{#each r.site.records as k (k)}<option value={k}>{FLOW_KIND_LABEL[k]}</option>{/each}
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
						<option value="">As the calibration site’s quality flags</option>
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
	.zones {
		margin-top: 0.75rem;
	}
	.check {
		display: inline-flex;
		gap: 0.375rem;
		align-items: center;
	}
</style>
