<script lang="ts">
	// Registered against the run, per hydrological unit (docs/allocations.md §
	// Per unit, all three; docs/ui.md § Allocations): each unit's registered
	// irrigated area against the area the run planted, its registered water use
	// against the modelled use (the mean whole water year, surface and
	// groundwater added), and its registered storage (s21b) against the dam in
	// the run, each with the comparison's ±band status, then the catchment's
	// total of each. Arithmetic only (unitMeasures, allocations.ts): the model
	// never reads a registered area, and no word here says lawful. A read-only
	// table: below 50rem of its box each row is a block (app.css .table-stack).
	// The units to look into first lead; the first CAP show until "Show all"
	// (the picked unit's row stays), and the total row is always there.
	// Offered where the per-unit comparison is (never to a viewer who sees
	// totals only, D3); no holder's name is in it.
	import type { AllocationComparison } from '@water-management/engine';
	import { fmtNum } from '#lib/format/number.js';
	import { withParam } from '#lib/workspace/overlays.js';
	import { page } from '$app/state';
	import { foldList } from '#lib/components/common/fold.js';
	import { areaHa, MEASURE_STATUS_LABEL, unitMeasures, type MeasureCell } from './allocations';

	let { comparison, picked = null, onpick }: { comparison: AllocationComparison; picked?: string | null; onpick: (nodeId: string) => void } = $props();

	const CAP = 8;
	let all = $state(false);

	const url = $derived(page.url);
	const m = $derived(unitMeasures(comparison));
	const fold = $derived(foldList(m.rows, (r) => r.nodeId, picked, all, CAP));
	const band = $derived(`±${fmtNum(comparison.tolerance * 100, 0)} %`);
	const ha = (v: number | null) => (v === null ? '–' : areaHa(v));
	const m3 = (v: number | null) => (v === null ? '–' : fmtNum(v));
</script>

{#snippet cell(c: MeasureCell | null, kind: 'area' | 'use' | 'storage', fmt: (v: number | null) => string, registeredLabel: string, modelledLabel: string)}
	<td class="num" data-label={registeredLabel}>{c ? fmt(c.registered) : '–'}</td>
	<td class="num" data-label={modelledLabel} data-status={c?.status ?? 'nodata'}
		>{c ? fmt(c.modelled) : '–'}{#if c}<span class="sub"><span class="status status-{c.status}">{MEASURE_STATUS_LABEL[kind][c.status]}</span></span>{:else}<span class="sub muted"
				>{kind === 'use' ? 'No whole water year' : 'Run the model again'}</span
			>{/if}</td
	>
{/snippet}

<section class="panel" aria-labelledby="alloc-totals-h" data-testid="allocation-unit-totals">
	<div class="panel-head">
		<h2 id="alloc-totals-h">Registered against the run, per hydrological unit</h2>
	</div>
	<p class="small muted lead">
		Each unit’s registered irrigated area, water use and dam storage, added up over its registered users, beside what the run has: the crop areas it planted,
		its modelled use in the mean whole water year (surface and groundwater added; modelled, not metered) and the dam it modelled. “Within band” is within
		{band} of what is registered. The model never reads a registered irrigated area: it is compared, not used.
	</p>
	{#if m.rows.length}
		<div class="table-stack">
			<div class="table-wrap">
				<table class="data" id="alloc-unit-totals" data-testid="allocation-unit-totals-table">
					<caption class="visually-hidden">Registered irrigated area, water use and dam storage against the run, per hydrological unit, with the catchment’s totals</caption>
					<thead>
						<tr>
							<td></td>
							<th scope="colgroup" colspan="2">Irrigated area (ha)</th>
							<th scope="colgroup" colspan="2">Water use (m³ a year)</th>
							<th scope="colgroup" colspan="2">Dam (m³)</th>
						</tr>
						<tr>
							<th scope="col">Hydrological unit or user</th>
							<th scope="col" class="num">Registered</th>
							<th scope="col" class="num">Planted in the run</th>
							<th scope="col" class="num">Registered</th>
							<th scope="col" class="num">Modelled</th>
							<th scope="col" class="num">Registered storage</th>
							<th scope="col" class="num">In the run</th>
						</tr>
					</thead>
					<tbody>
						{#each fold.shown as r (r.nodeId)}
							<tr data-node={r.nodeId}>
								<th scope="row">
									<a
										href={withParam(url, 'unit', r.nodeId)}
										onclick={(e) => {
											if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
											e.preventDefault();
											onpick(r.nodeId);
										}}>{r.name}</a
									>
								</th>
								{@render cell(r.area, 'area', ha, 'Irrigated area registered', 'Planted in the run')}
								{@render cell(r.use, 'use', m3, 'Water use registered (m³/a)', 'Modelled use (m³/a)')}
								{@render cell(r.storage, 'storage', m3, 'Registered storage (m³)', 'Dam in the run (m³)')}
							</tr>
						{/each}
						<tr class="total" data-testid="allocation-unit-totals-total">
							<th scope="row">Catchment total <span class="sub muted">{m.rows.length} unit{m.rows.length === 1 ? '' : 's'}</span></th>
							{@render cell(m.total.area, 'area', ha, 'Irrigated area registered', 'Planted in the run')}
							{@render cell(m.total.use, 'use', m3, 'Water use registered (m³/a)', 'Modelled use (m³/a)')}
							{@render cell(m.total.storage, 'storage', m3, 'Registered storage (m³)', 'Dam in the run (m³)')}
						</tr>
					</tbody>
				</table>
			</div>
		</div>
		{#if all || fold.hidden}
			<button type="button" class="btn btn-sm more" aria-expanded={all} aria-controls="alloc-unit-totals" onclick={() => (all = !all)}>
				{all ? `Show the ${CAP} to look into first` : `Show all ${fmtNum(m.rows.length)} hydrological units`}
			</button>
		{/if}
		{#if comparison.unmatchedAllocationIds.length || comparison.notInRunAllocationIds.length}
			<p class="small muted note">Registered volumes not matched to a unit of this run aren’t in any total.</p>
		{/if}
	{:else}
		<p class="muted">No hydrological unit has a registered area, volume or storage, or anything in the run to compare.</p>
	{/if}
</section>

<style>
	.lead {
		margin: 0 0 0.6rem;
		max-width: 100ch;
	}
	.note,
	.more {
		margin: 0.5rem 0 0;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: var(--font-xs);
	}
	/* A status word wraps in a narrow cell (a phone's 6rem blocks), not past it. */
	.sub .status {
		white-space: normal;
		max-width: 100%;
	}
	/* The page is the one scroll: no 70vh cap (app.css). */
	.table-wrap {
		max-height: none;
	}
	thead th[scope='colgroup'] {
		text-align: center;
		border-bottom: 1px solid var(--border);
	}
	tbody th a {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	tr.total th,
	tr.total td {
		font-weight: 600;
		border-top: 2px solid var(--border-strong);
		background: var(--surface-2);
	}
</style>
