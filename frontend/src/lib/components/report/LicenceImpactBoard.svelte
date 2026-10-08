<!--
	The impact report's licence-impact board (issue #53 R7, docs/ui.md
	§ Report): one column per water-year class of the baseline's natural flow,
	two rows, the annual waterfall and the months below the Reserve (baseline
	vs this run), then the verdict in words. The verdict comes from the
	months, never from the annual totals. No verdict colour: it reports data.
	View model: ./licenceImpact.ts.
-->
<script lang="ts">
	import type { BoardView } from './licenceImpact';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let { view }: { view: BoardView } = $props();
	const METHOD = { terciles: 'terciles', quintiles: 'quintiles' } as const;
</script>

<section class="board" aria-labelledby="impact-board-h" data-testid="licence-impact-board">
	<h3 id="impact-board-h">Impact by year class <HelpTip key="licence-impact-year-class" /></h3>
	{#if view.status === 'unavailable'}
		<p class="alert alert-info" role="status">{view.reason}</p>
	{:else}
		<p class="lede">
			The baseline’s complete water years, ranked by their natural flow and split into {METHOD[view.method]} ({view.nYears} years compared). Each
			column sets the baseline {view.background} beside {view.application} over the same years. The verdict is from the months below the requirement, not
			from the annual totals.
		</p>
		<div class="table-wrap">
			<table class="data board-table">
				<caption class="visually-hidden">Impact by year class: the annual waterfall, the requirement not met and the verdict, baseline and {view.application}</caption>
				<thead>
					<tr>
						<th scope="col"><span class="visually-hidden">Measure</span></th>
						{#each view.columns as c (c.id)}
							<th scope="col" data-testid="board-class-{c.id}">
								{c.label}
								<span class="sub">{c.bounds} · {c.nYears} {c.nYears === 1 ? 'year' : 'years'}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Annual waterfall<span class="sub">mean a year, at the outlet</span></th>
						{#each view.columns as c (c.id)}
							<td data-testid="board-waterfall-{c.id}">
								{#if c.waterfall}
									<dl class="steps">
										{#each c.waterfall as s (s.id)}
											<div class="step step-{s.id}"><dt>{s.label}</dt><dd class="num">{s.text}</dd></div>
										{/each}
									</dl>
								{:else}
									<span class="none">Not enough years</span>
								{/if}
							</td>
						{/each}
					</tr>
					<tr>
						<th scope="row">{view.belowLabel}</th>
						{#each view.columns as c (c.id)}
							<td data-testid="board-below-{c.id}">
								{#if c.below}
									<dl class="steps">
										<div class="step"><dt>Baseline</dt><dd class="num">{c.below.background}</dd></div>
										<div class="step"><dt>{view.application.charAt(0).toUpperCase() + view.application.slice(1)}</dt><dd class="num">{c.below.application}</dd></div>
										<div class="step step-left"><dt>Change</dt><dd class="num">{c.below.change}</dd></div>
									</dl>
									<span class="sub">of {c.below.units} {view.metric === 'reserveMonthsMet' ? 'months' : 'days'}</span>
								{:else}
									<span class="none">Not enough years</span>
								{/if}
							</td>
						{/each}
					</tr>
					<tr>
						<th scope="row">Verdict</th>
						{#each view.columns as c (c.id)}
							<td data-testid="board-verdict-{c.id}" data-verdict={c.verdict}>
								<strong>{c.verdictLabel}</strong>
								<span class="text">{c.text}</span>
							</td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
		<p class="note">{view.existingNote}</p>
		{#each view.notes as n, i (i)}<p class="note">{n}</p>{/each}
	{/if}
</section>

<style>
	.board {
		break-inside: avoid;
	}
	.lede,
	.note {
		max-width: 72ch;
		line-height: 1.5;
	}
	.note {
		color: var(--text-muted);
		font-size: 0.9em;
	}
	.board-table th[scope='row'] {
		font-weight: 500;
		vertical-align: top;
		min-width: 9rem;
	}
	.board-table td {
		vertical-align: top;
		min-width: 12rem;
	}
	.sub {
		display: block;
		color: var(--text-muted);
		font-weight: 400;
		font-size: 0.8em;
	}
	.steps {
		margin: 0;
	}
	.step {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.step dt {
		font-weight: 400;
	}
	.step dd {
		margin: 0;
		white-space: nowrap;
	}
	/* The totals the waterfall runs between. */
	.step-natural,
	.step-left {
		font-weight: 600;
	}
	.step-left {
		border-top: 1px solid var(--border);
		margin-top: 0.15rem;
		padding-top: 0.15rem;
	}
	.none {
		color: var(--text-muted);
		font-style: italic;
	}
	.text {
		display: block;
		margin-top: 0.25rem;
		line-height: 1.4;
	}
	h3 {
		margin: 0 0 0.5rem;
	}
</style>
