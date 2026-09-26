<script lang="ts">
	// The human-impact tables of a run (engine ≥ 0.22.0): land cover (WP-1.35),
	// groundwater (WP-1.34) and other water users (WP-1.33). Code-split out of
	// RunSummaryView and loaded only for a run that has any of them, so the
	// Runs tab stays within its chunk budget for every other project.
	import { LAND_COVER_CLASSES, type RunSummary } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { SUPPLY_TARGET } from './results';
	import { groundwaterByNode } from './groundwater';

	let { summary }: { summary: RunSummary } = $props();

	// Farms and other users with boreholes (engine ≥ 0.23.0, WP-1.34).
	const pumping = $derived([...(summary.farms ?? []), ...(summary.users ?? [])].filter((f) => f.avgGroundwaterM3Day !== undefined));
	// Their use per water year against the caps and the GN 538 ceiling (engine ≥ 0.36.0, WP-3.9).
	const annual = $derived(groundwaterByNode(summary.groundwaterAnnualUse));
	const m3 = (v: number | null) => (v === null ? '–' : fmtNum(v, 0));
</script>

{#if summary.landCover}
	{@const lc = summary.landCover}
	<h3>Land cover</h3>
	<p class="muted small">
		Invasive plants and forestry took {fmtNum(lc.reductionM3Day)} m³/day of natural flow on average{lc.fractionOfNatural !== null ? ` (${fmtPct(lc.fractionOfNatural, 1)} of it)` : ''}
		before it reached the units. Low flows are the flow exceeded 75 % of the days ({fmtNum(lc.lowFlowThresholdM3Day)} m³/day).
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
					<th scope="col">Unit or user</th>
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
	{#if annual.length}
		<h4>Groundwater by water year</h4>
		<p class="muted small" data-testid="gw-annual-note">
			Modelled use per water year (October to September) against the boreholes' annual caps. For context, the GN 538 general
			authorisation allows a property up to {fmtNum(annual[0]!.years[0]!.gaLimitM3, 0)} m³/a of groundwater, depending on its size:
			the app shows modelled use against that ceiling and never decides whether a use is lawful.
		</p>
		<p class="muted small low-confidence" role="note">
			<span class="badge badge-warn">Low confidence</span> Depletion is a fixed fraction, not an aquifer model. Attach the geohydrology report.
		</p>
		<div class="table-wrap">
			<table class="data groundwater-annual">
				<thead>
					<tr>
						<th scope="col">Unit or user</th>
						<th scope="col" class="num">Mean pumped<br /><span class="u">m³/a</span></th>
						<th scope="col" class="num">Most in a year<br /><span class="u">m³</span></th>
						<th scope="col" class="num">Annual caps<br /><span class="u">m³/a</span></th>
						<th scope="col" class="num">Years above the GN 538 ceiling</th>
						<th scope="col" class="num">Years a cap was reached</th>
					</tr>
				</thead>
				<tbody>
					{#each annual as g (g.nodeId)}
						<tr class:flag={g.yearsAboveGa > 0}>
							<th scope="row">{g.name}</th>
							<td class="num">{fmtNum(g.meanM3Year, 0)}</td>
							<td class="num">{fmtNum(g.maxYear.abstractionM3, 0)} <span class="muted">({g.maxYear.label})</span></td>
							<td class="num">{m3(g.years[0]!.annualCapM3)}</td>
							<td class="num" class:neg={g.yearsAboveGa > 0}>{g.yearsAboveGa} of {g.years.length}</td>
							<td class="num">{g.yearsCapReached} of {g.years.length}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#each annual as g (g.nodeId)}
			<details class="years">
				<summary>{g.name}: each water year and borehole</summary>
				<div class="table-wrap">
					<table class="data">
						<thead>
							<tr>
								<th scope="col">Water year</th>
								<th scope="col" class="num">Days</th>
								<th scope="col" class="num">Pumped<br /><span class="u">m³</span></th>
								<th scope="col" class="num">Into the dam<br /><span class="u">m³</span></th>
								<th scope="col" class="num">Stream depletion<br /><span class="u">m³</span></th>
								{#each g.years[0]!.boreholes as b, k (k)}
									<th scope="col" class="num">{b.name}<br /><span class="u">m³{b.annualCapM3 !== null ? ` of ${fmtNum(b.annualCapM3, 0)}` : ''}</span></th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each g.years as y (y.waterYear)}
								<tr>
									<th scope="row">{y.label}</th>
									<td class="num">{y.days}</td>
									<td class="num" class:neg={y.abstractionM3 > y.gaLimitM3}>{fmtNum(y.abstractionM3, 0)}</td>
									<td class="num">{fmtNum(y.toDamM3, 0)}</td>
									<td class="num">{fmtNum(y.streamDepletionM3, 0)}</td>
									{#each y.boreholes as b, k (k)}
										<td class="num">{fmtNum(b.abstractionM3, 0)}{#if b.capReached}<span class="badge badge-warn">cap</span>{/if}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>
		{/each}
	{/if}
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
	h4 {
		margin: 0.9rem 0 0.3rem;
	}
	.years summary {
		cursor: pointer;
		font-size: 0.85rem;
		min-height: 24px;
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
