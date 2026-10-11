<script lang="ts">
	// What a viewer reads on the Allocations tab when the project's owners
	// haven't let viewers see each farm's registered volumes (decision D3,
	// 162_allocation_viewer_units; docs/allocations.md § Who sees what): the
	// registered volumes in force today and the run's modelled use, each summed
	// per water source, only for a source 5 or more registered users hold. No
	// unit, name or registration number.
	import type { AllocationComparisonTotals, AllocationTotal } from '$lib/api';
	import { fmtNum } from '$lib/format/number';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { judgementSentence, SOURCE_LABEL, totalsSentence, waterYearLabel } from './allocations';

	let {
		totals,
		years,
		yearsWithheld = false,
		runLabel,
		loading
	}: { totals: AllocationTotal[] | null; years: AllocationComparisonTotals | null; yearsWithheld?: boolean; runLabel: string | null; loading: boolean } = $props();
</script>

<section class="panel" aria-labelledby="alloc-totals-h" data-testid="allocation-totals">
	<h2 id="alloc-totals-h">Registered water use in this catchment <HelpTip key="allocation-viewer-access" /></h2>
	<p class="muted">
		This catchment’s registered volumes are shown to viewers as today’s totals per water source, and only where at least 5 registered users hold one in force and no one
		or two of them hold most of it, so no farm’s volume can be read from them. The organisation’s editors and owners see each farm.
	</p>
	{#if totals && totals.length}
		<ul class="totals">
			{#each totals as t (t.waterSource)}
				<li data-testid="allocation-total-{t.waterSource}">{totalsSentence(t)}</li>
			{/each}
		</ul>
	{:else if totals}
		<p class="muted" data-testid="allocation-totals-withheld">No total is shown: fewer than 5 registered users hold a volume from any one water source.</p>
	{/if}

	{#if runLabel && years?.sources.length}
		<h3 class="sub-h">Modelled use by the units with a registered volume, run “{runLabel}”</h3>
		<p class="small muted">
			Summed over the units with a registered volume, each water year (October–September). Modelled, not metered: arithmetic, not a finding about anyone’s use. The
			registered volume is shown only as today’s total above, and how the use compares with it only once for the whole run, when the same registered users held the same
			volumes all through it: figures for each year would give the volumes away.
		</p>
		{#each years.sources as s (s.waterSource)}
			<p class="small" data-testid="allocation-totals-judgement-{s.waterSource}">{judgementSentence(s.judgement, years.tolerance)}</p>
			<div class="table-wrap">
				<table class="data compact" data-testid="allocation-totals-years-{s.waterSource}">
					<caption>{SOURCE_LABEL[s.waterSource]}: {fmtNum(s.units)} units, {fmtNum(s.holders)} registered users</caption>
					<thead>
						<tr>
							<th scope="col">Water year</th>
							<th scope="col" class="num">Modelled use (m³)</th>
						</tr>
					</thead>
					<tbody>
						{#each s.years as y (y.waterYear)}
							<tr>
								<th scope="row">{waterYearLabel(y.waterYear)}{y.partial ? ' (part)' : ''}</th>
								<td class="num">{fmtNum(y.modelledM3)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/each}
	{:else if runLabel && yearsWithheld}
		<p class="small muted" data-testid="allocation-totals-years-mode">
			The run “{runLabel}” holds each unit’s use to its registered volume (capped or full allocation), so its modelled use would show the volumes: it isn’t shown here.
		</p>
	{:else if loading}
		<p class="muted small">Loading the run’s totals…</p>
	{/if}
</section>

<style>
	.totals {
		margin: 0.5rem 0 1rem;
		padding-left: 1.2rem;
	}
	caption {
		text-align: left;
		font-weight: 600;
		padding: 0.25rem 0;
	}
</style>
