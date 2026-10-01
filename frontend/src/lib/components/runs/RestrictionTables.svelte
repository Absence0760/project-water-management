<!--
	The drought restriction rule's results (engine ≥ 1.54.0, WP-3.8, docs/ui.md
	§ Drought restrictions): the days at each level per water year and over the
	run, and per hydrological unit its demand before and after the cut. Its own
	panel on Units & supply (#res-restrictions) and in the printable report;
	its own chunk (restrictions.ts loadRestrictionTables). A model rule, not the
	restriction notice farmers see.
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { foldList } from '$lib/components/common/fold';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { restrictionView } from './restrictions';

	let {
		summary,
		headingId = 'res-restrictions-h',
		level = 2
	}: {
		summary: RunSummary;
		headingId?: string;
		/** The heading's level: 2 as a Units & supply panel, 3 among the printable report's tables. */
		level?: 2 | 3;
	} = $props();

	const uid = $props.id();
	const YEAR_CAP = 10;
	const UNIT_CAP = 10;
	let yearsAll = $state(false);
	let unitsAll = $state(false);
	// Node ids in the rule's words (its dams, units, EWR site) by name, from the run's own units.
	const names = $derived(new Map((summary.farms ?? []).map((f) => [f.nodeId, f.name])));
	const v = $derived(restrictionView(summary.droughtRestriction, (id) => names.get(id) ?? id));
	const yearFold = $derived(v ? foldList(v.years, (y) => y.label, null, yearsAll, YEAR_CAP) : { shown: [], hidden: 0 });
	const unitFold = $derived(v ? foldList(v.units, (u) => u.nodeId, null, unitsAll, UNIT_CAP) : { shown: [], hidden: 0 });
</script>

{#if v}
	<svelte:element this={`h${level}`} id={headingId}>Drought restrictions</svelte:element>
	<p class="muted small" data-testid="restriction-rule">
		The model’s restriction rule ({v.rule}{v.source ? `; from ${v.source}` : ''}), decided {v.reviews}
		{v.reviews === 1 ? 'time' : 'times'} in the run from the farm dams’ storage at the start of the review day{v.ewrReviews !== null
			? `, ${v.ewrReviews} of them after a day the EWR trigger’s site wasn’t met`
			: ''}. A model rule, not the restriction notice farmers see.
	</p>
	<div class="table-wrap">
		<table class="data restriction-days" id="{uid}-years" data-testid="restriction-days-table">
			<caption class="visually-hidden">Days at each drought restriction level, by water year</caption>
			<thead>
				<tr>
					<th scope="col">Water year</th>
					<th scope="col" class="num">Days</th>
					{#each v.levels as l (l)}<th scope="col" class="num">{l}</th>{/each}
					<th scope="col" class="num">Days restricted</th>
				</tr>
			</thead>
			<tbody>
				{#each yearFold.shown as y (y.label)}
					<tr>
						<th scope="row">{y.label}</th>
						<td class="num">{y.days}</td>
						{#each y.byLevel as d, i (i)}<td class="num">{d}</td>{/each}
						<td class="num">{y.restricted}</td>
					</tr>
				{/each}
				<tr class="total">
					<th scope="row">Whole run</th>
					<td class="num">{v.total.days}</td>
					{#each v.total.byLevel as d, i (i)}<td class="num">{d}</td>{/each}
					<td class="num">{v.total.restricted}</td>
				</tr>
			</tbody>
		</table>
	</div>
	{#if yearsAll || yearFold.hidden}
		<button type="button" class="btn btn-sm more" aria-expanded={yearsAll} aria-controls="{uid}-years" onclick={() => (yearsAll = !yearsAll)}>
			{yearsAll ? 'Show fewer water years' : `Show all ${fmtNum(v.years.length)} water years`}
		</button>
	{/if}
	<p class="muted small">
		Each hydrological unit, the most cut first: its demand, what it asked its sources for after the restriction and what it was supplied,
		daily averages over the whole run; and the cut on the restricted days alone, which the averages dilute with every unrestricted day. The
		cut shows as a shortfall: supplied is measured against the full demand.
	</p>
	<div class="table-wrap">
		<table class="data restriction-units" id="{uid}-units" data-testid="restriction-units-table">
			<caption class="visually-hidden">Each hydrological unit’s demand before and after the drought restriction</caption>
			<thead>
				<tr>
					<th scope="col">Hydrological unit</th>
					<th scope="col" class="num">Demand<br /><span class="u">m³/day, run mean</span></th>
					<th scope="col" class="num">After the restriction<br /><span class="u">m³/day, run mean</span></th>
					<th scope="col" class="num">Cut<br /><span class="u">m³/day, run mean</span></th>
					<th scope="col" class="num">Cut<br /><span class="u">% of demand</span></th>
					<th scope="col" class="num">Cut on restricted days<br /><span class="u">m³/day</span></th>
					<th scope="col" class="num">Supplied<br /><span class="u">m³/day, run mean</span></th>
					<th scope="col" class="num">Days restricted</th>
				</tr>
			</thead>
			<tbody>
				{#each unitFold.shown as u (u.nodeId)}
					<tr>
						<th scope="row">{u.name}</th>
						<td class="num">{fmtNum(u.demand)}</td>
						<td class="num">{fmtNum(u.restricted)}</td>
						<td class="num">{fmtNum(u.cut)}</td>
						<td class="num">{fmtPct(u.cutShare)}</td>
						<td class="num">{u.cutOnRestrictedDays === null ? '–' : fmtNum(u.cutOnRestrictedDays)}</td>
						<td class="num">{fmtNum(u.supplied)}</td>
						<td class="num">{u.daysRestricted ?? '–'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if unitsAll || unitFold.hidden}
		<button type="button" class="btn btn-sm more" aria-expanded={unitsAll} aria-controls="{uid}-units" onclick={() => (unitsAll = !unitsAll)}>
			{unitsAll ? 'Show fewer hydrological units' : `Show all ${fmtNum(v.units.length)} hydrological units`}
		</button>
	{/if}
{/if}

<style>
	.total th,
	.total td {
		font-weight: 600;
		border-top: 2px solid var(--border);
	}
	.more {
		margin: 0.25rem 0 0.75rem;
	}
</style>
