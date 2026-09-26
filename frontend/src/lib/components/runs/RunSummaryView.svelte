<script module lang="ts">
	// Land cover, groundwater and other users' tables: a separate chunk (HumanImpactTables.svelte).
	// Exported so the printable report can load it before it says it is ready.
	export const loadHumanImpacts = () => import('./HumanImpactTables.svelte');
</script>

<script lang="ts">
	// Headline numbers, calibration fit and the per-farm table of one run.
	import type { RunSummary } from '@water-management/engine';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { describePbias, NSE_HELP, PBIAS_HELP } from './rating';
	import { m3DayToM3s, m3DayToMm3a, sortFarms, SUPPLY_TARGET, supplyBarFraction, type FarmSortKey } from './results';
	import { runSentence } from './runSentence';
	import { headlineSite } from './ewrAssurance';

	let {
		summary,
		days,
		nodeOrder = new Map()
	}: {
		summary: RunSummary;
		/** Days in the run (for "% of days"). */
		days: number;
		/** nodeId → network position, for the default farm order. */
		nodeOrder?: ReadonlyMap<string, number>;
	} = $props();

	const farms = $derived(summary.farms ?? []);
	// Farms and other users with boreholes (engine ≥ 0.23.0, WP-1.34).
	const pumping = $derived([...farms, ...(summary.users ?? [])].filter((f) => f.avgGroundwaterM3Day !== undefined));
	const shortCount = $derived(farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length);
	const totals = $derived({
		demand: farms.reduce((s, f) => s + f.avgDemandM3Day, 0),
		supplied: farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0),
		deficit: farms.reduce((s, f) => s + f.avgDeficitM3Day, 0),
		ewr: farms.reduce((s, f) => s + f.avgEwrShortfallM3Day, 0)
	});
	const cal = $derived(summary.calibration);
	// Reserve compliance by month (engine ≥ 0.21.0): the headline when the project has a rule table.
	const reserve = $derived(headlineSite(summary));
	const c = $derived(summary.catchment);
	// The cards below in one or two plain sentences (runs/runSentence.ts).
	const lede = $derived(runSentence(summary));

	let sortKey = $state<FarmSortKey>('network');
	let sortDir = $state<'asc' | 'desc'>('asc');
	const sorted = $derived(sortFarms(farms, sortKey, sortDir, nodeOrder));

	function sortBy(k: FarmSortKey) {
		if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		else {
			sortKey = k;
			// Worst first for the columns people scan for problems.
			sortDir = k === 'fractionSupplied' || k === 'name' ? 'asc' : 'desc';
		}
	}
	const ariaSort = (k: FarmSortKey) => (sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined);

	const COLS: { key: FarmSortKey; label: string; unit: string; title: string }[] = [
		{ key: 'avgDemandM3Day', label: 'Demand', unit: 'm³/day', title: 'Mean net irrigation demand over the run (after effective rainfall).' },
		{ key: 'avgSuppliedM3Day', label: 'Supplied', unit: 'm³/day', title: 'Mean irrigation water actually supplied from dam and river.' },
		{ key: 'avgDeficitM3Day', label: 'Deficit', unit: 'm³/day', title: 'Mean demand not supplied (demand − supplied).' },
		{ key: 'fractionSupplied', label: 'Supplied', unit: '% of demand', title: `Share of demand supplied; farms under ${SUPPLY_TARGET * 100} % are flagged.` },
		{ key: 'avgEwrShortfallM3Day', label: 'EWR charge', unit: 'm³/day', title: 'Mean share of the shortfall at the EWR sites below this farm that is charged to it, pro rata to its net impact (engine 0.17.0; older runs: the reach shortfall it adds).' },
		{ key: 'daysEwrNotMet', label: 'EWR charged', unit: 'days', title: 'Days on which this farm was charged part of an EWR shortfall (older runs: days it added to a reach shortfall).' }
	];
</script>

{#if summary.warnings?.length}
	<div class="alert alert-warning" role="status">
		<strong>{summary.warnings.length} warning{summary.warnings.length === 1 ? '' : 's'} from this run</strong>
		<ul>{#each summary.warnings as w, i (i)}<li>{w}</li>{/each}</ul>
	</div>
{/if}

<p class="lede">{lede}</p>

<h3>Catchment</h3>
<dl class="stats">
	<div class="stat">
		<dt>Mean natural flow <HelpTip key="catchment.meanNaturalFlowM3Day" /></dt>
		<dd>{fmtNum(m3DayToM3s(c.meanNaturalFlowM3Day), 3)}<small>m³/s</small></dd>
		<dd class="sub">{fmtNum(m3DayToMm3a(c.meanNaturalFlowM3Day), 2)} Mm³/a · {fmtNum(c.meanNaturalFlowM3Day)} m³/day</dd>
	</div>
	<div class="stat">
		<dt>Mean simulated outflow</dt>
		<dd>{fmtNum(m3DayToM3s(c.meanSimulatedOutflowM3Day), 3)}<small>m³/s</small></dd>
		<dd class="sub">
			{fmtNum(m3DayToMm3a(c.meanSimulatedOutflowM3Day), 2)} Mm³/a{#if c.meanNaturalFlowM3Day > 0} ·
				{fmtPct(c.meanSimulatedOutflowM3Day / c.meanNaturalFlowM3Day, 0)} of natural{/if}
		</dd>
	</div>
	{#if reserve}
		<div class="stat" class:flagged={reserve.overall.rate !== null && reserve.overall.rate < 1}>
			<dt>Reserve rules met <HelpTip key="reserve-compliance" /></dt>
			<dd>{reserve.overall.rate === null ? '–' : fmtPct(reserve.overall.rate)}<small>of months</small></dd>
			<dd class="sub">
				{fmtNum(reserve.overall.met)} of {fmtNum(reserve.overall.months)} months at {reserve.isOutlet ? 'the outlet' : reserve.name}{#if reserve.overall.longestNotMetRun > 1}
					· up to {fmtNum(reserve.overall.longestNotMetRun)} in a row not met{/if}
			</dd>
			<dd class="sub"><a href="#res-reserve">by month of the year</a></dd>
		</div>
	{/if}
	<div class="stat" class:flagged={c.ewrFractionDaysNotMet > 0.05}>
		<dt>{reserve ? 'Days below the pragmatic EWR' : 'EWR not met'} <HelpTip key="catchment.ewrFractionDaysNotMet" /></dt>
		<dd>{fmtPct(c.ewrFractionDaysNotMet)}<small>of days</small></dd>
		<dd class="sub">{fmtNum(c.ewrDaysNotMet)} of {fmtNum(days)} days at the outflow gauge</dd>
	</div>
	<div class="stat" class:flagged={shortCount > 0}>
		<dt>Irrigation supplied <HelpTip key="summary.fractionSupplied" /></dt>
		<dd>{totals.demand > 0 ? fmtPct(totals.supplied / totals.demand) : '–'}<small>of demand</small></dd>
		<dd class="sub">
			{shortCount ? `${shortCount} of ${farms.length} farms below ${fmtPct(SUPPLY_TARGET, 0)}` : `all farms ≥ ${fmtPct(SUPPLY_TARGET, 0)}`}
		</dd>
	</div>
	{#if cal && cal.days > 0}
		<div class="stat">
			<dt><span title={NSE_HELP}>Calibration NSE</span> <HelpTip key="stats.nse" /></dt>
			<dd>{fmtNum(cal.nse, 2)}</dd>
			<dd class="sub">{fmtNum(cal.days)} days observed</dd>
			<dd class="sub">calibration period (in-sample)</dd>
		</div>
		<div class="stat">
			<dt><span title={PBIAS_HELP}>Calibration PBIAS</span> <HelpTip key="stats.pbias" /></dt>
			<dd>{cal.pbias == null ? '–' : `${cal.pbias > 0 ? '+' : ''}${fmtNum(cal.pbias, 1)}`}<small>%</small></dd>
			{#if cal.pbias != null}<dd class="sub">{describePbias(cal.pbias)}</dd>{/if}
			<dd class="sub">calibration period (in-sample)</dd>
		</div>
	{:else}
		<div class="stat">
			<dt>Calibration</dt>
			<dd class="none">–</dd>
			<dd class="sub">no observed flow in the run</dd>
		</div>
	{/if}
</dl>

<h3>Farms</h3>
{#if farms.length === 0}
	<p class="muted">This run has no farm results.</p>
{:else}
	<div class="farm-head">
		<p class="muted small">
			{#if shortCount}
				<span class="flag-key" aria-hidden="true"></span>
				{shortCount} of {farms.length} farm{farms.length === 1 ? '' : 's'} received less than {fmtPct(SUPPLY_TARGET, 0)} of demand (highlighted).
			{:else}
				All farms received at least {fmtPct(SUPPLY_TARGET, 0)} of demand.
			{/if}
			Daily averages over the run; click a heading to sort.
		</p>
		{#if sortKey !== 'network'}
			<button type="button" class="btn btn-sm" onclick={() => ((sortKey = 'network'), (sortDir = 'asc'))}>Network order</button>
		{/if}
	</div>
	<div class="table-wrap">
		<table class="data farms">
			<thead>
				<tr>
					<th scope="col" aria-sort={ariaSort('name')}>
						<button type="button" class="sort" onclick={() => sortBy('name')}>Farm{#if sortKey === 'name'}<span class="dir" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}</button>
					</th>
					{#each COLS as col (col.key)}
						<th scope="col" class="num" aria-sort={ariaSort(col.key)} title={col.title}>
							<button type="button" class="sort" onclick={() => sortBy(col.key)}>
								{#if sortKey === col.key}<span class="dir" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}{col.label}<br /><span class="u">{col.unit}</span>
							</button>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each sorted as f (f.nodeId)}
					{@const short = f.fractionSupplied < SUPPLY_TARGET}
					<tr class:flag={short}>
						<th scope="row">
							{f.name}
							{#if short}<span class="badge badge-warn">below {fmtPct(SUPPLY_TARGET, 0)}</span>{/if}
						</th>
						<td class="num">{fmtNum(f.avgDemandM3Day)}</td>
						<td class="num">{fmtNum(f.avgSuppliedM3Day)}</td>
						<td class="num" class:neg={f.avgDeficitM3Day > 0.5}>{fmtNum(f.avgDeficitM3Day)}</td>
						<td class="num" class:short>
							<span class="supply">
								<span class="bar" aria-hidden="true"><span class="fill" style:width="{supplyBarFraction(f.fractionSupplied) * 100}%"></span></span>
								{fmtPct(f.fractionSupplied)}
							</span>
						</td>
						<td class="num">{fmtNum(f.avgEwrShortfallM3Day)}</td>
						<td class="num">{fmtNum(f.daysEwrNotMet)}</td>
					</tr>
				{/each}
			</tbody>
			<tfoot>
				<tr>
					<th scope="row">All farms</th>
					<td class="num">{fmtNum(totals.demand)}</td>
					<td class="num">{fmtNum(totals.supplied)}</td>
					<td class="num">{fmtNum(totals.deficit)}</td>
					<td class="num">{totals.demand > 0 ? fmtPct(totals.supplied / totals.demand) : '–'}</td>
					<td class="num">{fmtNum(totals.ewr)}</td>
					<td class="num"></td>
				</tr>
			</tfoot>
		</table>
	</div>
	<p class="muted small after">
		Annual totals: demand {fmtNum(m3DayToMm3a(totals.demand), 3)} Mm³/a, supplied {fmtNum(m3DayToMm3a(totals.supplied), 3)} Mm³/a,
		deficit {fmtNum(m3DayToMm3a(totals.deficit), 3)} Mm³/a ({fmtNum((totals.deficit * 1000) / 86_400, 1)} l/s).
	</p>
{/if}

{#if summary.landCover || summary.users?.length || pumping.length}
	<Lazy load={loadHumanImpacts}>
		{#snippet children(HumanImpactTables)}
			<HumanImpactTables {summary} />
		{/snippet}
	</Lazy>
{/if}

<style>
	.lede {
		margin: 0 0 0.9rem;
		max-width: 72ch;
		color: var(--text-2);
		font-size: 1rem;
		line-height: 1.55;
	}
	h3 {
		margin-top: 1.1rem;
	}
	h3:first-of-type {
		margin-top: 0;
	}
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	/* Six headline cards: 3 + 3 on a desktop results column, 2 + … on phones. */
	.stats {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
	}
	@media (max-width: 640px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.stat.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	.stat dt {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat dd.none {
		color: var(--text-muted);
	}
	.farm-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
	}
	.farm-head p {
		margin: 0 0 0.5rem;
	}
	.farms thead th {
		padding: 0;
	}
	.sort {
		all: unset;
		box-sizing: border-box;
		display: block;
		width: 100%;
		padding: 0.35rem 0.55rem;
		cursor: pointer;
		text-align: inherit;
		min-height: 36px;
	}
	.sort:hover {
		background: var(--row-hover);
	}
	.sort:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}
	.dir {
		font-size: 0.6rem;
		margin-right: 0.25rem;
		color: var(--accent);
	}
	td.short,
	td.neg {
		color: var(--warning);
		font-weight: 600;
	}
	/* Supplied % of demand: a small bar beside the number (the number is the content; the bar is aria-hidden). */
	.supply {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
	}
	.bar {
		flex: none;
		width: 3.5rem;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--success);
	}
	td.short .fill {
		background: var(--warning);
	}
	@media (max-width: 640px) {
		.bar {
			width: 2.25rem;
		}
	}
	@media (forced-colors: active) {
		.bar {
			border: 1px solid CanvasText;
		}
		.fill {
			background: CanvasText;
		}
	}
	.badge {
		margin-left: 0.35rem;
		text-transform: none;
	}
	.flag-key {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		background: var(--row-flag);
		border: 1px solid var(--warning);
		vertical-align: -1px;
		margin-right: 0.25rem;
	}
	.after {
		margin: 0.5rem 0 0;
	}
</style>
