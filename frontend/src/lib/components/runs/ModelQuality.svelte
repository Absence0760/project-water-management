<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	// Model quality: how well one run fits the record (issue #586). The hydrograph and the flow-duration curve, the
	// checks-only gauges' flows, calibration with its check and where the parameters came from, the runoff model,
	// rain for each unit, the WR2012 check, the EWR test against observed flow and the plausibility checks, in that
	// order, each panel with its `#res-*` id (modelQuality.ts lists them). It takes a run and reads everything else
	// from it (its summary, settings snapshot, model and input series), so the page that shows it only picks the
	// run: the Calibration page, under "How the shown run fits", for the run `?run=` names
	// (calibration/CalibrationResults.svelte; on Runs & results until issue #586 Round 3). The water balance by
	// water year is not Model quality's: it stays on Runs & results. Each series is fetched once, on demand (see
	// cache.ts).
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { hashId } from '#lib/help/anchor.js';
	import { FLOW_QUALITY_COLUMN, resolveQualityFlags, runForcingOfSummary, type DailySeries } from '@water-management/engine';
	import { api, type Run, type RunMeta, type RunSeriesRef } from '#lib/api/index.js';
	import { beforeForecast, FDC_RECORDS, fdcPercentileTable, flowDurationCurves, onDaysOf } from '@water-management/engine';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { fmtNum, fmtQty } from '#lib/format/number.js';
	import CalibrationCheck from '#lib/components/calibration/CalibrationCheck.svelte';
	import type { CheckNode } from '#lib/components/calibration/calibrationCheck.js';
	import CalibrationPanel from '#lib/components/calibration/CalibrationPanel.svelte';
	import FitProvenance from '#lib/components/calibration/FitProvenance.svelte';
	import EwrAgreementTable from '#lib/components/ewr/EwrAgreementTable.svelte';
	import AgreementTable from '#lib/components/series/AgreementTable.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import { apanDailyOfInput, chirpsSourceOfInput, originOfFit, runChirpsFactors } from '#lib/series/provenance.js';
	import { cachedSeries } from './cache';
	import { calibrationSiteOf, CATCHMENT_FLOW_KEYS, fdcCaption, hydrographSeries, observedCaption, observedLabels, observedSources, type CatchmentFlows } from './flowSeries';
	import { forecastBand } from '#lib/components/forecast/forecast.js';
	import { toDisplayUnit } from './results';
	import { clipExclusions, exclusionKeyText, runExclusions, seriesSpan } from './exclusionShading';
	import { flowFlagLanes, lanesLooksNote } from '#lib/calibration/flowFlags.js';
	import FlowUnitSwitch from './FlowUnitSwitch.svelte';
	import GaugeCheckFlows from './GaugeCheckFlows.svelte';
	import { checksOnlyGauges, recordHref } from './checkGauges';
	import RunoffPanel from './RunoffPanel.svelte';
	import PlausibilityPanel from './PlausibilityPanel.svelte';
	import { unitRainOf } from './unitRain';
	import { stationsOf } from './stationRain';
	import { isLowerAnchor } from './modelQuality';
	// The WR2012 report: its own chunk, only a run that has one loads it.
	const loadWr2012Panel = () => import('./Wr2012Panel.svelte');
	// Rain for each unit (issue #482): its own chunk, only a run that ran per unit loads it.
	const loadUnitRainPanel = () => import('./UnitRainPanel.svelte');

	let {
		projectId,
		run,
		refs,
		nodeNames,
		nodeOrder,
		runs,
		series = null,
		projectSettings = null,
		flowUnit = $bindable('m³/s'),
		settled = $bindable(false)
	}: {
		projectId: string;
		/** The run shown (GET …/runs/:runId, with its settings snapshot, model and input series). */
		run: Run;
		/** The run's stored series (GET …/runs/:runId's `series`). */
		refs: RunSeriesRef[];
		nodeNames: Map<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		/** The project's runs, newest first: the plausibility checks overlay the latest run of each other runoff model. */
		runs: RunMeta[];
		/** The project's input series: a checks-only gauge links to its record's Series details on Data. */
		series?: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null;
		/** The project's settings, read for the calibration window asked for when the run kept no settings snapshot (an older run). */
		projectSettings?: { calibrationStart?: string | null; calibrationEnd?: string | null } | null;
		/** The page's flow unit, for every flow chart on it: bind it to share the switch with charts outside Model quality. */
		flowUnit?: 'm³/s' | 'm³/day';
		/**
		 * True once the panels after the flow-duration curve are on the page (they wait for the hydrograph to be painted,
		 * or a link to one of them): bind it to render what follows Model quality then too. It never goes back.
		 */
		settled?: boolean;
	} = $props();

	const runId = $derived(run.id);
	const summary = $derived(run.summary);
	/** A forecast run's first forecast day (WP-2.12): every daily chart shades the days from it. */
	const forecastFrom = $derived(summary.forecast?.from ?? null);
	const band = $derived(forecastBand(forecastFrom));
	/** The run's own settings, or the project's for a run that kept none: the calibration window it asked for. */
	const windowSettings = $derived(run.settings ?? projectSettings);
	/** The periods this run's calibration left out (its own settings snapshot): tinted on the hydrograph. */
	const exclusions = $derived(runExclusions(run.settings, summary.calibration?.exclusions));
	/** How Fit automatically treats each flagged class, from the run's own settings snapshot: the flag key says so. Null: not said. */
	const flagUse = $derived(run.settings ? resolveQualityFlags(run.settings.qualityFlags) : null);
	/** The gauges inside the network whose records the run checks but doesn't score (issue #554): a hydrograph and FDC each, after the outlet's. */
	const checkGauges = $derived(checksOnlyGauges(summary.plausibility?.gauges, refs, summary.calibration?.siteNodeId, nodeOrder));

	const has = (key: string, nodeId: string | null = null) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const get = (key: string, nodeId: string | null = null): Promise<DailySeries> =>
		cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	let hydroLog = $state(false);
	let fdcLog = $state(true);

	// --- catchment series -----------------------------------------------------
	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let catchment = $state.raw<CatchmentFlows>({});
	let catchError = $state<string | null>(null);
	let catchLoading = $state(true);
	// Try again on a failed load of the flows: bumping it re-runs the loads below (failures aren't cached, cache.ts).
	let attempt = $state(0);
	const retry = () => attempt++;
	const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

	$effect(() => {
		const id = runId;
		void attempt;
		catchLoading = true;
		catchError = null;
		Promise.all(CATCHMENT_FLOW_KEYS.filter(([, k]) => has(k)).map(async ([slot, k]) => [slot, await get(k)] as const))
			.then((pairs) => {
				if (id !== runId) return;
				catchment = Object.fromEntries(pairs) as CatchmentFlows;
			})
			.catch((e) => {
				if (id === runId) catchError = reason(e);
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
		void attempt;
		site = {};
		siteError = null;
		if (!g) return;
		Promise.all([get('observed_flow', g), get('outflow', g), has('observed_flow_other', g) ? get('observed_flow_other', g) : Promise.resolve(undefined)])
			.then(([observed, simulated, observedOther]) => {
				if (id === runId) site = { observed, simulated, ...(observedOther ? { observedOther } : {}) };
			})
			.catch((e) => {
				if (id === runId) siteError = reason(e);
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
		void attempt;
		quality = null;
		qualityError = null;
		if (at === undefined) return;
		get(FLOW_QUALITY_COLUMN.key, at)
			.then((series) => {
				if (id === runId) quality = { nodeId: at, series };
			})
			.catch((e) => {
				if (id === runId) qualityError = reason(e);
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

	// The panels after the flow-duration curve (and what the page renders after
	// Model quality, through `settled`) render after the hydrograph has drawn
	// and been painted: rendered with it, they held the main thread for about a
	// second on a busy machine before any chart showed. Once shown they stay (a
	// switch of run keeps them). A link to one of those panels (#res-plausibility
	// from the Summary's model checks, a bookmark) needs it on the page at once,
	// so it shows them straight away: only those, by Model quality's own anchors
	// (modelQuality.ts isLowerAnchor), not any `#res-…` (issue #586 R3-B), so a
	// link to a part of the page above Model quality doesn't draw it all early. A hydrograph that failed or has nothing to draw lets them
	// follow too, and so does one whose data is in but that hasn't drawn two
	// frames on (a chart with no width yet never draws).
	let hydroReady = $state(false);
	const lowerLink = $derived(isLowerAnchor(hashId(page.url.hash)));
	if (untrack(() => lowerLink)) settled = true;
	$effect(() => {
		if (settled) return;
		if (lowerLink) {
			settled = true;
			return;
		}
		const done = hydroReady || !!catchError || (!catchLoading && !hydroSeries.length);
		if (!done && catchLoading) return;
		// requestAnimationFrame runs before the frame's paint, a timeout queued there after it.
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const afterPaint = () => (timer = setTimeout(() => (settled = true)));
		frame = requestAnimationFrame(done ? afterPaint : () => (frame = requestAnimationFrame(afterPaint)));
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(timer);
		};
	});
</script>

<!-- One switch for every flow chart on the page (each chart's toolbar shows it), so its name says so (issue #586). -->
{#snippet unitToggle()}
	<FlowUnitSwitch bind:unit={flowUnit} />
{/snippet}

<!-- The flow-duration curve's toolbar: which days the curves rank, beside the unit switch (issue #586). -->
{#snippet fdcToolbar()}
	{@render unitToggle()}
	{#if fdc.partial}
		<span class="seg" role="group" aria-label="Days the curves rank">
			<button type="button" class="btn btn-sm" aria-pressed={fdcDays === 'observed'} onclick={() => (fdcDays = 'observed')}>Observed days</button>
			<button type="button" class="btn btn-sm" aria-pressed={fdcDays === 'all'} onclick={() => (fdcDays = 'all')}>Whole run</button>
		</span>
	{/if}
{/snippet}

<!-- A failed load: what failed, why, and Try again (playbook § 4). -->
{#snippet loadFailed(what: string, why: string)}
	<div class="alert alert-error" role="alert">
		Couldn't load {what}: {why}
		<button type="button" class="btn btn-sm" onclick={retry}>Try again</button>
	</div>
{/snippet}

<div class="model-quality">
	<section class="panel" id="res-hydrograph" aria-labelledby="hydro-h">
		<div class="panel-head"><h3 id="hydro-h">Hydrograph</h3></div>
		{#if catchError}
			{@render loadFailed('the flows', catchError)}
		{:else if catchLoading && !hydroSeries.length}
			<div class="chart-ph" style:height="390px" role="status">Loading flows…</div>
		{:else}
			<LineChart
				title="Flow at the outflow gauge: natural, simulated and observed"
				toolsLabel="Hydrograph controls"
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
				lanesNote={lanesLooksNote(outletLanes)}
				bind:ready={hydroReady}
				caption="{observedCaption(catchment, sources)} Natural flow starts hidden: click it in the legend to show it."
			/>
		{/if}
		{#if qualityError}
			{@render loadFailed("the observed flow's quality flags", qualityError)}
		{/if}
		{#if siteId}
			<!-- The calibration site (engine ≥ 1.41.0): the pair the run's calibration statistics score. -->
			{#if siteError}
				{@render loadFailed(`the flows at ${siteName}`, siteError)}
			{:else if siteSeries.length}
				<LineChart
					title="Flow at {siteName}, the calibration site: simulated and observed"
					toolsLabel="Calibration site hydrograph controls"
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
					lanesNote={lanesLooksNote(siteLanes)}
					caption="{observedCaption(site, siteSources)} The run's calibration statistics score this gauge's record against the simulated flow here (Settings → Calibration record → Scored at)."
				/>
			{:else}
				<div class="chart-ph" style:height="390px" role="status">Loading flows at the calibration site…</div>
			{/if}
		{/if}
	</section>

	<section class="panel" id="res-fdc" aria-labelledby="fdc-h">
		<div class="panel-head"><h3 id="fdc-h">Flow-duration curve</h3></div>
		{#if catchError}
			<!-- The same failed load as the hydrograph's: not "no positive values", which isn't what happened. -->
			{@render loadFailed('the flows', catchError)}
		{:else if catchLoading && !fdc.series.length}
			<div class="chart-ph" style:height="330px" role="status">Loading…</div>
		{:else}
			<LineChart
				title="Flow-duration curve at the outflow gauge: natural, simulated and observed"
				toolsLabel="Flow-duration curve controls"
				unit={flowUnit}
				height={260}
				series={fdc.series}
				xy={fdc.xy}
				xLabel="Time flow is equalled or exceeded (%)"
				xFormat={(v) => `${fmtNum(v, v < 1 ? 2 : 0, true)}%`}
				toolbar={fdcToolbar}
				logToggle
				bind:log={fdcLog}
				caption={fdcCaption(fdc)}
			/>
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

	{#if settled}
		{#if checkGauges.length}
			<!-- Every other gauge with its own record (issue #554): checks only, never the calibration score. -->
			<div class="slot">
				<GaugeCheckFlows {projectId} {runId} gauges={checkGauges} {flowUnit} toolbar={unitToggle} {band} {forecastFrom} recordHref={(g) => recordHref(series, g.nodeId, g.flowKind)} />
			</div>
		{/if}
		<div class="slot">
			<div class="panel" id="res-calibration">
				<CalibrationPanel calibration={summary.calibration} requestedStart={windowSettings?.calibrationStart ?? null} requestedEnd={windowSettings?.calibrationEnd ?? null} />
				<!-- Flow against use at each gauge with a record (issue #444): where a calibration gap is read. -->
				<CalibrationCheck
					{projectId}
					{runId}
					{refs}
					nodes={(run.model?.nodes ?? []) as unknown as CheckNode[]}
					{nodeNames}
					{forecastFrom}
					{flowUnit}
					toolbar={unitToggle}
				/>
				{#if run.settings}
					<div class="provenance">
						<FitProvenance record={run.settings.fitRecord} settings={run.settings} chirpsSource={chirpsSourceOfInput(run.inputSeries)} apanDaily={apanDailyOfInput(run.inputSeries)} chirpsFactors={runChirpsFactors(run.summary)} runForcing={runForcingOfSummary(run.summary)} observedOrigin={originOfFit(run.inputSeries, run.settings.fitRecord)} />
					</div>
				{/if}
				{#if summary.dataQuality?.observedAgreement?.flaggedYears.length}
					<div class="agree"><AgreementTable agreement={summary.dataQuality.observedAgreement} headingLevel={3} /></div>
				{/if}
			</div>
			{#if summary.runoff}
				<div class="panel" id="res-runoff">
					<RunoffPanel balance={summary.runoff} {projectId} {runId} {refs} {forecastFrom} />
				</div>
			{/if}
			{#if unitRainOf(summary) || stationsOf(summary)}
				<div class="panel" id="res-unit-rain">
					<Lazy load={loadUnitRainPanel}>
						{#snippet children(UnitRainPanel)}
							<UnitRainPanel result={unitRainOf(summary)} stations={stationsOf(summary)} order={summary.farms.map((f) => f.nodeId)} />
						{/snippet}
					</Lazy>
				</div>
			{/if}
			{#if summary.wr2012}
				<div class="panel" id="res-wr2012">
					<Lazy load={loadWr2012Panel}>
						{#snippet children(Wr2012Panel)}
							<Wr2012Panel report={summary.wr2012!} />
						{/snippet}
					</Lazy>
				</div>
			{/if}
			<div class="panel" id="res-ewr-agreement">
				<EwrAgreementTable {summary} />
				<!-- The same test at each gauge EWR site with a record of its own (engine ≥ 1.41.0). -->
				{#each summary.catchment?.ewrAgreementSites ?? [] as site (site.nodeId)}
					<EwrAgreementTable {summary} {site} title="EWR test at {site.name}: model against its observed flow" />
				{/each}
			</div>
			{#if summary.plausibility}
				<div class="panel" id="res-plausibility">
					<PlausibilityPanel checks={summary.plausibility} {projectId} {runId} runoffModel={run.runoffModel} {runs} />
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* A grid, as the page's own (RunCharts.svelte): its panels' margins don't collapse into each other. */
	.model-quality {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}
	.model-quality > .panel,
	.slot {
		min-width: 0;
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
	.q {
		margin-top: 0.5rem;
		font-size: var(--font-sm);
	}
	.provenance,
	.agree {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
</style>
