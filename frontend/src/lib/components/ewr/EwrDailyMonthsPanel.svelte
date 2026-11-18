<!--
	The daily EWR in use, judged month by month at the outlet (engine ≥ 1.116.0, RunSummary.ewrDailyMonths,
	docs/model.md §2.9h): the months met, the longest run not met, the deficit, the share met per month of the
	year (chart and table). Named for the run's daily EWR source (the pragmatic EWR, the DRM TAB file or the DRM
	percentile tables, summary.catchment.outletEwr), so a change of Model settings → EWR → Daily EWR from shows here
	after a re-run. The Reserve rule tables keep their own judgement (runs/EwrAssurancePanel.svelte), a switch away on
	EWR (river/ReserveMonths.svelte). A run without the
	field (older, or kept from this reader) says why.
	At a hydrological unit instead (`unit`, ewr/EwrDailyMonthsAt.svelte works its months out from the unit's stored
	series, ewr/unitMonths.ts): the same tiles, chart and table, named for the unit, its flow and its share of the
	daily EWR.
-->
<script lang="ts">
	import type { EwrDailyMonths, RunSummary } from '@water-management/engine';
	import type { Snippet } from 'svelte';
	import { fmtNum, fmtPct } from '#lib/format/number.js';
	import { monthName } from '#lib/format/months.js';
	import { fmtFlow, fmtMm3 } from '#lib/components/runs/ewrAssurance.js';
	import { dailyEwrName, dailyMonthsHeading } from './notMet';
	import { dailyMonthsMissing, dailyMonthsVerdict, rateClass, zeroRequirementText } from './dailyMonths';
	import { placeWords, type UnitChoice } from './unitMonths';

	let {
		summary,
		controls,
		compact = false,
		title,
		level = 3,
		missing,
		unit = null,
		result,
		unavailable
	}: {
		summary: Pick<RunSummary, 'ewrDailyMonths' | 'catchment' | 'ewrCompliance' | 'allocations'>;
		/** Under the heading: EWR's "Judged by" switch when the run has a Reserve rule table too (river/ReserveMonths.svelte). */
		controls?: Snippet;
		/**
		 * One side of two read side by side (scenarios/ScenarioEwrMonths.svelte): an h3 named `title`, no
		 * explanation (the pair says it once), the tiles first and the chart under them so both sides' line up
		 * whatever their verdicts' lengths, then the verdict, and the table folded.
		 */
		compact?: boolean;
		/** The heading in compact mode (the run's name and date), and its level. */
		title?: string;
		level?: 3 | 4;
		/** After the missing-run line: what to do about it (the base run's "Run the model"). */
		missing?: Snippet;
		/** Judged at this unit rather than the outlet (null: the outlet). */
		unit?: UnitChoice | null;
		/** The unit's months (ewr/unitMonths.ts); left out, the run's own outlet months. */
		result?: EwrDailyMonths | null;
		/** Why there are no months to show here (loading, a unit this run hasn't): said instead of the re-run line. */
		unavailable?: string;
	} = $props();

	const uid = $props.id();
	const r = $derived(result !== undefined ? result : (summary.ewrDailyMonths ?? null));
	const place = $derived(placeWords(unit));
	const daily = $derived(summary.catchment.outletEwr);
	const heading = $derived(dailyMonthsHeading(daily));
	const outlet = $derived(summary.ewrCompliance?.outlet?.name ?? null);
	const zero = $derived(r ? zeroRequirementText(r) : null);

	// The chart: share of months met per month of the year, on a fixed 0–100 % axis (as the rule tables' panel).
	// Narrower in compact mode, so a side's half-width column draws the months' names near their full size.
	const W = $derived(compact ? 360 : 480);
	const H = 150;
	// Compact: room for the axis title over a full bar's value.
	const TOP = $derived(compact ? 26 : 16);
	const BOTTOM = 18;
	const bw = $derived(W / 12);
</script>

<section aria-labelledby="{uid}-h" data-testid="ewr-daily-months">
	{#if compact}
		<svelte:element this={`h${level}`} id="{uid}-h" class="side-h" {title}>{title ?? heading}</svelte:element>
	{:else}
		<h2 id="{uid}-h">{heading}</h2>
	{/if}
	{#if controls}{@render controls()}{/if}
	{#if !compact}<p class="muted small">
		Each whole calendar month at {place.where}: met when {place.flow} over the month is at least {place.requirement(dailyEwrName(daily))} summed over its days. It
		follows Model settings → EWR → Daily EWR from; a change there shows here after the model runs again.
	</p>{/if}
	{#if !r}
		<p class="muted" data-testid="ewr-daily-months-missing">{unavailable ?? dailyMonthsMissing(summary)}{#if missing && unavailable === undefined}{' '}{@render missing()}{/if}</p>
	{:else}
		{#if !compact}{@render verdict(r)}{/if}

		<dl class="stats" class:compact>
			<div class="stat">
				<dt>Months met</dt>
				<dd>{r.rate === null ? '–' : fmtPct(r.rate)}</dd>
				<dd class="sub">{fmtNum(r.met)} of {fmtNum(r.months)}</dd>
			</div>
			<div class="stat">
				<dt>Longest run not met</dt>
				<dd>{fmtNum(r.longestNotMetRun)}<small>months</small></dd>
				<dd class="sub long">consecutive months below the requirement</dd>
			</div>
			<div class="stat">
				<dt>Deficit</dt>
				<dd>{fmtMm3(r.deficitM3)}<small>Mm³</small></dd>
				<dd class="sub long">the months’ shortfalls below the requirement, summed</dd>
			</div>
		</dl>
		{#if zero && !compact}<p class="muted small">{zero}</p>{/if}

		<svg viewBox="0 0 {W} {H}" class="bars" role="img" aria-label="Share of months met per month of the year at {place.where} (the table below holds the values)">
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
		{#if compact}
			{@render verdict(r)}
			{#if zero}<p class="muted small">{zero}</p>{/if}
		{/if}

		{#if compact}
			<details class="values">
				<summary>Values by month</summary>
				{@render values(r)}
			</details>
		{:else}
			{@render values(r)}
		{/if}
	{/if}
</section>

{#snippet verdict(r: EwrDailyMonths)}
	<p class="flag {rateClass(r.rate)}" role="status">
		<strong>{unit ? unit.name : outlet ? `Outlet (${outlet})` : 'Outlet'}:</strong>
		{dailyMonthsVerdict(r)}
	</p>
{/snippet}

{#snippet values(r: EwrDailyMonths)}
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
{/snippet}

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
	/* Compact: the three tiles in one row of a half-width column, without their long explanations. */
	.stats.compact {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
	.stats.compact dd {
		overflow-wrap: anywhere;
	}
	.stats.compact .sub.long {
		display: none;
	}
	.side-h {
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.values summary {
		cursor: pointer;
		font-size: var(--font-sm);
	}
	td.short {
		color: var(--warning);
		font-weight: 600;
	}
</style>
