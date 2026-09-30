<!--
	The share-the-pain board (issue #53 R3, docs/design/planning-outputs.md
	§3.3, docs/ui.md § Share the pain): the curtailment report read as two
	stages side by side, each as a share of the group's demand: today and once
	the EWR is met (bounded 0–100 %, never a negative demand). The equitable
	share is one sentence in the intro, with its footnote, not a stage: every
	hydrological unit gets the same %, and its total is always today's (issue
	#177). Other water users are their own rows, marked senior or junior,
	outside the share. View model:
	./shareThePain.ts. Presentation only: every figure is the engine's.
-->
<script lang="ts">
	import { EQUITABLE_SHARE_FOOTNOTE, type CurtailmentSummary } from '@water-management/engine';
	import { shareThePain, type StageCell } from './shareThePain';

	let {
		curtailment,
		names = {},
		period
	}: {
		curtailment: CurtailmentSummary;
		/** Current node names by id, for nodes renamed since the run. */
		names?: Record<string, string>;
		/** The name of the period shown ("Last 7 days"), for the table's caption. */
		period?: string;
	} = $props();

	const board = $derived(shareThePain(curtailment, names));
	const t = $derived(board.farmTotals);
</script>

{#snippet cell(c: StageCell)}
	<span class="stage-cell">
		<span class="bar" aria-hidden="true"><span class="fill" style:width="{(c.fraction ?? 0) * 100}%"></span></span>
		<span class="pct" title={c.pctTitle ?? undefined}>{c.pct}</span>
		<span class="vol">{c.volume} m³/day</span>
	</span>
{/snippet}

<section class="share-board" aria-labelledby="share-board-heading" data-testid="share-the-pain">
	<h4 id="share-board-heading">Share the pain</h4>
	<p class="muted small" data-testid="share-intro">
		Each group's supply as a share of its own demand over the same days, in two steps: what it got, and what is left once the
		EWR is met too.
		{#if board.sharePct === null}
			No hydrological unit had demand, so there is nothing to share.
		{:else}
			At the equitable share every hydrological unit would get the same <strong>{board.sharePct}</strong> of its demand<a
				href="#share-board-footnote"
				class="fn-ref"
				aria-label="see the footnote">*</a
			>: the same water in total as today, shared equally.
		{/if}
		The table per hydrological unit below has the volumes behind it.
	</p>

	<ol class="stages" aria-label="The two stages, all hydrological units">
		<li>
			<span class="step" aria-hidden="true">1</span>
			<span class="stage-name">Today</span>
			<span class="stage-big" data-testid="stage-today">{t.today.pct}</span>
			<span class="muted small">of hydrological unit demand supplied ({t.today.volume} of {t.demand} m³/day)</span>
		</li>
		<li>
			<span class="step" aria-hidden="true">2</span>
			<span class="stage-name">EWR met</span>
			<span class="stage-big" data-testid="stage-ewr">{t.ewr.pct}</span>
			<span class="muted small">of hydrological unit demand left once each hydrological unit's EWR charge is met ({t.ewr.volume} m³/day)</span>
		</li>
	</ol>

	<div class="table-wrap">
		<table class="data">
			<caption class="visually-hidden">
				Share the pain, {period ? `${period}, ` : ''}{curtailment.reportStart} to {curtailment.reportEnd}: each group's supply as a share of
				its demand today and once the EWR is met.
			</caption>
			<thead>
				<tr>
					<th scope="col">Group</th>
					<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
					<th scope="col">1. Today<br /><span class="u">supplied, % of demand</span></th>
					<th scope="col">2. EWR met<br /><span class="u">left after the EWR charge, % of demand</span></th>
				</tr>
			</thead>
			<tbody>
				{#each board.farms as r (r.nodeId)}
					<tr>
						<th scope="row">{r.name}</th>
						<td class="num">{r.demand}</td>
						<td>{@render cell(r.today)}</td>
						<td>
							{@render cell(r.ewr)}
							{#each r.ewrNotes as n (n)}<span class="note-line">{n}</span>{/each}
						</td>
					</tr>
				{/each}
				<tr class="total">
					<th scope="row">All hydrological units</th>
					<td class="num">{t.demand}</td>
					<td>{@render cell(t.today)}</td>
					<td>{@render cell(t.ewr)}</td>
				</tr>
			</tbody>
			{#if board.users.length && board.userTotals}
				<tbody>
					<tr class="section">
						<th scope="colgroup" colspan="4">Other water users <span class="u">(outside the equitable share)</span></th>
					</tr>
					{#each board.users as r (r.nodeId)}
						<tr>
							<th scope="row">
								{r.name}
								<span class="badge" class:badge-senior={r.priority === 'senior'}>{r.priority === 'senior' ? 'senior, not curtailed' : 'junior, curtailed'}</span>
							</th>
							<td class="num">{r.demand}</td>
							<td>{@render cell(r.today)}</td>
							<td>
								{@render cell(r.ewr)}
								{#each r.ewrNotes as n (n)}<span class="note-line">{n}</span>{/each}
							</td>
						</tr>
					{/each}
					<tr class="total">
						<th scope="row">All other users</th>
						<td class="num">{board.userTotals.demand}</td>
						<td>{@render cell(board.userTotals.today)}</td>
						<td>{@render cell(board.userTotals.ewr)}</td>
					</tr>
				</tbody>
			{/if}
		</table>
	</div>
	<p class="muted small note" id="share-board-footnote">
		<strong>* {EQUITABLE_SHARE_FOOTNOTE}</strong> South African restrictions are set per user category (the Reserve first,
		then domestic supply, irrigation among the first cut), not as one share for everyone.
	</p>
	<p class="muted small note">
		<em>EWR met</em> starts from the equitable share and removes each hydrological unit's supply cut for its EWR charge; it never goes
		below 0 % of demand. A hydrological unit with no demand has nothing to cut: any charge it carries is to store less or pass inflow,
		noted in its row. A junior user is cut for its charge; a senior one is not, and its charge stands.
	</p>
</section>

<style>
	.share-board h4 {
		margin-top: 0.9rem;
	}
	.note {
		margin-top: 0.5rem;
		max-width: 80ch;
	}
	.stages {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.5rem;
	}
	.stages li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.step {
		display: inline-grid;
		place-items: center;
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.75rem;
		font-weight: 600;
	}
	.stage-name {
		font-weight: 600;
	}
	.stage-big {
		font-size: 1.5rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.fn-ref {
		margin-left: 0.1rem;
		/* A link inside text is told apart by more than colour (WCAG 1.4.1). */
		text-decoration: underline;
	}
	.stage-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		white-space: nowrap;
	}
	.pct {
		min-width: 3.2rem;
		text-align: right;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.vol {
		color: var(--text-muted);
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	.bar {
		flex: none;
		width: 4rem;
		height: 0.45rem;
		border-radius: 999px;
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.note-line {
		display: block;
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: normal;
		max-width: 22rem;
	}
	tr.total th,
	tr.total td {
		border-top: 1px solid var(--border-strong);
		font-weight: 600;
	}
	tr.section th {
		padding-top: 0.9rem;
		text-align: left;
	}
	.badge {
		margin-left: 0.35rem;
		text-transform: none;
	}
	.badge-senior {
		background: var(--accent-soft);
		border-color: transparent;
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
</style>
