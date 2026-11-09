<!--
	The daily EWR in use, judged month by month at the outlet (engine ≥ 1.116.0, RunSummary.ewrDailyMonths,
	docs/model.md §2.9h): the months met, the longest run not met, the deficit, the share met per month of the
	year (chart and table). Named for the run's daily EWR source (the pragmatic EWR, the DRM TAB file or the DRM
	percentile tables, summary.catchment.outletEwr), so a change of Model settings → EWR → Daily EWR from shows here
	after a re-run. The Reserve rule tables keep their own judgement (runs/EwrAssurancePanel.svelte), a switch away on
	EWR (river/ReserveMonths.svelte). A run without the
	field (older, or kept from this reader) says why.
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import type { Snippet } from 'svelte';
	import { fmtNum, fmtPct } from '#lib/format/number.js';
	import { monthName } from '#lib/format/months.js';
	import { fmtFlow, fmtMm3 } from '#lib/components/runs/ewrAssurance.js';
	import { dailyEwrName, dailyMonthsHeading } from './notMet';
	import { dailyMonthsMissing, dailyMonthsVerdict, rateClass, zeroRequirementText } from './dailyMonths';

	let {
		summary,
		controls
	}: {
		summary: Pick<RunSummary, 'ewrDailyMonths' | 'catchment' | 'ewrCompliance' | 'allocations'>;
		/** Under the heading: EWR's "Judged by" switch when the run has a Reserve rule table too (river/ReserveMonths.svelte). */
		controls?: Snippet;
	} = $props();

	const uid = $props.id();
	const r = $derived(summary.ewrDailyMonths ?? null);
	const daily = $derived(summary.catchment.outletEwr);
	const heading = $derived(dailyMonthsHeading(daily));
	const outlet = $derived(summary.ewrCompliance?.outlet?.name ?? null);
	const zero = $derived(r ? zeroRequirementText(r) : null);

	// The chart: share of months met per month of the year, on a fixed 0–100 % axis (as the rule tables' panel).
	const W = 480;
	const H = 150;
	const TOP = 16;
	const BOTTOM = 18;
	const bw = W / 12;
</script>

<section aria-labelledby="{uid}-h" data-testid="ewr-daily-months">
	<h2 id="{uid}-h">{heading}</h2>
	{#if controls}{@render controls()}{/if}
	<p class="muted small">
		Each whole calendar month at the outlet: met when the simulated outflow over the month is at least {dailyEwrName(daily)} summed over its days. It
		follows Model settings → EWR → Daily EWR from; a change there shows here after the model runs again.
	</p>
	{#if !r}
		<p class="muted" data-testid="ewr-daily-months-missing">{dailyMonthsMissing(summary)}</p>
	{:else}
		<p class="flag {rateClass(r.rate)}" role="status">
			<strong>{outlet ? `Outlet (${outlet})` : 'Outlet'}:</strong>
			{dailyMonthsVerdict(r)}
		</p>

		<dl class="stats">
			<div class="stat">
				<dt>Months met</dt>
				<dd>{r.rate === null ? '–' : fmtPct(r.rate)}</dd>
				<dd class="sub">{fmtNum(r.met)} of {fmtNum(r.months)}</dd>
			</div>
			<div class="stat">
				<dt>Longest run not met</dt>
				<dd>{fmtNum(r.longestNotMetRun)}<small>months</small></dd>
				<dd class="sub">consecutive months below the requirement</dd>
			</div>
			<div class="stat">
				<dt>Deficit</dt>
				<dd>{fmtMm3(r.deficitM3)}<small>Mm³</small></dd>
				<dd class="sub">the months’ shortfalls below the requirement, summed</dd>
			</div>
		</dl>
		{#if zero}<p class="muted small">{zero}</p>{/if}

		<svg viewBox="0 0 {W} {H}" class="bars" role="img" aria-label="Share of months met per month of the year at the outlet (the table below holds the values)">
			{#each [0, 0.5, 1] as g (g)}
				<line x1="0" x2={W} y1={H - BOTTOM - g * (H - BOTTOM - TOP)} y2={H - BOTTOM - g * (H - BOTTOM - TOP)} class="grid" />
			{/each}
			{#each r.byMonth as m, i (m.month)}
				{@const h = (m.rate ?? 0) * (H - BOTTOM - TOP)}
				<g>
					<title>{monthName(m.month)}: {m.rate === null ? 'not assessed' : `${fmtNum(m.met)} of ${fmtNum(m.years)} met`}</title>
					{#if m.rate !== null}
						<rect x={i * bw + 5} y={H - BOTTOM - h} width={bw - 10} height={Math.max(h, 1)} rx="2" class={rateClass(m.rate)} />
						<text x={i * bw + bw / 2} y={H - BOTTOM - h - 3} class="v">{fmtNum(m.rate * 100, 0)}</text>
					{:else}
						<text x={i * bw + bw / 2} y={H - BOTTOM - 3} class="v">–</text>
					{/if}
					<text x={i * bw + bw / 2} y={H - 4} class="m">{monthName(m.month)}</text>
				</g>
			{/each}
			<text x="2" y="10" class="axis">% of months met</text>
		</svg>

		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-moy">
				<caption id="{uid}-moy">By month of the year: months met and mean flows (m³/s)</caption>
				<thead>
					<tr>
						<th scope="col">Month</th>
						<th scope="col" class="num">Years</th>
						<th scope="col" class="num">Met</th>
						<th scope="col" class="num">Met <span class="u">%</span></th>
						<th scope="col" class="num">Mean required <span class="u">m³/s</span></th>
						<th scope="col" class="num">Mean simulated <span class="u">m³/s</span></th>
						<th scope="col" class="num">Deficit <span class="u">Mm³</span></th>
					</tr>
				</thead>
				<tbody>
					{#each r.byMonth as m (m.month)}
						<tr>
							<th scope="row">{monthName(m.month)}</th>
							<td class="num">{fmtNum(m.years)}</td>
							<td class="num">{m.years ? fmtNum(m.met) : '–'}</td>
							<td class="num" class:short={m.rate !== null && m.rate < 1}>{m.rate === null ? '–' : fmtPct(m.rate, 0)}</td>
							<td class="num">{fmtFlow(m.meanRequiredM3s)}</td>
							<td class="num">{fmtFlow(m.meanSimulatedM3s)}</td>
							<td class="num">{m.years ? fmtMm3(m.deficitM3) : '–'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.flag {
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius, 6px);
		border-left: 4px solid var(--border-strong);
		background: var(--surface-2);
		margin: 0.5rem 0;
	}
	.flag.good {
		border-left-color: var(--success);
	}
	.flag.ok {
		border-left-color: var(--warning);
	}
	.flag.bad {
		border-left-color: var(--danger);
	}
	.stats {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
	}
	.stat dd.sub {
		font-size: var(--font-xs);
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.bars {
		width: 100%;
		max-width: 560px;
		height: auto;
		display: block;
		margin: 0.75rem 0;
	}
	.bars rect.good {
		fill: var(--success);
	}
	.bars rect.ok {
		fill: var(--warning);
	}
	.bars rect.bad {
		fill: var(--danger);
	}
	.grid {
		stroke: var(--border);
	}
	.v,
	.m {
		font-size: 10px;
		text-anchor: middle;
		fill: var(--text-2);
	}
	.m {
		fill: var(--text-muted);
	}
	.axis {
		font-size: 10px;
		fill: var(--text-muted);
	}
	td.short {
		color: var(--warning);
		font-weight: 600;
	}
</style>
