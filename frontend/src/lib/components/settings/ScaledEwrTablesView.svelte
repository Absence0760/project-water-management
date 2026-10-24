<!--
	The daily EWR's DRM tables scaled to the modelled catchment (issue #90 B1
	gap a, docs/model.md §2.9f, docs/ui.md § The daily EWR at the outlet): each
	entered value × the scale factor s, read only. Settings shows it under the
	entered tables once s is known (the area ratio at once, the MAR ratio after
	a run); a run shows it with its own s and its settings snapshot's tables
	(RunsTab). The values are what the run reads; the run's warnings name a
	natural row that rises (read as its running minimum). Under the percentile
	tables all three (issue #552): the natural flow, the total Reserve flow and
	the Reserve flow without high flows, as the EWR at the outlet, the one the
	daily EWR reads marked as such (and said when it isn't entered yet).
-->
<script lang="ts">
	import { EWR_PERCENTILE_POINTS } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtQty } from '$lib/format/number';
	import { DAILY_TABLE_LABELS, type ScaledEwrTables } from './ewrDailySource';

	let { tables }: { tables: ScaledEwrTables } = $props();

	const POINT_LABELS = EWR_PERCENTILE_POINTS.map((p) => `${Math.round(p * 100)} %`);
	const s = $derived(String(Number(tables.scale.toPrecision(4))));
	const chosenName = $derived(tables.reserveTable === 'withoutHighFlows' ? 'Reserve flow without high flows' : 'total Reserve flow');
	const chosenMissing = $derived(!(tables.reserveTable === 'withoutHighFlows' ? tables.lowFlowPctM3s : tables.reservePctM3s));
</script>

<div class="scaled" data-testid="ewr-scaled-tables">
	{#if tables.method === 'tab' && tables.tabM3s}
		<div class="table-wrap">
			<table class="data compact">
				<caption>TAB flows scaled to the model <span class="u">(m³/s, × s = {s})</span></caption>
				<thead>
					<tr>
						<th scope="col" class="sticky">Month</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row" class="sticky">m³/s</th>
						{#each tables.tabM3s as v, i (i)}<td class="num">{fmtQty(v, 3)}</td>{/each}
					</tr>
				</tbody>
			</table>
		</div>
	{:else}
		<p class="lead" data-testid="ewr-scaled-lead">The EWR at the outlet: the .rul’s tables × s. The daily EWR reads the <strong>{chosenName}</strong>{#if chosenMissing}, not entered yet: load a .rul with that block or enter it above{/if}.</p>
		{#snippet grid(rows: (number | null)[][] | null, label: string, used: boolean | null, testid: string)}
			{#if rows}
				<div class="table-wrap" data-testid={testid}>
					<table class="data compact">
						<caption>{label} scaled to the model <span class="u">(m³/s, × s = {s}{used === true ? ', the daily EWR' : used === false ? ', not used by the daily EWR' : ''})</span></caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each POINT_LABELS as p (p)}<th scope="col" class="num">{p}</th>{/each}
							</tr>
						</thead>
						<tbody>
							{#each WATER_YEAR_MONTHS as m, r (m)}
								<tr>
									<th scope="row" class="sticky">{m}</th>
									{#each POINT_LABELS as p, c (p)}<td class="num">{fmtQty(rows[r]?.[c], 3)}</td>{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/snippet}
		{@render grid(tables.naturalPctM3s, DAILY_TABLE_LABELS.naturalPctM3s, null, 'ewr-scaled-natural')}
		{@render grid(tables.reservePctM3s, DAILY_TABLE_LABELS.reservePctM3s, tables.reserveTable === 'total', 'ewr-scaled-total')}
		{@render grid(tables.lowFlowPctM3s, DAILY_TABLE_LABELS.lowFlowPctM3s, tables.reserveTable === 'withoutHighFlows', 'ewr-scaled-without-high')}
	{/if}
</div>

<style>
	.lead {
		font-size: var(--font-sm);
		margin: 0.35rem 0 0;
		max-width: 75ch;
	}
	caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		padding: 0.5rem 0 0.25rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
</style>
