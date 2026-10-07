<!--
	The calibration check (issue #444), under the calibration statistics on
	Runs & results: one chart per gauge the run has an observed record for
	(the outlet; the calibration site), each with four lines on one axis:
	observed, simulated, the natural flow above the gauge and the abstraction
	demand upstream of it, and a fifth, the bed losses in the reaches above
	it, when the run has any (calibrationCheck.ts sums them from the run's
	stored series, fetched once each through the Runs cache, six at a time).
	A forecast run's lines stop where its forecast starts (beforeForecastFlows):
	there's no observed flow to check simulated against after it.
	The hydrograph above shows the outlet's flows on its own; this puts the use
	beside them, which is what a gap between simulated and observed is read
	against while calibrating.
-->
<script lang="ts">
	import type { DailySeries } from '@water-management/engine';
	import type { Snippet } from 'svelte';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { observedLabels, observedSources } from '$lib/components/runs/flowSeries';
	import { toDisplayUnit } from '$lib/components/runs/results';
	import { fmtNum } from '$lib/format/number';
	import { allKeys, beforeForecastFlows, checkGauges, checkKeys, checkSeries, sumDaily, type CheckFlows, type CheckNode, type SeriesKey } from './calibrationCheck';

	let {
		projectId,
		runId,
		refs,
		nodes,
		nodeNames,
		forecastFrom = null,
		flowUnit,
		toolbar
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		/** The run's own network (its model snapshot): which nodes are upstream of each gauge; empty for a run saved without it. */
		nodes: readonly CheckNode[];
		nodeNames: Map<string, string>;
		forecastFrom?: string | null;
		/** The page's flow unit (Runs & results' one switch, RunCharts), and the switch itself for each chart's toolbar. */
		flowUnit: 'm³/s' | 'm³/day';
		toolbar: Snippet;
	} = $props();

	const uid = $props.id();
	const RECENT = 3 * 365;
	let log = $state(false);

	// A run saved without its model has no network to sum over: the outlet only, its natural flow, and no demand line.
	const known = $derived(nodes.length > 0);
	const gauges = $derived(checkGauges(refs).filter((g) => known || g === null));
	const plans = $derived(gauges.map((g) => ({ gauge: g, keys: checkKeys(refs, nodes, g) })));
	const anyBedLoss = $derived(plans.some((p) => p.keys.bedLoss.length > 0));
	const id = (k: SeriesKey) => `${k.key}|${k.nodeId}`;

	// Every series the charts need, once each; replaced (never mutated) as a whole when all have come in.
	let loaded = $state.raw<{ runId: string; series: ReadonlyMap<string, DailySeries> } | null>(null);
	let done = $state(0);
	let total = $state(0);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	$effect(() => {
		const run = runId;
		const todo = allKeys(plans.map((p) => p.keys));
		void attempt;
		loaded = null;
		error = null;
		done = 0;
		total = todo.length;
		if (!todo.length) return;
		const got = new Map<string, DailySeries>();
		let next = 0;
		let live = true;
		const worker = async () => {
			while (live && next < todo.length) {
				const k = todo[next++]!;
				got.set(id(k), await cachedSeries(run, k.key, k.nodeId, () => api.runs.series(projectId, run, k.key, k.nodeId)));
				if (live) done = got.size;
			}
		};
		Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker))
			.then(() => {
				if (live) loaded = { runId: run, series: got };
			})
			.catch((e) => {
				if (live) error = e instanceof Error ? e.message : String(e);
			});
		return () => {
			live = false;
		};
	});

	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', flowUnit).values;
	const charts = $derived(
		plans.map(({ gauge, keys }) => {
			const s = loaded?.series;
			const one = (k: SeriesKey | null) => (k && s ? s.get(id(k)) : undefined);
			const many = (list: SeriesKey[]) => (s ? sumDaily(list.map((k) => s.get(id(k))).filter((x): x is DailySeries => !!x)) : null);
			const flows: CheckFlows = beforeForecastFlows(
				{ observed: one(keys.observed), simulated: one(keys.simulated), natural: many(keys.natural), demand: many(keys.demand), bedLoss: many(keys.bedLoss) },
				forecastFrom
			);
			const name = gauge === null ? 'the outflow gauge' : (nodeNames.get(gauge) ?? 'the calibration site');
			const label = observedLabels(observedSources(refs, gauge)).observed.replace(' (calibration record)', '');
			return { gauge, name, units: keys.demand.length, reaches: keys.bedLoss.length, series: checkSeries(flows, conv, label) };
		})
	);
</script>

{#if gauges.length}
	<section class="check" aria-labelledby="{uid}-h" data-testid="calibration-check">
		<h3 id="{uid}-h">Calibration check: flow against use, per gauge</h3>
		<p class="muted small how">
			How to read it: simulated should track observed; natural sits above simulated by roughly the use upstream{anyBedLoss
				? ' plus the bed losses in the reaches above the gauge'
				: ''}, and where the upstream demand rises as simulated drops below natural, abstraction is biting.
		</p>
		{#if error}
			<div class="alert alert-error" role="alert">
				The series for the calibration check couldn't be loaded: {error}
				<button type="button" class="btn btn-sm" onclick={() => attempt++}>Try again</button>
			</div>
		{:else if !loaded}
			<div class="chart-ph" role="status">Loading the calibration check ({fmtNum(done)} of {fmtNum(total)} series)…</div>
		{:else}
			{#each charts as c (c.gauge ?? 'outlet')}
				<LineChart
					title="Calibration check at {c.name}: observed, simulated, natural and upstream demand{c.reaches ? ', with bed losses' : ''}"
					unit={flowUnit}
					series={c.series}
					logToggle
					bind:log
					recentDays={RECENT}
					recentLabel="Last 3 years"
					{toolbar}
					caption="Natural: {c.gauge === null
						? 'the catchment’s natural flow'
						: 'the natural runoff of the hydrological units above this gauge, before land cover takes its share'}. Upstream demand: {!known
						? 'not shown, since this run was saved without its model'
						: c.units
							? `the demand (before any drought restriction, boreholes' share included) of ${fmtNum(c.units)} ${c.units === 1 ? 'hydrological unit or water user' : 'hydrological units and water users'} above the gauge`
							: 'none, no hydrological unit or water user above it has a demand'}.{c.reaches
						? ` Bed losses upstream: the water lost into the river bed in the ${c.reaches === 1 ? 'reach' : `${fmtNum(c.reaches)} reaches`} above the gauge, which leaves the catchment, so simulated sits below natural by this too.`
						: ''}"
				/>
			{/each}
		{/if}
	</section>
{/if}

<style>
	.check {
		margin-top: 1rem;
	}
	h3 {
		margin: 0 0 0.25rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.how {
		margin: 0 0 0.5rem;
		max-width: 75ch;
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 390px;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
</style>
