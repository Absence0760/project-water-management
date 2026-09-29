<!--
	A run's hydrologist plausibility checks (RunSummary.plausibility, engine ≥
	0.25.0; docs/model.md §2.10d): natural vs observed + net abstraction per
	water year, EWR days by rain source, the double-mass check of observed flow
	against rain, and the dry-season low-flow duration curves, overlaid with the
	latest run of each other runoff model; from engine 1.19.0 the recession
	diagnostics (RecessionDiagnostics.svelte). Part of the Runs tab's chunk (RunsTab.svelte).
-->
<script lang="ts">
	import type { LowFlowCurve, PlausibilityChecks } from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtDate, fmtNum, fmtPct } from '$lib/format/number';
	import { detailCache } from './cache';
	import RecessionDiagnostics from './RecessionDiagnostics.svelte';
	import { breakHint, curveLabel, findings, gaugeRow, lowFlowChart, otherModelRuns, seasonText, signedPct, type OtherCurves } from './plausibility';

	let {
		checks,
		projectId,
		runId,
		runoffModel,
		runs
	}: {
		checks: PlausibilityChecks;
		projectId: string;
		runId: string;
		/** The shown run's runoff model (RunMeta.runoffModel). */
		runoffModel: RunMeta['runoffModel'];
		/** The project's runs, newest first: the latest run of each other runoff model is overlaid. */
		runs: RunMeta[];
	} = $props();

	const uid = $props.id();
	const n = $derived(checks.naturalised);
	const r = $derived(checks.rainSource);
	const dm = $derived(checks.flowDoubleMass);
	const lf = $derived(checks.lowFlow);
	const flags = $derived(findings(checks));
	const gauges = $derived((checks.gauges ?? []).map(gaugeRow));
	const wy = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
	const mm3 = (v: number) => fmtNum(v, Math.abs(v) >= 10 ? 1 : 3);
	const flow = (v: number) => fmtNum(v, v >= 1 ? 2 : v >= 0.01 ? 3 : 4);
	const RECORD: Record<string, string> = { flow_observed_m3s: 'gauge', flow_logger_m3s: 'logger' };

	// --- the other runoff models' curves, fetched on demand ------------------------
	let others = $state.raw<OtherCurves[]>([]);
	let othersError = $state<string | null>(null);
	$effect(() => {
		const id = runId;
		const want = otherModelRuns(runs, { id, runoffModel });
		othersError = null;
		if (!want.length) {
			others = [];
			return;
		}
		Promise.all(
			want.map(async (m) => {
				const d = detailCache.get(m.id) ?? (await api.runs.get(projectId, m.id));
				detailCache.set(m.id, d);
				return { runId: m.id, label: m.label || `run ${fmtDate(m.createdAt, true)}`, lowFlow: d.run.summary.plausibility?.lowFlow };
			})
		)
			.then((o) => {
				if (id === runId) others = o;
			})
			.catch((e) => {
				if (id === runId) othersError = e instanceof Error ? e.message : String(e);
			});
	});

	let paired = $state<LowFlowCurve['pairedWith']>(null);
	const pairOptions = $derived(lf ? lf.curves.filter((c) => c.pairedWith).map((c) => c.pairedWith!) : []);
	$effect(() => {
		if (paired && !pairOptions.includes(paired)) paired = null;
	});
	let log = $state(true);
	const COLORS: Record<string, string> = { flow_observed_m3s: '--text', flow_logger_m3s: '--text-muted', simulated_outflow: '--series-2', natural_flow: '--series-1' };
	const chart = $derived.by(() => {
		if (!lf) return null;
		const c = lowFlowChart(lf, others, paired);
		const own = lf.curves.filter((k) => k.source !== 'simulated_outflow' || k.pairedWith === paired);
		const extra = ['--series-3', '--warning', '--danger'];
		return {
			xy: { x: c.x, ys: c.ys },
			skipped: c.skipped,
			series: c.labels.map((label, i) => ({
				label,
				startDate: '',
				values: [],
				color: i < own.length ? COLORS[own[i]!.source] : extra[(i - own.length) % extra.length],
				style: c.styles[i] === 'dashed' ? ('dashed' as const) : undefined,
				width: 1.75
			}))
		};
	});
	const qAt = (c: LowFlowCurve, p: number) => {
		const i = lf?.points.indexOf(p) ?? -1;
		return i >= 0 ? c.flowsM3s[i]! : null;
	};
	// Four checks before engine 1.19.0; the recession diagnostics (CR-13) are the fifth.
	const checkCount = $derived(checks.recession === undefined ? 'Four' : 'Five');
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Plausibility checks <HelpTip key="plausibility-checks" /></h3>
	<p class="muted small">
		{checkCount} checks a reviewing hydrologist makes by hand. They only report and warn; none changes a result. Dry season: {seasonText(checks.drySeason)}.
	</p>
	<ul class="flags" aria-label="Check results">
		{#each flags as f (f.label)}
			<li class={f.ok === null ? 'none' : f.ok ? 'good' : 'bad'}>
				<strong>{f.label}:</strong>
				{f.ok === null ? 'not checked' : f.ok ? 'no finding' : 'see below'}
			</li>
		{/each}
	</ul>

	<h4 id="{uid}-nat">Natural flow ≥ observed + net abstraction <HelpTip key="plausibility-naturalised" /></h4>
	{#if n}
		<p class="small">
			On the {RECORD[n.flowKind]} record's days: the record plus what the network took out upstream (A = natural − simulated outflow) is the natural flow
			the record implies. A year fails when that exceeds the simulated natural flow by more than {fmtPct(n.tolerance, 0)} of the observed volume (gauging
			error). {n.failedYears.length ? `${n.failedYears.length} of ${n.judgedYears} water years fail.` : `No judged water year fails (${n.judgedYears} judged).`}
		</p>
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-nat">
				<thead>
					<tr>
						<th scope="col">Water year</th>
						<th scope="col" class="num">Days</th>
						<th scope="col" class="num">Natural <span class="u">Mm³</span></th>
						<th scope="col" class="num">Observed <span class="u">Mm³</span></th>
						<th scope="col" class="num">Use <span class="u">Mm³</span></th>
						<th scope="col" class="num">Dams <span class="u">Mm³</span></th>
						<th scope="col" class="num">Land cover <span class="u">Mm³</span></th>
						<th scope="col" class="num">Observed + abstraction <span class="u">Mm³</span></th>
						<th scope="col" class="num">Gap <span class="u">% of natural</span></th>
						<th scope="col">Result</th>
					</tr>
				</thead>
				<tbody>
					{#each n.years as y (y.waterYear)}
						<tr class:short-row={y.passed === false}>
							<th scope="row">{wy(y.waterYear)}</th>
							<td class="num">{fmtNum(y.days)}</td>
							<td class="num">{mm3(y.naturalMm3)}</td>
							<td class="num">{mm3(y.observedMm3)}</td>
							<td class="num">{mm3(y.useMm3)}</td>
							<td class="num">{mm3(y.damsMm3)}</td>
							<td class="num">{mm3(y.landCoverMm3)}</td>
							<td class="num">{mm3(y.naturalisedMm3)}</td>
							<td class="num">{y.gapPct === null ? '–' : fmtNum(y.gapPct, 1)}</td>
							<td>{y.passed === null ? 'not judged' : y.passed ? 'passes' : 'fails'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="muted small">Not checked: the run has no observed flow record.</p>
	{/if}

	<h4 id="{uid}-rain">EWR days by rain source <HelpTip key="plausibility-rain-source" /></h4>
	{#if r}
		<dl class="stats">
			<div class="stat">
				<dt>Good-rain years</dt>
				<dd>{r.good.fractionNotMet === null ? '–' : fmtPct(r.good.fractionNotMet)}</dd>
				<dd class="sub">of days EWR not met, {fmtNum(r.good.years)} water year{r.good.years === 1 ? '' : 's'}</dd>
			</div>
			<div class="stat">
				<dt>Fallback-rain years</dt>
				<dd>{r.fallback.fractionNotMet === null ? '–' : fmtPct(r.fallback.fractionNotMet)}</dd>
				<dd class="sub">of days EWR not met, {fmtNum(r.fallback.years)} water year{r.fallback.years === 1 ? '' : 's'}</dd>
			</div>
			{#each r.reserve as s (s.nodeId ?? '(outlet)')}
				<div class="stat">
					<dt>Reserve months met{s.isOutlet ? '' : `, ${s.name}`}</dt>
					<dd>{s.good.rate === null ? '–' : fmtPct(s.good.rate, 0)} / {s.fallback.rate === null ? '–' : fmtPct(s.fallback.rate, 0)}</dd>
					<dd class="sub">good-rain / fallback-rain years</dd>
				</div>
			{/each}
		</dl>
		<details>
			<summary>Rain source by water year ({fmtNum(r.years.length)} years)</summary>
			<div class="table-wrap">
				<table class="data compact">
					<caption class="visually-hidden">Rain source and EWR days not met by water year</caption>
					<thead>
						<tr>
							<th scope="col">Water year</th>
							<th scope="col" class="num">Station days</th>
							<th scope="col" class="num">Rain <span class="u">mm</span></th>
							<th scope="col" class="num">Fallback rain <span class="u">%</span></th>
							<th scope="col" class="num">Fallback days <span class="u">%</span></th>
							<th scope="col">Year</th>
							<th scope="col" class="num">Days EWR not met</th>
						</tr>
					</thead>
					<tbody>
						{#each r.years as y (y.waterYear)}
							<tr>
								<th scope="row">{wy(y.waterYear)}</th>
								<td class="num">{fmtNum(y.stationDays)} of {fmtNum(y.days)}</td>
								<td class="num">{fmtNum(y.rainMm)}</td>
								<td class="num">{y.fallbackRainShare === null ? '–' : fmtPct(y.fallbackRainShare, 0)}</td>
								<td class="num">{fmtPct(y.fallbackDayShare, 0)}</td>
								<td>{y.fallback ? 'fallback' : 'good'}</td>
								<td class="num">{fmtNum(y.ewrDaysNotMet)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{:else}
		<p class="muted small">Not checked: the run has no rainfall series.</p>
	{/if}

	<h4 id="{uid}-dm">Observed flow against rain (double mass) <HelpTip key="plausibility-flow-double-mass" /></h4>
	{#if dm}
		<p class="small">
			{RECORD[dm.flowKind] === 'gauge' ? 'Gauge' : 'Logger'} flow against catchment rain over {fmtNum(dm.years.length)} water years: whole-record runoff ratio
			{fmtNum(dm.wholeSlope, 3)}. {dm.breaks.length ? '' : 'No break: the ratio stays steady.'}
		</p>
		{#if dm.breaks.length}
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-dm">
					<thead>
						<tr>
							<th scope="col">After water year</th>
							<th scope="col" class="num">Observed ratio</th>
							<th scope="col" class="num">Change</th>
							<th scope="col" class="num">Simulated ratio</th>
							<th scope="col" class="num">Beyond the model</th>
							<th scope="col" class="num">Dry / wet season</th>
							<th scope="col">Points to</th>
						</tr>
					</thead>
					<tbody>
						{#each dm.breaks as b (b.afterWaterYear)}
							<tr class:short-row={b.hint !== 'rain'}>
								<th scope="row">{wy(b.afterWaterYear)}</th>
								<td class="num">{fmtNum(b.slopeBefore, 3)} → {fmtNum(b.slopeAfter, 3)}</td>
								<td class="num">{signedPct(b.change)}</td>
								<td class="num">{fmtNum(b.simulatedSlopeBefore, 3)} → {fmtNum(b.simulatedSlopeAfter, 3)}</td>
								<td class="num">{signedPct(b.unexplained)}</td>
								<td class="num">{signedPct(b.unexplainedDry)} / {signedPct(b.unexplainedWet)}</td>
								<td>{breakHint(b)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else}
		<p class="muted small">Not checked: needs an observed flow record, rain and a catchment area, with at least 10 water years of 300+ days with both.</p>
	{/if}

	<h4 id="{uid}-lf">Dry-season low-flow duration curves <HelpTip key="plausibility-low-flow" /></h4>
	{#if lf && chart}
		{#if pairOptions.length}
			<div class="field pair">
				<label for="{uid}-pair">Simulated outflow over</label>
				<select id="{uid}-pair" bind:value={paired}>
					<option value={null}>every dry-season day of the run</option>
					{#each pairOptions as k (k)}<option value={k}>the {RECORD[k]}'s days only</option>{/each}
				</select>
			</div>
		{/if}
		<LineChart
			title="Dry-season flow duration"
			unit="m³/s"
			height={260}
			series={chart.series}
			xy={chart.xy}
			xLabel="Dry-season days flow is equalled or exceeded (%)"
			xFormat={(v) => `${fmtNum(v, 0)}%`}
			logToggle
			bind:log
			caption="Observed records are dashed. Other runoff models: the latest run of each, over every dry-season day."
		/>
		{#if chart.skipped.length}
			<p class="muted small">Not overlaid ({chart.skipped.join(', ')}): made on another dry season, so its curve isn't comparable.</p>
		{/if}
		{#if othersError}<p class="muted small" role="status">Other runoff models' curves could not be loaded: {othersError}</p>{/if}
		{#if lf.comparison}
			<p class="flag {lf.comparison.withinFactor ? 'good' : 'bad'}" role="status">
				Q90 on the {RECORD[lf.comparison.flowKind]}'s {fmtNum(lf.comparison.days)} dry-season days: simulated {flow(lf.comparison.simulatedQ90M3s)} m³/s against
				{flow(lf.comparison.observedQ90M3s)} m³/s observed ({fmtNum(lf.comparison.ratio, 2)}×){lf.comparison.withinFactor
					? ', within the factor of 2 low-flow gauging error allows.'
					: ', more than the factor of 2 low-flow gauging error allows.'}
			</p>
		{/if}
		<div class="table-wrap">
			<table class="data compact q">
				<caption class="visually-hidden">Dry-season Q70, Q90 and Q95 of each curve (m³/s)</caption>
				<thead>
					<tr>
						<th scope="col"><span class="visually-hidden">Curve</span></th>
						<th scope="col" class="num">Days</th>
						<th scope="col" class="num">Q70</th>
						<th scope="col" class="num">Q90</th>
						<th scope="col" class="num">Q95</th>
					</tr>
				</thead>
				<tbody>
					{#each lf.curves as c (`${c.source}|${c.pairedWith ?? ''}`)}
						<tr>
							<th scope="row">{curveLabel(c)} <span class="u">(m³/s)</span></th>
							<td class="num">{fmtNum(c.days)}</td>
							<td class="num">{flow(qAt(c, 70) ?? NaN)}</td>
							<td class="num">{flow(qAt(c, 90) ?? NaN)}</td>
							<td class="num">{flow(qAt(c, 95) ?? NaN)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="muted small">Not computed: no flow record covers every calendar month, so there is no dry season.</p>
	{/if}

	{#if checks.recession}
		<RecessionDiagnostics check={checks.recession} {projectId} {runId} />
	{:else if checks.recession === null}
		<h4>Recession diagnostics <HelpTip key="plausibility-recession" /></h4>
		<p class="muted small">Not checked: needs an observed flow record and catchment rain.</p>
	{/if}

	{#if gauges.length}
		<h4 id="{uid}-gauges">At gauges in the network</h4>
		<p class="small">
			The first and last checks again at each gauge with its own observed record (attached on the Data page), against the simulated flow at that gauge and
			the natural flow, dams and land cover above it, in the same dry season. The run's warnings name each finding.
		</p>
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-gauges" data-testid="plausibility-gauges">
				<thead>
					<tr>
						<th scope="col">Gauge</th>
						<th scope="col">Record</th>
						<th scope="col" class="num">Natural flow above <span class="u">% of catchment</span></th>
						<th scope="col">Natural ≥ observed + abstraction</th>
						<th scope="col" class="num">Q90 simulated ÷ observed</th>
						<th scope="col">Low flows</th>
					</tr>
				</thead>
				<tbody>
					{#each gauges as g (g.nodeId)}
						<tr class:short-row={g.ok.includes(false)}>
							<th scope="row">{g.name}</th>
							<td>{g.record}</td>
							<td class="num">{fmtPct(g.naturalShare, 0)}</td>
							<td>
								{g.judgedYears === null
									? 'not checked'
									: !g.judgedYears
										? 'no water year judged'
										: g.failedYears.length
											? `fails ${g.failedYears.map(wy).join(', ')} (${g.failedYears.length} of ${g.judgedYears})`
											: `passes (${g.judgedYears} judged)`}
							</td>
							<td class="num">{g.q90Ratio === null ? '–' : `${fmtNum(g.q90Ratio, 2)}×`}</td>
							<td>{g.withinFactor === null ? 'not checked' : g.withinFactor ? 'within the factor of 2' : 'outside the factor of 2'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	h4 {
		margin: 1.25rem 0 0.35rem;
	}
	.flags {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
		gap: 0.4rem;
	}
	.flags li,
	.flag {
		padding: 0.4rem 0.65rem;
		border-radius: var(--radius, 6px);
		border-left: 4px solid var(--border-strong);
		background: var(--surface-2);
		font-size: 0.85rem;
	}
	.flags li.good,
	.flag.good {
		border-left-color: var(--success);
	}
	.flags li.bad,
	.flag.bad {
		border-left-color: var(--danger);
	}
	.stats {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.pair {
		max-width: 320px;
		margin: 0.25rem 0 0.5rem;
	}
	.pair select {
		width: 100%;
	}
	tr.short-row {
		background: var(--row-flag);
	}
	details {
		margin-top: 0.5rem;
	}
	summary {
		cursor: pointer;
		min-height: 36px;
		display: flex;
		align-items: center;
	}
</style>
