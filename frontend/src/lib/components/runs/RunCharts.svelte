<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	// The standard result views of one run: hydrograph, flow-duration curve,
	// and an explorer for any stored series (EWR vs outflow moved to River &
	// reserve with the rest of its group, river/RiverTab.svelte, and a unit's
	// supply and dam storage to Units & supply, supply/UnitDetail.svelte, issue
	// #17). Each series is fetched once, on demand (see cache.ts).
	// It also lays out the results below the summary in the groups of
	// sections.ts (model quality, record, dig deeper), with a heading per
	// group: the parent slots its own panels into each group, since the flow
	// charts share one unit switch. The river and unit groups have their own
	// pages; the run header links there (RunsTab.svelte).
	import { untrack, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { FLOW_QUALITY_COLUMN, type DailySeries, type QualityFlagSettings } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import { beforeForecast, FDC_RECORDS, fdcPercentileTable, flowDurationCurves, onDaysOf } from '@water-management/engine';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtNum, fmtQty } from '$lib/format/number';
	import { cachedSeries } from './cache';
	import { calibrationSiteOf, CATCHMENT_FLOW_KEYS, fdcCaption, hydrographSeries, observedCaption, observedLabels, observedSources, type CatchmentFlows } from './flowSeries';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import RunChart from './RunChart.svelte';
	import { toDisplayUnit } from './results';
	import { clipExclusions, exclusionKeyText, seriesSpan, type ExcludedPeriod } from './exclusionShading';
	import { flowFlagLanes } from '$lib/calibration/flowFlags';

	let {
		projectId,
		runId,
		refs,
		nodeNames,
		nodeOrder,
		modelTail,
		record,
		deeperLead,
		forecastFrom = null,
		exclusions = [],
		flagUse = null
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		nodeNames: Map<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		/**
		 * Model quality, after the hydrograph and the flow-duration curve (calibration, runoff model, WR2012, EWR vs
		 * observed, plausibility), given the page's flow unit and its switch, so a chart there (the calibration check)
		 * follows the one switch.
		 */
		modelTail?: Snippet<[{ flowUnit: 'm³/s' | 'm³/day'; toolbar: Snippet }]>;
		/** The Record group: notes, evidence and publication (sign-off, after the results). */
		record?: Snippet;
		/** Opening Dig deeper, before the explorer (self-checks). */
		deeperLead?: Snippet;
		/** A forecast run's first forecast day (WP-2.12): every daily chart shades the days from it. */
		forecastFrom?: string | null;
		/** The periods this run's calibration left out (its own settings snapshot, runExclusions): tinted on the hydrograph. */
		exclusions?: ExcludedPeriod[];
		/** How Fit automatically treats each flagged class, from the run's own settings snapshot (resolveQualityFlags): the flag key says so. Null: not said. */
		flagUse?: Omit<QualityFlagSettings, 'ratings'> | null;
	} = $props();
	const band = $derived(forecastBand(forecastFrom));

	const has = (key: string, nodeId: string | null = null) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const get = (key: string, nodeId: string | null = null): Promise<DailySeries> =>
		cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');
	let hydroLog = $state(false);
	let fdcLog = $state(true);

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

	// The calibration site's flows (engine ≥ 1.41.0): its record against the simulated flow there, the pair the
	// run's calibration statistics score when they are scored at a gauge inside the network.
	const siteId = $derived(calibrationSiteOf(refs));
	let site = $state.raw<CatchmentFlows>({});
	let siteError = $state<string | null>(null);
	$effect(() => {
		const id = runId;
		const g = siteId;
		site = {};
		siteError = null;
		if (!g) return;
		Promise.all([get('observed_flow', g), get('outflow', g), has('observed_flow_other', g) ? get('observed_flow_other', g) : Promise.resolve(undefined)])
			.then(([observed, simulated, observedOther]) => {
				if (id === runId) site = { observed, simulated, ...(observedOther ? { observedOther } : {}) };
			})
			.catch((e) => {
				if (id === runId) siteError = e instanceof Error ? e.message : String(e);
			});
	});

	// The scored record's per-day quality flags (engine ≥ 1.48.0, `observed_flow_quality`): stored beside the scored
	// `observed_flow`, the catchment's or the calibration site's, only when a day is flagged. Strips along the foot of
	// that record's hydrograph. A failed load says so under the chart, which still draws.
	let quality = $state.raw<{ nodeId: string | null; series: DailySeries } | null>(null);
	let qualityError = $state<string | null>(null);
	$effect(() => {
		const id = runId;
		const at = refs.find((r) => r.key === FLOW_QUALITY_COLUMN.key)?.nodeId;
		quality = null;
		qualityError = null;
		if (at === undefined) return;
		get(FLOW_QUALITY_COLUMN.key, at)
			.then((series) => {
				if (id === runId) quality = { nodeId: at, series };
			})
			.catch((e) => {
				if (id === runId) qualityError = `The observed flow's quality flags could not be loaded: ${e instanceof Error ? e.message : String(e)}`;
			});
	});
	const lanesAt = (nodeId: string | null) => (quality && quality.nodeId === nodeId ? flowFlagLanes(quality.series.values as number[], quality.series.startDate, flagUse) : []);
	const outletLanes = $derived(lanesAt(null));
	const siteLanes = $derived(siteId ? lanesAt(siteId) : []);
	const LANES_LABEL = 'Observed flow quality flags';

	const conv = (d: DailySeries | undefined) => (d ? toDisplayUnit(d.values, 'm³/day', flowUnit).values : []);
	// Gauge or logger, and which one the run is scored against (issue #45).
	const sources = $derived(observedSources(refs));
	const hydroSeries = $derived(hydrographSeries(catchment, conv, true, sources));
	const siteSources = $derived(siteId ? observedSources(refs, siteId) : {});
	const siteSeries = $derived(siteId ? hydrographSeries(site, conv, true, siteSources) : []);
	const siteName = $derived(siteId ? (nodeNames.get(siteId) ?? 'the calibration site') : '');
	// The run's calibration exclusions over the hydrograph's days, each with its reason in the key under it.
	const excluded = $derived(clipExclusions(exclusions, seriesSpan(hydroSeries)));
	const excludedKey = $derived(excluded.length ? { label: 'Excluded from calibration', items: excluded.map(exclusionKeyText) } : undefined);
	// Which days the flow-duration curves rank. With an observed record that
	// covers only part of the run, the curves are compared on the days it read
	// (like with like); the whole run is one click away.
	let fdcDays = $state<'observed' | 'all'>('observed');
	const fdc = $derived.by(() => {
		const list = [catchment.natural, catchment.simulated, catchment.observed];
		const labels = ['Natural', 'Simulated outflow', observedLabels(sources).observed];
		const colors = ['--series-1', '--series-2', '--chart-obs'];
		const present = list.map((d, i) => ({ d, i })).filter((x) => x.d);
		// A forecast run ranks its history only (issue #51): the days before forecastFrom.
		const history = (d: DailySeries) => Array.from(beforeForecast(conv(d), d.startDate, forecastFrom));
		const obs = catchment.observed ? history(catchment.observed) : null;
		const converted = present.map(({ d }) => history(d!));
		// The Q10–Q95 table is the one the exports carry (engine views/fdc.ts, issues #45 and #51).
		const table = fdcPercentileTable(
			Object.fromEntries(present.map(({ i, d }) => [FDC_RECORDS[i]!, conv(d)])),
			present[0] ? { startDate: present[0].d!.startDate, forecastFrom } : undefined
		);
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
			forecastDays: table.forecastDays,
			series: present.map(({ d, i }) => ({ label: labels[i]!, startDate: d!.startDate, values: [], color: colors[i], width: 1.5, style: i === 2 ? ('dashed' as const) : undefined })),
			q: (onObserved ? table.onObservedDays! : table.wholeRun).map((r) => ({ ...r, label: labels[FDC_RECORDS.indexOf(r.record)]! }))
		};
	});

	const RECENT = 3 * 365;

	// The groups below the flow charts (the rest of Model quality, Record, Dig
	// deeper) render after the hydrograph has drawn and been painted: rendered
	// with it, they held the main thread for about a second on a busy machine
	// before any chart showed. Once shown they stay (a switch of run keeps
	// them). A link to a panel down there (#res-notes from the run header, a
	// bookmark) needs it on the page at once, so it shows them straight away.
	// A hydrograph that failed or has nothing to draw lets them follow too, and
	// so does one whose data is in but that hasn't drawn two frames on (a chart
	// with no width yet never draws).
	let hydroReady = $state(false);
	const lowerLink = $derived(page.url.hash.startsWith('#res-') && !['#res-hydrograph', '#res-fdc'].includes(page.url.hash));
	let lower = $state(untrack(() => lowerLink));
	$effect(() => {
		if (lower) return;
		if (lowerLink) {
			lower = true;
			return;
		}
		const settled = hydroReady || !!catchError || (!catchLoading && !hydroSeries.length);
		if (!settled && catchLoading) return;
		// requestAnimationFrame runs before the frame's paint, a timeout queued there after it.
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const afterPaint = () => (timer = setTimeout(() => (lower = true)));
		frame = requestAnimationFrame(settled ? afterPaint : () => (frame = requestAnimationFrame(afterPaint)));
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	});
</script>

{#snippet unitToggle()}
	<span class="seg" role="group" aria-label="Flow units">
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/s'} onclick={() => (flowUnit = 'm³/s')}>m³/s</button>
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/day'} onclick={() => (flowUnit = 'm³/day')}>m³/day</button>
	</span>
{/snippet}

<div class="charts">
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
				shade={excluded}
				shadeKey={excludedKey}
				lanes={outletLanes}
				lanesLabel={LANES_LABEL}
				bind:ready={hydroReady}
				caption="{observedCaption(catchment, sources)} Natural flow starts hidden: click it in the legend to show it."
			/>
		{/if}
		{#if qualityError}<div class="alert alert-error" role="alert">{qualityError}</div>{/if}
		{#if siteId}
			<!-- The calibration site (engine ≥ 1.41.0): the pair the run's calibration statistics score. -->
			{#if siteError}
				<div class="alert alert-error" role="alert">{siteError}</div>
			{:else if siteSeries.length}
				<LineChart
					title="Flow at {siteName}, the calibration site: simulated and observed"
					unit={flowUnit}
					series={siteSeries}
					logToggle
					recentDays={RECENT}
					recentLabel="Last 3 years"
					toolbar={unitToggle}
					{band}
					shade={excluded}
					shadeKey={excludedKey}
					lanes={siteLanes}
					lanesLabel={LANES_LABEL}
					caption="{observedCaption(site, siteSources)} The run's calibration statistics score this gauge's record against the simulated flow here (Settings → Calibration record → Scored at)."
				/>
			{:else}
				<div class="chart-ph" style:height="390px" role="status">Loading flows at the calibration site…</div>
			{/if}
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
				caption={fdcCaption(fdc)}
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
							<th scope="col"><span class="visually-hidden">Flow record</span><HelpTip key="flow-duration-curve" /></th>
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

	{#if lower}
		{#if modelTail}<div class="wide slot">{@render modelTail({ flowUnit, toolbar: unitToggle })}</div>{/if}

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
	{/if}
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
</style>
