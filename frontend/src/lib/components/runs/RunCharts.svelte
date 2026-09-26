<script lang="ts">
	// The standard result views of one run: hydrograph, flow-duration curve,
	// EWR vs outflow, a farm's dam storage and supply, and an explorer for any
	// stored series. Each series is fetched once, on demand (see cache.ts).
	// It also lays out the results below the summary in the groups of
	// sections.ts, with a heading per group: the parent slots its own panels
	// into each group, since the flow charts share one unit switch.
	import type { Snippet } from 'svelte';
	import type { DailySeries, FarmSummary } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import { FDC_RECORDS, fdcPercentileTable, flowDurationCurves, onDaysOf } from '@water-management/engine';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { cachedSeries } from './cache';
	import { CATCHMENT_FLOW_KEYS, ewrChartSeries, hydrographSeries, observedCaption, observedLabels, observedSources, type CatchmentFlows } from './flowSeries';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import RunChart from './RunChart.svelte';
	import { storagePct, SUPPLY_TARGET, toDisplayUnit } from './results';

	let {
		projectId,
		runId,
		refs,
		farms,
		nodeNames,
		nodeOrder,
		damCapacity,
		riverLead,
		riverTail,
		farmsLead,
		modelTail,
		record,
		deeperLead,
		forecastFrom = null
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		farms: FarmSummary[];
		nodeNames: Map<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		/** nodeId → dam capacity (m³) from the current model. */
		damCapacity: ReadonlyMap<string, number>;
		/** Full-width panels opening River & Reserve, before EWR vs outflow (Reserve compliance). */
		riverLead?: Snippet;
		/** …and after it (EWR by month, the uncertainty bands). */
		riverTail?: Snippet;
		/** Opening Farms & users, before farm detail (curtailment). */
		farmsLead?: Snippet;
		/** Model quality, after the hydrograph and the flow-duration curve (calibration, runoff model, WR2012, EWR vs observed, plausibility). */
		modelTail?: Snippet;
		/** The Record group: notes, evidence and publication (sign-off, after the results). */
		record?: Snippet;
		/** Opening Dig deeper, before the explorer (self-checks). */
		deeperLead?: Snippet;
		/** A forecast run's first forecast day (WP-2.12): every daily chart shades the days from it. */
		forecastFrom?: string | null;
	} = $props();
	const band = $derived(forecastBand(forecastFrom));

	const has = (key: string, nodeId: string | null = null) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const get = (key: string, nodeId: string | null = null): Promise<DailySeries> =>
		cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');
	let hydroLog = $state(false);
	let fdcLog = $state(true);
	// Log by default: the EWR is a low-flow question and floods dwarf it on a linear axis.
	let ewrLog = $state(true);

	// --- catchment series -----------------------------------------------------
	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let catchment = $state.raw<CatchmentFlows>({});
	let catchError = $state<string | null>(null);
	let catchLoading = $state(true);

	$effect(() => {
		const id = runId;
		catchLoading = true;
		catchError = null;
		Promise.all(CATCHMENT_FLOW_KEYS.filter(([, k]) => has(k)).map(async ([slot, k]) => [slot, await get(k)] as const))
			.then((pairs) => {
				if (id !== runId) return;
				catchment = Object.fromEntries(pairs) as CatchmentFlows;
			})
			.catch((e) => {
				if (id === runId) catchError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === runId) catchLoading = false;
			});
	});

	const conv = (d: DailySeries | undefined) => (d ? toDisplayUnit(d.values, 'm³/day', flowUnit).values : []);
	// Gauge or logger, and which one the run is scored against (issue #45).
	const sources = $derived(observedSources(refs));
	const hydroSeries = $derived(hydrographSeries(catchment, conv, true, sources));
	// Which days the flow-duration curves rank. With an observed record that
	// covers only part of the run, the curves are compared on the days it read
	// (like with like); the whole run is one click away.
	let fdcDays = $state<'observed' | 'all'>('observed');
	const fdc = $derived.by(() => {
		const list = [catchment.natural, catchment.simulated, catchment.observed];
		const labels = ['Natural', 'Simulated outflow', observedLabels(sources).observed];
		const colors = ['--series-1', '--series-2', '--chart-obs'];
		const present = list.map((d, i) => ({ d, i })).filter((x) => x.d);
		const obs = catchment.observed ? conv(catchment.observed) : null;
		const converted = present.map(({ d }) => conv(d));
		// The Q10–Q95 table is the one the exports carry (engine views/fdc.ts, issue #45).
		const table = fdcPercentileTable(Object.fromEntries(present.map(({ i }, k) => [FDC_RECORDS[i]!, converted[k]!])));
		const runDays = table.runDays;
		const obsDays = table.observedDays;
		// Only a choice when the gauge misses some of the run's days.
		const partial = table.onObservedDays !== null;
		const onObserved = partial && fdcDays === 'observed';
		const values = present.map(({ i }, k) => (onObserved && i !== 2 ? onDaysOf(converted[k]!, obs!) : converted[k]!));
		const xy = flowDurationCurves(values);
		return {
			xy,
			partial,
			onObserved,
			obsDays,
			runDays,
			series: present.map(({ d, i }) => ({ label: labels[i]!, startDate: d!.startDate, values: [], color: colors[i], width: 1.5, style: i === 2 ? ('dashed' as const) : undefined })),
			q: (onObserved ? table.onObservedDays! : table.wholeRun).map((r) => ({ ...r, label: labels[FDC_RECORDS.indexOf(r.record)]! }))
		};
	});
	const ewrSeries = $derived(ewrChartSeries(catchment, conv));

	// --- one farm ------------------------------------------------------------------
	const farmOptions = $derived(
		[...farms].sort((a, b) => (nodeOrder.get(a.nodeId) ?? 1e9) - (nodeOrder.get(b.nodeId) ?? 1e9))
	);
	let farmId = $state('');
	$effect(() => {
		void runId;
		if (!farmOptions.some((f) => f.nodeId === farmId)) {
			// Open on the farm with the worst supply, if any fall short; else the first.
			const worst = [...farmOptions].sort((a, b) => a.fractionSupplied - b.fractionSupplied)[0];
			farmId = (worst && worst.fractionSupplied < SUPPLY_TARGET ? worst : farmOptions[0])?.nodeId ?? '';
		}
	});
	const farm = $derived(farmOptions.find((f) => f.nodeId === farmId) ?? null);
	const capacity = $derived(damCapacity.get(farmId) ?? 0);
	let farmData = $state.raw<{ storage?: DailySeries; demand?: DailySeries; supplied?: DailySeries }>({});
	let farmLoading = $state(false);
	let farmError = $state<string | null>(null);
	$effect(() => {
		const id = farmId;
		const run = runId;
		if (!id) return;
		farmLoading = true;
		farmError = null;
		Promise.all([
			has('dam_storage', id) ? get('dam_storage', id) : Promise.resolve(undefined),
			has('demand', id) ? get('demand', id) : Promise.resolve(undefined),
			has('supplied', id) ? get('supplied', id) : Promise.resolve(undefined)
		])
			.then(([storage, demand, supplied]) => {
				if (id === farmId && run === runId) farmData = { storage, demand, supplied };
			})
			.catch((e) => {
				if (id === farmId) farmError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === farmId) farmLoading = false;
			});
	});
	const storageSeries = $derived.by<ChartSeries[]>(() => {
		const s = farmData.storage;
		const pct = s ? storagePct(s.values, capacity) : null;
		return s && pct ? [{ label: 'Dam storage', startDate: s.startDate, values: pct, color: '--series-1' }] : [];
	});
	const supplySeries = $derived.by<ChartSeries[]>(() => {
		const out: ChartSeries[] = [];
		const { demand, supplied } = farmData;
		if (demand) out.push({ label: 'Abstraction demand', startDate: demand.startDate, values: demand.values, color: '--series-2', style: 'dashed', width: 1.25 });
		if (supplied) out.push({ label: 'Supplied', startDate: supplied.startDate, values: supplied.values, color: '--series-1', width: 1.25 });
		return out;
	});

	const RECENT = 3 * 365;
</script>

{#snippet unitToggle()}
	<span class="seg" role="group" aria-label="Flow units">
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/s'} onclick={() => (flowUnit = 'm³/s')}>m³/s</button>
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/day'} onclick={() => (flowUnit = 'm³/day')}>m³/day</button>
	</span>
{/snippet}

<div class="charts">
	<h2 class="group-h wide">River &amp; Reserve</h2>
	{#if riverLead}<div class="wide slot">{@render riverLead()}</div>{/if}

	<section class="panel wide" id="res-ewr" aria-labelledby="ewr-h">
		<h3 id="ewr-h" class="visually-hidden">EWR against outflow</h3>
		{#if catchLoading && !ewrSeries.length}
			<div class="chart-ph" style:height="330px" role="status">Loading…</div>
		{:else}
			<LineChart
				title="EWR vs simulated outflow"
				unit={flowUnit}
				height={260}
				series={ewrSeries}
				logToggle
				bind:log={ewrLog}
				recentDays={RECENT}
				recentLabel="Last 3 years"
				toolbar={unitToggle}
				{band}
				caption="Days the outflow dips below the dashed EWR line count as EWR not met."
			/>
		{/if}
	</section>


	{#if riverTail}<div class="wide slot">{@render riverTail()}</div>{/if}

	<h2 class="group-h wide">Units &amp; users</h2>
	{#if farmsLead}<div class="wide slot">{@render farmsLead()}</div>{/if}

	{#if farmOptions.length}
		<section class="panel wide" id="res-farm" aria-labelledby="farm-h">
			<div class="panel-head">
				<h3 id="farm-h">Unit detail</h3>
				<div class="field inline">
					<label for="farm-pick">Unit</label>
					<select id="farm-pick" bind:value={farmId}>
						{#each farmOptions as f (f.nodeId)}
							<option value={f.nodeId}>{f.name} · {fmtPct(f.fractionSupplied, 0)} supplied</option>
						{/each}
					</select>
				</div>
			</div>
			{#if farm}
				<p class="muted small">
					Abstraction demand {fmtNum(farm.avgDemandM3Day)} m³/day, supplied {fmtNum(farm.avgSuppliedM3Day)} m³/day
					({fmtPct(farm.fractionSupplied)}){capacity >= 1 ? ` · dam ${fmtNum(capacity)} m³` : ' · no dam'}.
				</p>
			{/if}
			{#if farmError}
				<div class="alert alert-error" role="alert">{farmError}</div>
			{:else}
				<div class="pair">
					<div>
						{#if storageSeries.length}
							<LineChart title="Dam storage, % of capacity" unit="%" height={240} series={storageSeries} recentDays={RECENT} recentLabel="Last 3 years" {band} />
						{:else if farmLoading}
							<div class="chart-ph" style:height="310px" role="status">Loading…</div>
						{:else}
							<p class="muted nodam">This unit has no dam, so there is no storage to chart.</p>
						{/if}
					</div>
					<div>
						{#if supplySeries.length}
							<LineChart title="Supply vs demand" unit="m³/day" height={240} series={supplySeries} recentDays={RECENT} recentLabel="Last 3 years" {band} />
						{:else}
							<div class="chart-ph" style:height="310px" role="status">{farmLoading ? 'Loading…' : 'No demand series.'}</div>
						{/if}
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<h2 class="group-h wide">Model quality</h2>
	<section class="panel wide" id="res-hydrograph" aria-labelledby="hydro-h">
		<h3 id="hydro-h" class="visually-hidden">Hydrograph</h3>
		{#if catchError}
			<div class="alert alert-error" role="alert">{catchError}</div>
		{:else if catchLoading && !hydroSeries.length}
			<div class="chart-ph" style:height="390px" role="status">Loading flows…</div>
		{:else}
			<LineChart
				title="Flow at the outflow gauge: natural, simulated and observed"
				unit={flowUnit}
				series={hydroSeries}
				logToggle
				bind:log={hydroLog}
				recentDays={RECENT}
				recentLabel="Last 3 years"
				toolbar={unitToggle}
				{band}
				caption="{observedCaption(catchment, sources)} Natural flow starts hidden: click it in the legend to show it."
			/>
		{/if}
	</section>

	<section class="panel wide" id="res-fdc" aria-labelledby="fdc-h">
		<h3 id="fdc-h" class="visually-hidden">Flow-duration curve</h3>
		{#if catchLoading && !fdc.series.length}
			<div class="chart-ph" style:height="330px" role="status">Loading…</div>
		{:else}
			<LineChart
				title="Flow-duration curve"
				unit={flowUnit}
				height={260}
				series={fdc.series}
				xy={fdc.xy}
				xLabel="Time flow is equalled or exceeded (%)"
				xFormat={(v) => `${fmtNum(v, v < 1 ? 2 : 0, true)}%`}
				toolbar={unitToggle}
				logToggle
				bind:log={fdcLog}
				caption={fdc.onObserved
					? `Every curve ranks the ${fmtNum(fdc.obsDays)} days with an observed reading, so they compare like with like.`
					: fdc.partial
						? `Natural and simulated flow rank all ${fmtNum(fdc.runDays)} days of the run; observed flow only its ${fmtNum(fdc.obsDays)} days with a reading.`
						: undefined}
			/>
			{#if fdc.partial}
				<span class="seg days" role="group" aria-label="Days the curves rank">
					<button type="button" class="btn btn-sm" aria-pressed={fdcDays === 'observed'} onclick={() => (fdcDays = 'observed')}>Observed days</button>
					<button type="button" class="btn btn-sm" aria-pressed={fdcDays === 'all'} onclick={() => (fdcDays = 'all')}>Whole run</button>
				</span>
			{/if}
			{#if fdc.q.length}
				<table class="data compact q">
					<thead>
						<tr>
							<th scope="col"><span class="visually-hidden">Flow record</span></th>
							<th scope="col" class="num">Q10</th>
							<th scope="col" class="num">Q50</th>
							<th scope="col" class="num">Q90</th>
							<th scope="col" class="num">Q95</th>
						</tr>
					</thead>
					<tbody>
						{#each fdc.q as q (q.label)}
							<tr>
								<th scope="row">{q.label} <span class="u">({flowUnit})</span></th>
								<td class="num">{fmtQty(q.q10, 3)}</td>
								<td class="num">{fmtQty(q.q50, 3)}</td>
								<td class="num">{fmtQty(q.q90, 3)}</td>
								<td class="num">{fmtQty(q.q95, 3)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{/if}
	</section>

	{#if modelTail}<div class="wide slot">{@render modelTail()}</div>{/if}

	{#if record}
		<h2 class="group-h wide">Record</h2>
		<div class="wide slot">{@render record()}</div>
	{/if}

	<h2 class="group-h wide">Dig deeper</h2>
	{#if deeperLead}<div class="wide slot">{@render deeperLead()}</div>{/if}

	<section class="panel wide" id="res-explore" aria-labelledby="exp-h">
		<div class="panel-head"><h3 id="exp-h">Explore any output</h3></div>
		<RunChart {projectId} {runId} {refs} {nodeNames} {nodeOrder} {flowUnit} flowToolbar={unitToggle} {band} />
	</section>
</div>

<style>
	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 1rem;
	}
	.charts > .panel {
		min-width: 0;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.slot {
		min-width: 0;
	}
	/* A group of panels (sections.ts): a quiet label above them, not a panel title. */
	.group-h {
		margin: 1.25rem 0 0.6rem;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	@media (max-width: 1100px) {
		.charts {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
	.days {
		margin-top: 0.5rem;
	}
	.q {
		margin-top: 0.5rem;
		font-size: 0.8rem;
	}
	.inline {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
	}
	.inline select {
		max-width: 100%;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	@media (max-width: 900px) {
		.pair {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.nodam {
		padding: 2rem 0;
		text-align: center;
	}
	@media (max-width: 640px) {
		.inline {
			flex-wrap: wrap;
			width: 100%;
		}
		.inline select {
			width: 100%;
			min-height: 44px;
		}
	}
</style>
