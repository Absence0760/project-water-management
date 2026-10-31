<script lang="ts">
	// An assessment's background at full allocation (295, WP-3.10; docs/ui.md
	// § Applications › Assess together): its own labelled table under the
	// baseline's matrix, never in its place. Licences never drive the baseline
	// (issue #507): the matrix above stays the hydrologist's run; this one puts
	// the assessor's full-allocation run (every registered or licensed volume
	// taken in full) in the baseline's column, with how far it moves each
	// measure from the hydrologist's baseline, and each application alone and
	// all together on it. Its own component, not the matrix again: its columns
	// differ (the baseline beside the background).
	import type { AssessmentBackground } from '#lib/api/index.js';
	import type { CumulativeReport } from '@water-management/engine';
	import { baselineOf, changeText, changeTone, interactionWords, rowLabel, valueText } from './cumulative';

	let { report, fullAllocation: background }: { report: CumulativeReport; fullAllocation: AssessmentBackground } = $props();

	const rep = $derived(background.report);
	const runName = $derived(background.run.label || background.run.scenarioName || 'the background run');
</script>

<section class="background" aria-labelledby="assess-bg-h" data-testid="assess-background">
	<h3 id="assess-bg-h">{background.label}</h3>
	<p class="small">
		On “{runName}”{background.run.scenarioName && background.run.label ? ` (${background.run.scenarioName})` : ''}: the same baseline with every registered
		or licensed volume taken in full, chosen for this assessment. A separate comparison: the table above stays the hydrologist’s baseline, and this one
		never replaces it.
	</p>
	{#if background.verdictsOnly}
		<p class="small muted" data-testid="assess-background-verdicts">
			Only the EWR days and Reserve months are shown: the other figures of a full-allocation run are worked out from the registered volumes, which
			this project shows to its editors and owners only.
		</p>
	{/if}
	{#each rep.warnings as w, i (i)}<p class="warn">{w}</p>{/each}
	<div class="table-wrap">
		<table class="data matrix">
			<caption class="visually-hidden">Each measure on the baseline, on the background at full allocation, each application alone and all together on it, and the interaction</caption>
			<thead>
				<tr>
					<th scope="col">Measure</th>
					<th scope="col">Site</th>
					<th scope="col" class="num">Baseline</th>
					<th scope="col" class="num">At full allocation</th>
					{#each rep.scenarios as s (s.id)}<th scope="col" class="num">{s.name} alone</th>{/each}
					<th scope="col" class="num">All together</th>
					<th scope="col" class="num">Interaction</th>
				</tr>
			</thead>
			<tbody>
				{#each rep.rows as r, i (i)}
					{@const label = rowLabel(r)}
					{@const base = baselineOf(report, r)}
					{@const moved = base === null || r.baseline === null ? null : r.baseline - base}
					<tr data-metric={r.metric}>
						<th scope="row">{label.measure}</th>
						<td>{label.site}</td>
						<td class="num">{valueText(base, r.unit)}</td>
						<td class="num">
							{valueText(r.baseline, r.unit)}
							<span class="chg tone-{changeTone(moved, r.higherIsWorse, base ?? 1)}">{changeText(moved, r.unit)}</span>
						</td>
						{#each r.singles as v, k (k)}
							<td class="num">
								{valueText(v, r.unit)}
								<span class="chg tone-{changeTone(r.singleChanges[k] ?? null, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.singleChanges[k] ?? null, r.unit)}</span>
							</td>
						{/each}
						<td class="num">
							{valueText(r.combined, r.unit)}
							<span class="chg tone-{changeTone(r.combinedChange, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.combinedChange, r.unit)}</span>
						</td>
						<td class="num" title={interactionWords(r)}>
							<span class="chg tone-{changeTone(r.interaction, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.interaction, r.unit)}</span>
							<span class="visually-hidden">{interactionWords(r)}</span>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="small muted">
		Under “At full allocation”, the change from the baseline; under each application and all together, the change from the background.
	</p>
</section>

<style>
	.background {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	p {
		margin: 0;
	}
	.matrix td.num {
		white-space: nowrap;
	}
	.chg {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	.chg.tone-worse {
		color: var(--danger);
	}
	.chg.tone-better {
		color: var(--success);
	}
	.table-wrap {
		overflow-x: auto;
	}
	.warn {
		color: var(--warning);
	}
</style>
