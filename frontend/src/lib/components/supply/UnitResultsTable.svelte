<script lang="ts">
	// The per-unit table of one run: whole-record demand, supply, deficit,
	// share supplied (with its bar) and EWR charge, sortable, with the totals.
	// Moved from the Runs tab's summary to Units & supply (issue #17); the
	// printable report still shows it under the run summary.
	import type { FarmSummary } from '@water-management/engine';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { m3DayToMm3a, sortFarms, SUPPLY_TARGET, supplyBarFraction, type FarmSortKey } from '$lib/components/runs/results';

	let {
		farms,
		days,
		nodeOrder = new Map(),
		startDate,
		endDate,
		heading = 'h3',
		title = 'Hydrological units',
		headingId
	}: {
		farms: readonly FarmSummary[];
		/** Days in the run. */
		days: number;
		/** nodeId → network position, for the default order. */
		nodeOrder?: ReadonlyMap<string, number>;
		/** The run's first and last day: the period the figures cover (issue #44). */
		startDate?: string;
		endDate?: string;
		/** The heading's level: h3 in the report's run summary, h2 on Units & supply. */
		heading?: 'h2' | 'h3';
		title?: string;
		/** For the panel around it to be named by the heading. */
		headingId?: string;
	} = $props();

	const shortCount = $derived(farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length);
	const totals = $derived({
		demand: farms.reduce((s, f) => s + f.avgDemandM3Day, 0),
		supplied: farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0),
		deficit: farms.reduce((s, f) => s + f.avgDeficitM3Day, 0),
		ewr: farms.reduce((s, f) => s + f.avgEwrShortfallM3Day, 0)
	});
	/** Farm figures here are whole-record means; the curtailment table has its own window. */
	const wholeRecord = $derived(startDate && endDate ? `the whole record, ${startDate} to ${endDate} (${fmtNum(days)} days)` : 'the whole record');

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
		{ key: 'avgDemandM3Day', label: 'Demand', unit: 'm³/day', title: 'Mean abstraction demand over the run: the crop water requirement after effective rainfall ÷ irrigation efficiency (what the hydrological unit takes to meet it).' },
		{ key: 'avgSuppliedM3Day', label: 'Supplied', unit: 'm³/day', title: 'Mean irrigation water actually supplied from dam and river.' },
		{ key: 'avgDeficitM3Day', label: 'Deficit', unit: 'm³/day', title: 'Mean demand not supplied (demand − supplied).' },
		{ key: 'fractionSupplied', label: 'Supplied', unit: '% of demand', title: `Share of demand supplied; hydrological units under ${SUPPLY_TARGET * 100} % are flagged.` },
		{ key: 'avgEwrShortfallM3Day', label: 'EWR charge', unit: 'm³/day charged', title: 'Mean share of the shortfall at the EWR sites below this hydrological unit that is charged to it, pro rata to its net impact, as a positive volume, as in the curtailment table (engine 0.17.0; older runs: the reach shortfall it adds).' }, // gitleaks:allow (a field name, not a secret)
		{ key: 'daysEwrNotMet', label: 'EWR charged', unit: 'days', title: 'Days on which this hydrological unit was charged part of an EWR shortfall (older runs: days it added to a reach shortfall).' }
	];
</script>

<svelte:element this={heading} class="units-h" id={headingId}>{title}</svelte:element>
{#if farms.length === 0}
	<p class="muted">This run has no hydrological unit results.</p>
{:else}
	<div class="farm-head">
		<p class="muted small">
			{#if shortCount}
				<span class="flag-key" aria-hidden="true"></span>
				{shortCount} of {farms.length} hydrological unit{farms.length === 1 ? '' : 's'} received less than {fmtPct(SUPPLY_TARGET, 0)} of demand (highlighted).
			{:else}
				All hydrological units received at least {fmtPct(SUPPLY_TARGET, 0)} of demand.
			{/if}
			<span data-testid="farms-period">Daily averages over {wholeRecord}; the curtailment targets cover the reporting window.</span> Click a heading to sort.
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
						<button type="button" class="sort" onclick={() => sortBy('name')}>Hydrological unit{#if sortKey === 'name'}<span class="dir" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>{/if}</button>
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
					<th scope="row">All hydrological units</th>
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
		Annual totals: demand {fmtQty(m3DayToMm3a(totals.demand), 3)} Mm³/a, supplied {fmtQty(m3DayToMm3a(totals.supplied), 3)} Mm³/a,
		deficit {fmtQty(m3DayToMm3a(totals.deficit), 3)} Mm³/a ({fmtQty((totals.deficit * 1000) / 86_400, 1)} l/s).
	</p>
{/if}

<style>
	h3.units-h {
		margin-top: 1.1rem;
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
