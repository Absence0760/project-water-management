<!--
	The stored TAB flows beside a .tab's Total flows, maint. column in m³/s, month by month (docs/ui.md § The
	daily EWR at the outlet): so TAB flows typed, pasted, imported from a workbook or saved before the file
	was kept can be checked against the DRM file they came from. One line says how many months differ and the
	largest difference; the table gives each month's stored value, the file's and the difference in % (the
	difference row is the cue, a tint only a second one). Read only; the comparison is
	drmFiles.ts compareTabFlows. Shown in the .tab's preview and under a kept file the TAB row no longer matches.
-->
<script lang="ts">
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { fmtNum } from '#lib/format/number.js';
	import { pctText, tabComparisonLine, type TabFlowComparison } from './drmFiles';

	let { comparison, fileName, testid = 'ewr-tab-compare' }: { comparison: TabFlowComparison; fileName: string; testid?: string } = $props();

	const line = $derived(tabComparisonLine(comparison, WATER_YEAR_MONTHS));
	const diffText = (m: TabFlowComparison['months'][number]) => (m.stored === null ? 'empty' : m.same ? 'same' : m.diffPct === null ? 'differs' : `${m.diffPct > 0 ? '+' : '−'}${pctText(Math.abs(m.diffPct))}`);
</script>

<div class="compare" data-testid={testid}>
	<p class="small line" data-testid="{testid}-line">{line}</p>
	<div class="table-wrap">
		<table class="data compact">
			<caption>The TAB flows against {fileName} <span class="u">(m³/s, before scaling)</span></caption>
			<thead>
				<tr>
					<th scope="col" class="sticky">Month</th>
					{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row" class="sticky">Stored</th>
					{#each comparison.months as m, i (i)}<td class="num" class:off={!m.same}>{fmtNum(m.stored, 4)}</td>{/each}
				</tr>
				<tr>
					<th scope="row" class="sticky">In the file</th>
					{#each comparison.months as m, i (i)}<td class="num" class:off={!m.same}>{fmtNum(m.file, 4)}</td>{/each}
				</tr>
				<tr>
					<th scope="row" class="sticky">Difference <span class="u">(%)</span></th>
					{#each comparison.months as m, i (i)}<td class="num" class:off={!m.same}>{diffText(m)}</td>{/each}
				</tr>
			</tbody>
		</table>
	</div>
</div>

<style>
	.compare {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
		margin-top: 0.35rem;
	}
	.line {
		margin: 0;
		max-width: 75ch;
	}
	caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		padding: 0.25rem 0;
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
	/* A month that differs: said in the Difference row, tinted only as a second cue. */
	.off {
		background: var(--warning-soft);
	}
</style>
