<!--
	The impact report's first section (issue #17, board A4's Export impact
	report; docs/ui.md § Report): this run against the baseline it was compared
	with on Compare runs (`against`), from the same GET /compare/runs and the
	same outcomes, takeaways and input changes as that page
	(compare/summary.ts), so the paper and the screen never disagree. Its own
	chunk: only a report opened with `against` loads it.
-->
<script lang="ts">
	import type { RunCompareResponse } from '$lib/api';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import { fmtMetric } from '$lib/components/compare/delta';
	import { compareDamStorage, outcomeRows, takeaways } from '$lib/components/compare/summary';
	import { fmtDate } from '$lib/format/number';

	let { data }: { data: RunCompareResponse } = $props();

	const runName = (s: RunCompareResponse['a']) => s.run.label || 'Untitled run';
	const rows = $derived(outcomeRows([data.comparison], [compareDamStorage(data)]));
	const notes = $derived(
		takeaways(rows, [`“${runName(data.b)}”`], { samePeriod: [data.comparison.samePeriod], engineChanged: [data.comparison.engineVersionChanged] })
	);
	const sameRun = $derived(data.a.project.id === data.b.project.id && data.a.run.id === data.b.run.id);
</script>

<p class="lede">
	This run against the baseline <strong>“{runName(data.a)}”</strong> ({data.a.project.name}, {data.a.run.startDate} – {data.a.run.endDate}, run
	{fmtDate(data.a.run.createdAt, true)}). Every change is this run minus the baseline.
</p>
{#if sameRun}
	<p class="alert alert-info">The baseline is this run, so nothing has changed.</p>
{/if}

<div class="table-wrap">
	<table class="data impact-table">
		<caption class="visually-hidden">Headline outcomes of the baseline and this run, with the change</caption>
		<thead>
			<tr>
				<th scope="col">Outcome</th>
				<th scope="col" class="num">Baseline</th>
				<th scope="col" class="num">This run</th>
				<th scope="col" class="num">Change</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				{@const m = r.whatIfs[0]!}
				<tr>
					<th scope="row">{r.label}{#if r.unit}<span class="u"><span class="visually-hidden">,{' '}</span>{r.unit}</span>{/if}</th>
					<td class="num">{fmtMetric(r.base, r.spec)}</td>
					<td class="num">{fmtMetric(m.b, r.spec)}</td>
					<td class="num"><Delta {m} spec={r.spec} /></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<h3>In short</h3>
<ul class="notes" data-testid="impact-takeaways">
	{#each notes as t, i (i)}<li>{t.text}.</li>{/each}
</ul>

<h3>What changed in the inputs <span class="count">({data.changes.length})</span></h3>
<ChangesList changes={data.changes} />

<style>
	.lede,
	.notes {
		max-width: 72ch;
		line-height: 1.5;
	}
	.impact-table th[scope='row'] {
		font-weight: 500;
	}
	/* The unit on its own line under the outcome, as on Compare runs. */
	.u {
		display: block;
		color: var(--text-muted);
		font-weight: 400;
		font-size: 0.8em;
	}
	.notes {
		margin: 0;
	}
	h3 {
		margin: 1.25rem 0 0.5rem;
	}
	.count {
		color: var(--text-muted);
		font-weight: 400;
	}
</style>
