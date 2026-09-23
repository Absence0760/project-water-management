<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';

	let { summary }: { summary: RunSummary } = $props();

	const SUPPLY_TARGET = 0.95;
	const farms = $derived(summary.farms ?? []);
	const shortCount = $derived(farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length);
	const totals = $derived({
		demand: farms.reduce((s, f) => s + f.avgDemandM3Day, 0),
		supplied: farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0),
		deficit: farms.reduce((s, f) => s + f.avgDeficitM3Day, 0)
	});
	const cal = $derived(summary.calibration);
</script>

{#if summary.warnings?.length}
	<div class="alert alert-warning" role="status">
		<strong>{summary.warnings.length} warning{summary.warnings.length === 1 ? '' : 's'} from this run</strong>
		<ul>{#each summary.warnings as w, i (i)}<li>{w}</li>{/each}</ul>
	</div>
{/if}

<h3>Catchment</h3>
<dl class="stats">
	<div class="stat"><dt>Mean natural flow</dt><dd>{fmtNum(summary.catchment.meanNaturalFlowM3Day)}<small>m³/day</small></dd></div>
	<div class="stat"><dt>Mean simulated outflow</dt><dd>{fmtNum(summary.catchment.meanSimulatedOutflowM3Day)}<small>m³/day</small></dd></div>
	<div class="stat"><dt>Days EWR not met</dt><dd>{fmtNum(summary.catchment.ewrDaysNotMet)}<small>days</small></dd></div>
	<div class="stat"><dt>Share of days EWR not met</dt><dd>{fmtPct(summary.catchment.ewrFractionDaysNotMet)}</dd></div>
</dl>

<h3>Calibration against observed flow</h3>
{#if cal && cal.days > 0}
	<dl class="stats">
		<div class="stat"><dt>Overlapping days</dt><dd>{fmtNum(cal.days)}</dd></div>
		<div class="stat"><dt>Nash–Sutcliffe (NSE)</dt><dd>{fmtNum(cal.nse, 3)}</dd></div>
		<div class="stat"><dt>Percent bias</dt><dd>{cal.pbias == null ? '–' : `${fmtNum(cal.pbias, 1)}%`}</dd></div>
		<div class="stat"><dt>RMSE</dt><dd>{fmtNum(cal.rmseM3s, 3)}<small>m³/s</small></dd></div>
		<div class="stat"><dt>Mean observed</dt><dd>{fmtNum(cal.meanObservedM3s, 3)}<small>m³/s</small></dd></div>
		<div class="stat"><dt>Mean simulated</dt><dd>{fmtNum(cal.meanSimulatedM3s, 3)}<small>m³/s</small></dd></div>
	</dl>
{:else}
	<p class="muted">No observed flow overlaps the simulation period, so calibration statistics aren't available.</p>
{/if}

<h3>Farms</h3>
{#if farms.length === 0}
	<p class="muted">This run has no farm results.</p>
{:else}
	<p class="muted small">
		{#if shortCount}
			<span class="flag-key" aria-hidden="true"></span>
			{shortCount} of {farms.length} farm{farms.length === 1 ? '' : 's'} received less than {fmtPct(SUPPLY_TARGET, 0)} of demand (highlighted).
		{:else}
			All farms received at least {fmtPct(SUPPLY_TARGET, 0)} of demand.
		{/if}
		Values are daily averages over the run.
	</p>
	<div class="table-wrap">
		<table class="data">
			<thead>
				<tr>
					<th scope="col">Farm</th>
					<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Supplied<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Deficit<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Supplied<br /><span class="u">% of demand</span></th>
					<th scope="col" class="num">EWR shortfall<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">EWR not met<br /><span class="u">days</span></th>
				</tr>
			</thead>
			<tbody>
				{#each farms as f (f.nodeId)}
					{@const short = f.fractionSupplied < SUPPLY_TARGET}
					<tr class:flag={short}>
						<th scope="row">
							{f.name}
							{#if short}<span class="badge badge-warn">below {fmtPct(SUPPLY_TARGET, 0)}</span>{/if}
						</th>
						<td class="num">{fmtNum(f.avgDemandM3Day)}</td>
						<td class="num">{fmtNum(f.avgSuppliedM3Day)}</td>
						<td class="num">{fmtNum(f.avgDeficitM3Day)}</td>
						<td class="num" class:short>{fmtPct(f.fractionSupplied)}</td>
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
					<td class="num"></td>
					<td class="num"></td>
				</tr>
			</tfoot>
		</table>
	</div>
{/if}

<style>
	h3 {
		margin-top: 1.1rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	td.short {
		color: var(--warning);
		font-weight: 600;
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
</style>
