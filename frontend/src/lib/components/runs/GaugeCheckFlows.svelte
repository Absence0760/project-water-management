<script lang="ts">
	// The checks-only gauges' flows (issue #554): for each gauge inside the
	// network with a flow record of its own that the run doesn't score, its
	// record against the simulated flow there as a hydrograph and a
	// flow-duration curve, with the record's NSE, KGE and PBIAS as an
	// out-of-sample check, never the calibration score (the run summary's
	// plausibility.gauges[].fit, computed once by the engine). A link to the
	// record's Series details puts its Upload unit one click away. Built from
	// the run's `observed_flow_check` and `outflow` at the gauge (engine ≥
	// 1.90.0); a run made before says to run the model again. A long list
	// folds to its first FOLD_CAP gauges, and only the gauges shown load
	// their series. Pure parts: checkGauges.ts.
	import type { Snippet } from 'svelte';
	import { CHECK_GAUGE_FLOW_KEY, type DailySeries } from '@water-management/engine';
	import { api } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { foldList } from '#lib/components/common/fold.js';
	import { followRetry } from '#lib/components/common/loadState.js';
	import { fmtNum } from '#lib/format/number.js';
	import { cachedSeries } from './cache';
	import { checkFdc, checkHydrograph, gaugeStatsLine, type CheckGauge } from './checkGauges';
	import { toDisplayUnit } from './results';

	let {
		projectId,
		runId,
		gauges,
		flowUnit,
		toolbar,
		band,
		forecastFrom = null,
		recordHref
	}: {
		projectId: string;
		runId: string;
		/** The checks-only gauges (checksOnlyGauges): at least one. */
		gauges: CheckGauge[];
		flowUnit: 'm³/s' | 'm³/day';
		toolbar: Snippet;
		band?: { from: string; to?: string; label: string; note: string };
		forecastFrom?: string | null;
		/** The Data tab's Series details of a gauge's record; null when the project no longer has it. */
		recordHref: (g: CheckGauge) => string | null;
	} = $props();

	const FOLD_CAP = 3;
	let open = $state(false);
	const stored = $derived(gauges.filter((g) => g.stored));
	const before = $derived(gauges.filter((g) => !g.stored));
	const fold = $derived(foldList(stored, (g) => g.nodeId, null, open, FOLD_CAP));

	const get = (key: string, nodeId: string): Promise<DailySeries> => cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	// $state.raw: long daily arrays must not become deep proxies (ModelQuality.svelte). Replace, never mutate.
	type Flows = { observed: DailySeries; simulated: DailySeries } | { error: string };
	let flows = $state.raw<Record<string, Flows>>({});
	let loadedRun = '';
	function load(nodeId: string) {
		const id = runId;
		Promise.all([get(CHECK_GAUGE_FLOW_KEY, nodeId), get('outflow', nodeId)])
			.then(([observed, simulated]) => {
				if (id === runId) flows = { ...flows, [nodeId]: { observed, simulated } };
			})
			.catch((e) => {
				if (id === runId) flows = { ...flows, [nodeId]: { error: e instanceof Error ? e.message : String(e) } };
			});
	}
	// Each gauge shown loads once per run; opening the fold loads the rest.
	let asked = new Set<string>();
	$effect(() => {
		if (runId !== loadedRun) {
			loadedRun = runId;
			asked = new Set();
			flows = {};
		}
		for (const g of fold.shown) {
			if (asked.has(g.nodeId)) continue;
			asked.add(g.nodeId);
			load(g.nodeId);
		}
	});
	function retry(nodeId: string) {
		const { [nodeId]: _, ...rest } = flows;
		flows = rest;
		load(nodeId);
	}

	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', flowUnit).values;
	const RECENT = 3 * 365;
	const names = (list: CheckGauge[]) => list.map((g) => g.name).join(', ');
</script>

<section class="panel" id="res-gauges" aria-labelledby="gauges-h">
	<h3 id="gauges-h">Flow at gauges in the network (checks only)</h3>
	<p class="small muted">
		Each gauge with its own flow record that the run doesn't score, against the simulated flow there, on the record's days. Each one's NSE, KGE and PBIAS are a check
		out of sample (the calibration doesn't score its record, and its excluded periods are left out), never the calibration score. To calibrate at a gauge instead, tick
		its Calibrate here (Calibration → Calibration record); a ticked gauge's record is scored as a calibration location, not listed here.
	</p>
	{#if before.length}
		<p class="small muted" data-testid="check-gauges-before">
			This run was made before gauge records were charted (engine 1.90.0): {names(before)}. Run the model again to see {before.length === 1 ? 'its charts' : 'their charts'}.
		</p>
	{/if}
	{#each fold.shown as g (g.nodeId)}
		{@const f = flows[g.nodeId]}
		{@const recordLink = recordHref(g)}
		<div class="gauge" data-testid="check-gauge" data-node={g.nodeId}>
			<h4>{g.name}</h4>
			{#if !f}
				<div class="chart-ph" style:height="390px" role="status" data-loading>Loading flows at {g.name}…</div>
			{:else if 'error' in f}
				<div class="alert alert-error" role="alert">
					Couldn’t load the flows at {g.name}: {f.error}
					<!-- The loading line takes its place: the focus follows (followRetry), within this gauge. -->
					<button
						type="button"
						class="btn btn-sm"
						data-retry
						onclick={(e) => {
							followRetry(e.currentTarget);
							retry(g.nodeId);
						}}>Try again</button
					>
				</div>
			{:else}
				{@const fdc = checkFdc(f.observed, f.simulated, g.flowKind, conv, forecastFrom)}
				<LineChart
					title="Flow at {g.name} (checks only): simulated and observed"
					toolsLabel="Flow at {g.name} controls"
					unit={flowUnit}
					series={checkHydrograph(f.observed, f.simulated, g.flowKind, conv)}
					logToggle
					recentDays={RECENT}
					recentLabel="Last 3 years"
					{toolbar}
					{band}
					caption="The record is a line broken wherever it has no reading (a lone reading is a dot). Shown, never scored."
				/>
				<LineChart
					title="Flow-duration curve at {g.name} (checks only)"
					toolsLabel="Flow-duration curve at {g.name} controls"
					unit={flowUnit}
					height={220}
					series={fdc.series}
					xy={fdc.xy}
					xLabel="Time flow is equalled or exceeded (%)"
					xFormat={(v) => `${fmtNum(v, v < 1 ? 2 : 0, true)}%`}
					{toolbar}
					logToggle
					log
					caption="Both curves rank the record's days only{forecastFrom ? ', before the forecast' : ''}."
				/>
				<p class="stats" data-testid="check-gauge-stats">
					<strong>Check, out of sample:</strong>
					{gaugeStatsLine(g.fit)}
				</p>
			{/if}
			{#if recordLink}
				<p class="small"><a href={recordLink}>Series details of {g.name}’s record</a> (its Upload unit, Measured at and source, on the Data tab).</p>
			{/if}
		</div>
	{/each}
	{#if fold.hidden}
		<button type="button" class="btn btn-sm more" aria-expanded="false" onclick={() => (open = true)}>Show all {stored.length} gauges</button>
	{:else if open && stored.length > FOLD_CAP + 1}
		<button type="button" class="btn btn-sm more" aria-expanded="true" onclick={() => (open = false)}>Show the first {FOLD_CAP}</button>
	{/if}
</section>

<style>
	.gauge + .gauge {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	h4 {
		margin: 0.75rem 0 0.35rem;
	}
	.stats {
		margin: 0.5rem 0 0.25rem;
		font-size: var(--font-sm);
	}
	.more {
		margin-top: 0.75rem;
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
</style>
