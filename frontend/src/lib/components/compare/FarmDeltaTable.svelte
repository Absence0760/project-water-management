<script lang="ts">
	// Per-farm results of run B with the change from run A, sortable by name or
	// by any metric's change. Farms are matched by name (ids differ across a
	// copied project); farms in only one run are listed underneath. With both
	// runs' farm summaries, a feature column (river pumping, groundwater) joins
	// when either run has it, a farm without the feature reading as 0
	// (delta.ts farmFeatureMetrics).
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { FarmSummary, RunComparison } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import Delta from './Delta.svelte';
	import { FARM_COLUMNS, farmFeatureMetrics, fmtMetric, nextSort, sortFarms, type SortDir, type SortKey } from './delta';

	let {
		comparison,
		farmsA = [],
		farmsB = []
	}: {
		comparison: RunComparison;
		/** Each run's farm summaries (run.summary.farms), for the feature columns. */
		farmsA?: FarmSummary[];
		farmsB?: FarmSummary[];
	} = $props();
	const features = $derived(farmFeatureMetrics(comparison.farms, farmsA, farmsB));
	/** The feature columns where some farm reads as 0 for lack of the feature, for the note. */
	const zeroNotes = $derived(
		features.columns.filter((c) => [...features.cells.values()].some((row) => row[c.key]?.noneA || row[c.key]?.noneB))
	);

	let sort = $state<{ key: SortKey; dir: SortDir } | null>(null);
	// Default: model order (B's), as the engine returns it.
	const rows = $derived(sort ? sortFarms(comparison.farms, sort.key, sort.dir) : comparison.farms);

	function ariaSort(key: SortKey): 'ascending' | 'descending' | undefined {
		if (!sort || sort.key !== key) return undefined;
		return sort.dir === 'asc' ? 'ascending' : 'descending';
	}
	function click(key: SortKey) {
		// Unsorted counts as "name, descending" so the first click on Farm sorts A→Z.
		sort = nextSort(sort ?? { key: 'name', dir: 'desc' }, key);
	}
	const indicator = (key: SortKey) => (sort?.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '');
</script>

{#snippet onlyList(farms: FarmSummary[], title: string)}
	<div>
		<h4>{title}</h4>
		<ul class="only">
			{#each farms as f (f.nodeId)}
				<li>
					<strong>{f.name}</strong>
					<span class="muted">— supplied {fmtNum(f.avgSuppliedM3Day)} of {fmtNum(f.avgDemandM3Day)} m³/day ({fmtPct(f.fractionSupplied)})</span>
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

{#if comparison.farms.length === 0}
	<p class="muted">No hydrological unit appears in both runs, so there is nothing to compare hydrological unit by hydrological unit.</p>
{:else}
	<p class="muted small">
		Daily averages over each run. Each cell shows run B's value and, below it, the change from run A (▲ up, ▼ down; green
		= better, red = worse, grey = no judgement). Click a column heading to sort by that change.
	</p>
	<div class="table-wrap">
		<table class="data">
			<caption class="visually-hidden">Change per hydrological unit, run B minus run A</caption>
			<thead>
				<tr>
					<th scope="col" aria-sort={ariaSort('name')}>
						<button type="button" class="sort" onclick={() => click('name')}>Hydrological unit <span aria-hidden="true">{indicator('name')}</span></button>
					</th>
					{#each FARM_COLUMNS as c (c.key)}
						<th scope="col" class="num" aria-sort={ariaSort(c.key)}>
							<button type="button" class="sort" onclick={() => click(c.key)}>
								<span aria-hidden="true">{indicator(c.key)}</span>
								{c.label}<br /><span class="u">{c.unit}</span>
							</button>
						</th>
					{/each}
					{#each features.columns as c (c.key)}
						<th scope="col" class="num">{c.label}<br /><span class="u">{c.unit}</span></th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as f (f.nodeIdB)}
					<tr>
						<th scope="row">
							{f.name}
							{#if f.nameA}<span class="muted small">(was {f.nameA})</span>{/if}
						</th>
						{#each FARM_COLUMNS as c (c.key)}
							<td class="num">
								<span class="val">{fmtMetric(f[c.key].b, c)}</span>
								<Delta m={f[c.key]} spec={c} />
							</td>
						{/each}
						{#each features.columns as c (c.key)}
							{@const cell = features.cells.get(f.nodeIdB)?.[c.key]}
							<td class="num" data-testid="farm-feature-{c.key}">
								{#if cell}
									<span class="val">{fmtMetric(cell.m.b, c)}{#if cell.noneB}<span class="muted small"> (none)</span>{/if}</span>
									<Delta m={cell.m} spec={c} />
									{#if cell.noneA}<span class="none-a muted small">A: none (0)</span>{/if}
								{:else}–{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if zeroNotes.length}
		<p class="muted small" data-testid="farm-feature-note">
			{#each zeroNotes as c, i (c.key)}{i ? ' ' : ''}{c.label}: a run with {c.none} at a hydrological unit reads as 0 there (“none”).{/each}
			<HelpTip key="one-run-feature" label="About features only one run has" />
		</p>
	{/if}
{/if}

{#if comparison.onlyInA.length || comparison.onlyInB.length}
	<div class="onlys">
		{#if comparison.onlyInA.length}{@render onlyList(comparison.onlyInA, 'Only in run A')}{/if}
		{#if comparison.onlyInB.length}{@render onlyList(comparison.onlyInB, 'Only in run B')}{/if}
	</div>
{/if}

<style>
	.sort {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
		text-align: inherit;
	}
	.sort:hover {
		color: var(--accent);
	}
	td.num {
		line-height: 1.25;
	}
	td .val,
	td .none-a {
		display: block;
	}
	td :global(.delta) {
		font-size: 0.8rem;
	}
	.onlys {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1rem;
		margin-top: 1rem;
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
	.only {
		margin: 0;
		padding-left: 1.1rem;
	}
</style>
