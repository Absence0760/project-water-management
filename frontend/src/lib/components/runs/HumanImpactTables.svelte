<script lang="ts">
	// The human-impact tables of a run (engine ≥ 0.22.0): land cover (WP-1.35),
	// groundwater (WP-1.34) and other water users (WP-1.33). Code-split out of
	// RunSummaryView and loaded only for a run that has any of them, so the
	// Runs tab stays within its chunk budget for every other project.
	import { LAND_COVER_CLASSES, type RunSummary } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { SUPPLY_TARGET } from './results';

	let { summary }: { summary: RunSummary } = $props();

	// Farms and other users with boreholes (engine ≥ 0.23.0, WP-1.34).
	const pumping = $derived([...(summary.farms ?? []), ...(summary.users ?? [])].filter((f) => f.avgGroundwaterM3Day !== undefined));
</script>

{#if summary.landCover}
	{@const lc = summary.landCover}
	<h3>Land cover</h3>
	<p class="muted small">
		Invasive plants and forestry took {fmtNum(lc.reductionM3Day)} m³/day of natural flow on average{lc.fractionOfNatural !== null ? ` (${fmtPct(lc.fractionOfNatural, 1)} of it)` : ''}
		before it reached the farms. Low flows are the flow exceeded 75 % of the days ({fmtNum(lc.lowFlowThresholdM3Day)} m³/day).
	</p>
	<div class="table-wrap">
		<table class="data land-cover">
			<thead>
				<tr>
					<th scope="col">Cover class</th>
					<th scope="col" class="num">Condensed area<br /><span class="u">km²</span></th>
					<th scope="col" class="num">Reduction<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Over the condensed area<br /><span class="u">mm/yr</span></th>
				</tr>
			</thead>
			<tbody>
				{#each lc.byClass as c (c.coverClass)}
					<tr>
						<th scope="row">{LAND_COVER_CLASSES.find((x) => x.id === c.coverClass)?.label ?? c.coverClass}</th>
						<td class="num">{fmtNum(c.condensedKm2, 2)}</td>
						<td class="num">{fmtNum(c.reductionM3Day)}</td>
						<td class="num">{c.mmPerYear === null ? '–' : fmtNum(c.mmPerYear, 0)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if pumping.length}
	<h3>Groundwater</h3>
	<p class="muted small">
		Boreholes: groundwater pumped (part of supplied) and the stream depletion it causes in the river below (daily averages over the run).
	</p>
	<div class="table-wrap">
		<table class="data groundwater">
			<thead>
				<tr>
					<th scope="col">Farm or user</th>
					<th scope="col" class="num">Pumped<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Share of supplied<br /><span class="u">%</span></th>
					<th scope="col" class="num">Stream depletion<br /><span class="u">m³/day</span></th>
				</tr>
			</thead>
			<tbody>
				{#each pumping as g (g.nodeId)}
					<tr>
						<th scope="row">{g.name}</th>
						<td class="num">{fmtNum(g.avgGroundwaterM3Day ?? 0)}</td>
						<td class="num">{g.avgSuppliedM3Day > 0 ? fmtPct((g.avgGroundwaterM3Day ?? 0) / g.avgSuppliedM3Day) : '–'}</td>
						<td class="num">{fmtNum(g.avgBaseflowDepletionM3Day ?? 0)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if summary.users?.length}
	<h3>Other water users</h3>
	<p class="muted small">Towns, industry and unlisted users taking water from the river (daily averages over the run).</p>
	<div class="table-wrap">
		<table class="data users">
			<thead>
				<tr>
					<th scope="col">User</th>
					<th scope="col">Priority</th>
					<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Taken<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Deficit<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Supplied<br /><span class="u">% of demand</span></th>
					<th scope="col" class="num">Returned<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">EWR charge<br /><span class="u">m³/day</span></th>
				</tr>
			</thead>
			<tbody>
				{#each summary.users as u (u.nodeId)}
					{@const short = u.fractionSupplied < SUPPLY_TARGET}
					<tr class:flag={short}>
						<th scope="row">{u.name}{#if short}<span class="badge badge-warn">below {fmtPct(SUPPLY_TARGET, 0)}</span>{/if}</th>
						<td>{u.priority}</td>
						<td class="num">{fmtNum(u.avgDemandM3Day)}</td>
						<td class="num">{fmtNum(u.avgSuppliedM3Day)}</td>
						<td class="num" class:neg={u.avgDeficitM3Day > 0.5}>{fmtNum(u.avgDeficitM3Day)}</td>
						<td class="num" class:short>{fmtPct(u.fractionSupplied)}</td>
						<td class="num">{fmtNum(u.avgReturnedM3Day)}</td>
						<td class="num">{fmtNum(u.avgEwrChargeM3Day)}</td>
					</tr>
				{/each}
			</tbody>
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
	td.short,
	td.neg {
		color: var(--warning);
		font-weight: 600;
	}
	.badge {
		margin-left: 0.35rem;
		text-transform: none;
	}
</style>
