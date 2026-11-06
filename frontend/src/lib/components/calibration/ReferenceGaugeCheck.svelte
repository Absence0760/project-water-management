<!--
	Calibration → How the shown run fits → Hydrograph: the verification against a reference gauge (docs/ui.md §
	Calibration → Verification against a reference gauge). A gauge on a neighbouring river (the project's
	`flow_reference_m3s` record), scaled by area to the outlet, against the shown run's simulated (current-day) and
	natural flow there, over the days both have a value. Verification only: no run reads the record and no fit scores
	it. ModelQuality loads the record and draws its scaled line on the hydrograph; this says what is compared and how
	well, or what it needs. Logic: lib/calibration/referenceGauge.ts.
-->
<script lang="ts">
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { MONTH_MIN_DAYS, monthLabel, volumeUnit, type MonthVolumes, type VerificationRow } from '#lib/calibration/referenceGauge.js';

	let {
		name,
		state: view,
		factor = null,
		rows = { simulated: null, natural: null },
		error = null,
		retry,
		monthly = [],
		lineLabel = ''
	}: {
		/** What the gauge is called ("the reference gauge" when unnamed). */
		name: string;
		/** What can be shown: the comparison, or why not. */
		state: 'ready' | 'loading' | 'no-area' | 'no-record' | 'no-model-area' | 'unit' | 'error';
		/** The area factor and the areas behind it. */
		factor?: { factor: number; targetKm2: number; refKm2: number; targetFrom: 'set' | 'model' } | null;
		/** Each model series against the scaled record; null = the run has no such series, or no shared day. */
		rows?: { simulated: VerificationRow | null; natural: VerificationRow | null };
		error?: string | null;
		retry?: () => void;
		/** Each month's volumes over the days all three flows have a value (referenceGauge.ts monthlyVolumes). */
		monthly?: MonthVolumes[];
		/** The scaled record's legend label, as on the hydrograph. */
		lineLabel?: string;
	} = $props();

	// The monthly comparison: the chart's x is the month's place in the list, labelled by its name; a gap month is null.
	const vol = $derived(volumeUnit(monthly));
	const scaled = (v: number | null) => (v === null ? null : v / vol.div);
	const monthChart = $derived({
		xy: { x: monthly.map((_, i) => i), ys: [monthly.map((m) => scaled(m.reference)), monthly.map((m) => scaled(m.simulated)), monthly.map((m) => scaled(m.natural))] },
		series: [
			{ label: lineLabel, startDate: '', values: [], color: '--series-3', width: 1.5, style: 'dashed' as const },
			{ label: 'Simulated (current day)', startDate: '', values: [], color: '--series-2', width: 1.5 },
			{ label: 'Natural', startDate: '', values: [], color: '--series-1', width: 1.75 }
		]
	});
	const gaps = $derived(monthly.filter((m) => m.reference === null).length);
	const vfmt = (v: number | null) => (v === null ? '–' : fmtNum(v / vol.div, v / vol.div >= 100 ? 0 : 2));
	let showMonths = $state(false);

	const km = (v: number) => fmtNum(v, v >= 100 || Number.isInteger(v) ? 0 : 1);
	const num = (v: number | null, d = 2) => (v === null ? '–' : fmtNum(v, d));
	const pct = (v: number | null) => (v === null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 0)} %`);
	const SET = '#set-record';
</script>

<div class="ref-check" data-testid="reference-check" data-state={view}>
	<h4>Verification against {name}</h4>
	{#if view === 'no-area'}
		<p class="hint" data-testid="reference-needs">
			The project has a reference gauge record (another catchment’s gauge). To compare it here, scaled by area, set its catchment area under
			<a href={SET}>Calibration record → Reference gauge for verification</a>.
		</p>
	{:else if view === 'no-record'}
		<p class="hint" data-testid="reference-needs">
			A reference gauge’s area is set, but the project has no reference gauge record: add one on <a href="?tab=series">Data</a> as “Reference gauge
			(other catchment)”.
		</p>
	{:else if view === 'no-model-area'}
		<p class="hint" data-testid="reference-needs">
			This run’s catchment area isn’t known, so the record can’t be scaled to it: set the area at the outlet under
			<a href={SET}>Calibration record → Reference gauge for verification</a>.
		</p>
	{:else if view === 'unit'}
		<p class="hint" data-testid="reference-needs">The reference gauge record’s unit can’t be read as a flow, so it isn’t compared.</p>
	{:else if view === 'error'}
		<div class="alert alert-error" role="alert">
			Couldn’t load the reference gauge record: {error}
			{#if retry}<button type="button" class="btn btn-sm" onclick={retry}>Try again</button>{/if}
		</div>
	{:else if view === 'loading'}
		<p class="hint" role="status">Loading the reference gauge record…</p>
	{:else if factor}
		<p class="hint" data-testid="reference-caption">
			Verification only: a neighbouring catchment’s record, scaled by area to the outlet, so it isn’t this river’s flow and no fit scores it. Its flows ×
			<strong data-testid="reference-factor">{fmtNum(factor.factor, 3)}</strong>
			({km(factor.targetKm2)} km² at the outlet{factor.targetFrom === 'model' ? ', the model’s catchment area' : ''} ÷ its {km(factor.refKm2)} km²), the dashed
			line on the hydrograph.
		</p>
		<div class="table-wrap">
			<table class="data" data-testid="reference-table">
				<caption class="sr-only">The shown run against {name}, scaled by area, over the days both have a value</caption>
				<thead>
					<tr>
						<th scope="col">Model flow</th>
						<th scope="col">KGE′</th>
						<th scope="col">Volume bias</th>
						<th scope="col">Correlation r</th>
						<th scope="col">Days compared</th>
					</tr>
				</thead>
				<tbody>
					{#each [['Simulated (current day)', rows.simulated, 'simulated'], ['Natural', rows.natural, 'natural']] as const as [label, row, key] (key)}
						<tr data-row={key}>
							<th scope="row">{label}</th>
							{#if row}
								<td>{num(row.kge)}</td>
								<td>{pct(row.biasPct)}</td>
								<td>{num(row.r)}</td>
								<td>{fmtNum(row.days)} <span class="muted">({fmtDay(row.from!)} – {fmtDay(row.to!)})</span></td>
							{:else}
								<td colspan="4" class="muted">Not compared: the run has no such flow, or no day in common with the record.</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if monthly.length}
			<div class="monthly" data-testid="reference-monthly">
				<LineChart
					title="Monthly volume: {lineLabel}, simulated and natural flow at the outlet"
					toolsLabel="Monthly volume controls"
					unit={vol.text}
					height={240}
					series={monthChart.series}
					xy={monthChart.xy}
					xLabel="Month"
					xFormat={(i) => (monthly[Math.round(i)] ? monthLabel(monthly[Math.round(i)]!.month) : '')}
					pannable={false}
					caption="Each month’s volume over only the days all three flows have a value, so the three are like with like; a month with fewer than {MONTH_MIN_DAYS} such days is a gap, not a low value{gaps
						? ` (${gaps} ${gaps === 1 ? 'month' : 'months'} here)`
						: ''}. The reference record is dashed."
				/>
				<button type="button" class="btn btn-sm" aria-expanded={showMonths} aria-controls="ref-months" onclick={() => (showMonths = !showMonths)}
					>{showMonths ? 'Hide' : 'Show'} the monthly volumes</button
				>
				<div class="table-wrap" id="ref-months" hidden={!showMonths}>
					<table class="data" data-testid="reference-monthly-table">
						<caption>Monthly volume ({vol.text}) over the days all three flows have a value</caption>
						<thead>
							<tr>
								<th scope="col">Month</th>
								<th scope="col">{lineLabel}</th>
								<th scope="col">Simulated (current day)</th>
								<th scope="col">Natural</th>
								<th scope="col">Days compared</th>
							</tr>
						</thead>
						<tbody>
							{#each monthly as m (m.month)}
								<tr data-month={m.month}>
									<th scope="row">{monthLabel(m.month)}</th>
									{#if m.reference === null}
										<td colspan="3" class="muted">Gap: too few days in common</td>
									{:else}
										<td>{vfmt(m.reference)}</td>
										<td>{vfmt(m.simulated)}</td>
										<td>{vfmt(m.natural)}</td>
									{/if}
									<td>{m.days} of {m.daysInMonth}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}
		<p class="hint explain">
			Volume bias is the model’s volume against the scaled record’s over those days (positive: the model carries more). The current-day flow has the
			catchment’s use and dams in it, natural flow none; the neighbour has its own use, rain and soils, so read these as a check on the size and timing of
			flows, not a calibration score.
		</p>
	{/if}
</div>

<style>
	.ref-check {
		margin-top: 0.75rem;
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: 0.95rem;
	}
	.muted {
		color: var(--text-muted);
	}
	.table-wrap {
		overflow-x: auto;
	}
	.monthly {
		margin-top: 0.75rem;
	}
	.monthly > .btn {
		margin-top: 0.35rem;
	}
</style>
