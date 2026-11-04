<!--
	The share-the-pain board (issue #53 R3, docs/design/planning-outputs.md
	§3.3, docs/ui.md § Share the pain): the curtailment report read as three
	stages side by side, each as a share of the group's demand: today, at the
	equitable share (the volume each hydrological unit would have, and its
	change from today) and once the EWR is met (its EWR charge, the total
	change and what is left, bounded 0–100 %, never a negative demand). Three
	cards first, one per stage, over every group: short of demand today, what
	the equal share would move, and the further cut the EWR takes. Other water
	users are their own rows, marked priority or non-priority, outside the
	share. Each % is banded as every supply view is (network/supplyThresholds.ts),
	and the % is written beside the bar, so colour is never the only cue.
	View model: ./shareThePain.ts. Presentation only: every figure is the engine's.
-->
<script lang="ts">
	import { DEMAND_NORMS, DEMAND_PCT_FLOOR_M3_DAY, EQUITABLE_SHARE_FOOTNOTE, type CurtailmentSummary } from '@water-management/engine';
	import { SHARE_BAND_LABEL, shareThePain, type Change, type StageCell } from './shareThePain';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtDay } from '#lib/format/number.js';

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
	const cards = $derived(board.cards);
</script>

{#snippet cell(c: StageCell)}
	<span class="stage-cell" data-band={c.band}>
		<span class="bar" aria-hidden="true"><span class="fill {c.band}" style:width="{(c.fraction ?? 0) * 100}%"></span></span>
		<span class="pct" title={c.pctTitle ?? undefined}>{c.pct}</span>
		<span class="vol">{c.volume} m³/day</span>
	</span>
{/snippet}

{#snippet chg(c: Change)}
	<span class="chg" data-dir={c.direction} class:neg={c.direction === 'down'} class:pos={c.direction === 'up'}
		>{#if c.direction === 'down'}<span class="arrow" aria-hidden="true">↓</span>{:else if c.direction === 'up'}<span class="arrow" aria-hidden="true">↑</span>{/if}{c.text}</span
	>
{/snippet}

<section class="share-board" aria-labelledby="share-board-heading" data-testid="share-the-pain">
	<h4 id="share-board-heading">Share the pain <HelpTip key="share-the-pain" /></h4>
	<p class="muted small" data-testid="share-intro">
		Each group's supply as a share of its own demand over the same days, in three steps: what it got, what the equitable share would give
		it, and what is left once the EWR is met too.
		{#if board.shareTooSmall}
			Farm demand is under {DEMAND_PCT_FLOOR_M3_DAY} m³/day in total, too little for the equitable share's % to mean anything.
		{:else if board.sharePct === null}
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

	<ol class="stages" aria-label="The three stages, every group">
		<li class="stage-1" data-testid="card-deficit">
			<span class="stage-head"><span class="step" aria-hidden="true">1</span><span class="stage-name">Today</span></span>
			<span class="muted small">Short of demand</span>
			<span class="stage-big">{cards.deficit.volume} <span class="u">m³/day</span></span>
			<span class="muted small">
				{#if cards.deficit.pct}{cards.deficit.pct} of all groups' demand.{/if}
				Hydrological units got <strong data-testid="stage-today">{t.today.pct}</strong> of their demand.
			</span>
		</li>
		<li class="stage-2" data-testid="card-share">
			<span class="stage-head"><span class="step" aria-hidden="true">2</span><span class="stage-name">Equitable share</span></span>
			<span class="muted small">Moved between hydrological units</span>
			{#if cards.moved}
				<span class="stage-big">{cards.moved.volume} <span class="u">m³/day</span></span>
				<span class="muted small">
					Every hydrological unit at <strong data-testid="stage-share">{board.sharePct ?? t.share?.target.pct ?? '–'}</strong> of its demand; the units
					above it give up what those below it are short, so the total is today's (net {cards.moved.net} m³/day).
				</span>
			{:else}
				<span class="stage-big">–</span>
				<span class="muted small">No hydrological unit had demand to share.</span>
			{/if}
		</li>
		<li class="stage-3" data-testid="card-ewr">
			<span class="stage-head"><span class="step" aria-hidden="true">3</span><span class="stage-name">EWR met</span></span>
			<span class="muted small">Further cut for the EWR</span>
			<span class="stage-big">{cards.ewrCut.volume} <span class="u">m³/day</span></span>
			<span class="muted small">
				{#if cards.ewrCut.pct}{cards.ewrCut.pct} of all groups' demand.{/if}
				Hydrological units keep <strong data-testid="stage-ewr">{t.ewr.pct}</strong> of their demand.
				{#if cards.ewrCut.storeLess}A further {cards.ewrCut.storeLess} m³/day of the charge is met by storing less / passing inflow.{/if}
			</span>
		</li>
	</ol>

	<ul class="legend" aria-label="Key" data-testid="share-legend">
		<li><i class="met" aria-hidden="true"></i>{SHARE_BAND_LABEL.met}</li>
		<li><i class="short" aria-hidden="true"></i>{SHARE_BAND_LABEL.short}</li>
		<li><i class="low" aria-hidden="true"></i>{SHARE_BAND_LABEL.low}</li>
		<li><span class="neg" aria-hidden="true">↓</span> − reduce supply</li>
		<li><span class="pos" aria-hidden="true">↑</span> + below the equitable share</li>
		<li>Bars: share of the group's own demand</li>
	</ul>

	<div class="table-stack">
		<div class="table-wrap">
			<table class="data">
				<caption class="visually-hidden">
					Share the pain, {period ? `${period}, ` : ''}{fmtDay(curtailment.reportStart)} to {fmtDay(curtailment.reportEnd)}: each group's supply as a share of
					its demand today, at the equitable share and once the EWR is met.
				</caption>
				<thead>
					<tr class="group">
						<th scope="col" rowspan="2">Group</th>
						<th scope="col" rowspan="2" class="num">Demand<br /><span class="u">m³/day</span></th>
						<th scope="colgroup" class="g1">1. Today</th>
						<th scope="colgroup" colspan="3" class="g2">2. Equitable share <span class="u">(hydrological units, ex EWR)</span></th>
						<th scope="colgroup" colspan="3" class="g3">3. EWR met</th>
					</tr>
					<tr>
						<th scope="col" class="g1">Supplied<br /><span class="u">% of demand, m³/day</span></th>
						<th scope="col" class="num g2">Equitable share volume<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Change from today<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Share<br /><span class="u">% of demand</span></th>
						<th scope="col" class="num g3">EWR charge<br /><span class="u">m³/day charged</span></th>
						<th scope="col" class="num">Total change<br /><span class="u">from today, m³/day</span></th>
						<th scope="col">Left<br /><span class="u">% of demand, m³/day</span></th>
					</tr>
				</thead>
				<tbody>
					{#each board.farms as r (r.nodeId)}
						<tr data-node={r.nodeId}>
							<th scope="row">{r.name}</th>
							<td class="num" data-label="Demand, m³/day">{r.demand}</td>
							<td class="g1" data-label="1. Supplied today">{@render cell(r.today)}</td>
							<td class="num g2" data-label="2. Equitable share, m³/day">{r.share?.target.volume ?? '–'}</td>
							<td class="num" data-label="2. Change from today">{#if r.share}{@render chg(r.share.change)}{:else}–{/if}</td>
							<td class="num" data-label="2. Share of demand" title={r.share?.target.pctTitle ?? undefined}>{r.share?.target.pct ?? '–'}</td>
							<td class="num g3" data-label="3. EWR charge, m³/day">{r.ewrStage.charge}</td>
							<td class="num" data-label="3. Total change">{@render chg(r.ewrStage.totalChange)}</td>
							<td data-label="3. Left once the EWR is met">
								{@render cell(r.ewr)}
								{#each r.ewrNotes as n (n)}<span class="note-line">{n}</span>{/each}
							</td>
						</tr>
					{/each}
					<tr class="total">
						<th scope="row">All hydrological units</th>
						<td class="num" data-label="Demand, m³/day">{t.demand}</td>
						<td class="g1" data-label="1. Supplied today">{@render cell(t.today)}</td>
						<td class="num g2" data-label="2. Equitable share, m³/day">{t.share?.target.volume ?? '–'}</td>
						<td class="num" data-label="2. Change from today">{#if t.share}{@render chg(t.share.change)}{:else}–{/if}</td>
						<td class="num" data-label="2. Share of demand">{t.share?.target.pct ?? '–'}</td>
						<td class="num g3" data-label="3. EWR charge, m³/day">{t.ewrStage.charge}</td>
						<td class="num" data-label="3. Total change">{@render chg(t.ewrStage.totalChange)}</td>
						<td data-label="3. Left once the EWR is met">{@render cell(t.ewr)}</td>
					</tr>
				</tbody>
				{#if board.users.length && board.userTotals}
					{@const u = board.userTotals}
					<tbody>
						<tr class="section">
							<th scope="colgroup" colspan="9">Other water users <span class="u">(outside the equitable share)</span></th>
						</tr>
						{#each board.users as r (r.nodeId)}
							<tr data-node={r.nodeId}>
								<th scope="row">
									{r.name}
									<span class="badge" class:badge-senior={r.priority === 'senior'}>{r.priorityLabel}</span>
								</th>
								<td class="num" data-label="Demand, m³/day">{r.demand}</td>
								<td class="g1" data-label="1. Supplied today">{@render cell(r.today)}</td>
								<td class="num g2 outside" colspan="3" data-label="2. Equitable share">outside the share</td>
								<td class="num g3" data-label="3. EWR charge, m³/day">{r.ewrStage.charge}</td>
								<td class="num" data-label="3. Total change">{@render chg(r.ewrStage.totalChange)}</td>
								<td data-label="3. Left once the EWR is met">
									{@render cell(r.ewr)}
									{#each r.ewrNotes as n (n)}<span class="note-line">{n}</span>{/each}
								</td>
							</tr>
						{/each}
						<tr class="total">
							<th scope="row">All other users</th>
							<td class="num" data-label="Demand, m³/day">{u.demand}</td>
							<td class="g1" data-label="1. Supplied today">{@render cell(u.today)}</td>
							<td class="num g2 outside" colspan="3" data-label="2. Equitable share">outside the share</td>
							<td class="num g3" data-label="3. EWR charge, m³/day">{u.ewrStage.charge}</td>
							<td class="num" data-label="3. Total change">{@render chg(u.ewrStage.totalChange)}</td>
							<td data-label="3. Left once the EWR is met">{@render cell(u.ewr)}</td>
						</tr>
					</tbody>
				{/if}
			</table>
		</div>
	</div>
	<p class="muted small note" id="share-board-footnote">
		<strong>* {EQUITABLE_SHARE_FOOTNOTE}</strong> South African restrictions are set per user category (the Reserve first,
		then domestic supply, irrigation among the first cut), not as one share for everyone. A + change is not water a hydrological unit
		can get: a surplus downstream can't reach a unit upstream.
	</p>
	<p class="muted small note">
		<em>EWR met</em> starts from the equitable share and removes each hydrological unit's supply cut for its EWR charge; it never goes
		below 0 % of demand, or below a hydrological unit's basic-needs floor ({DEMAND_NORMS.basicLitresPerPersonDay} litres a person a
		day for the people its domestic and municipal demands serve; what the floor keeps of the cut is noted in its row). The total change
		differs from the EWR charge: part of a charge may be met by storing less or passing inflow, which takes no supply, and part of what
		is pumped returns to the river, so the supply cut that removes the rest is larger than it.
		A hydrological unit with no demand has nothing to cut: any charge it carries is to store less or pass inflow,
		noted in its row. A non-priority user is cut for its charge; a priority one is not, and its charge stands, unless it has a
		fixed restriction %: then it is cut by at most that share of its demand, with no basic-needs floor.
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
		margin: 0.75rem 0 0.5rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.5rem;
	}
	.stages li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--border);
		border-top-width: 3px;
		border-radius: var(--radius);
		background: var(--surface);
	}
	/* Each stage's edge, the same on its card and its columns in the table (the step number says which, too). */
	.stages li.stage-1 {
		border-top-color: var(--series-1);
	}
	.stages li.stage-2 {
		border-top-color: var(--series-2);
	}
	.stages li.stage-3 {
		border-top-color: var(--series-3);
	}
	.stage-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.step {
		display: inline-grid;
		place-items: center;
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--text);
		font-size: var(--font-xs);
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
	.stage-big .u {
		font-size: 0.9rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.legend {
		list-style: none;
		padding: 0;
		margin: 0 0 0.6rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.legend i {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		margin-right: 0.3rem;
		vertical-align: -0.05rem;
	}
	.fn-ref {
		margin-left: 0.1rem;
		/* A link inside text is told apart by more than colour (WCAG 1.4.1). */
		text-decoration: underline;
	}
	tr.group th {
		text-align: center;
		border-bottom: 1px solid var(--border);
	}
	tr.group th:first-child,
	tr.group th:nth-child(2) {
		text-align: left;
		vertical-align: bottom;
	}
	/* Where each stage starts, in the table as on its card. */
	th.g1,
	td.g1 {
		box-shadow: inset 3px 0 0 var(--series-1);
	}
	th.g2,
	td.g2 {
		box-shadow: inset 3px 0 0 var(--series-2);
	}
	th.g3,
	td.g3 {
		box-shadow: inset 3px 0 0 var(--series-3);
	}
	/* Bar and % on one line, the volume under them: nine columns fit 1440 without scrolling. */
	.stage-cell {
		display: inline-grid;
		grid-template-columns: auto auto;
		align-items: center;
		gap: 0 0.4rem;
		white-space: nowrap;
	}
	.stage-cell .vol {
		grid-column: 1 / -1;
	}
	/* The board's heads wrap (the app's table heads don't), so a column is as wide as its figures. */
	.share-board thead th {
		white-space: normal;
	}
	.pct {
		min-width: 3.2rem;
		text-align: right;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.vol {
		color: var(--text-muted);
		font-size: var(--font-sm);
		font-variant-numeric: tabular-nums;
	}
	.bar {
		flex: none;
		width: 3rem;
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
	.fill.met,
	.legend .met {
		background: var(--accent);
	}
	.fill.short,
	.legend .short {
		background: var(--warning);
	}
	.fill.low,
	.legend .low {
		background: var(--danger);
	}
	.chg {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.arrow {
		margin-right: 0.15rem;
	}
	.neg {
		color: var(--danger);
	}
	.pos {
		color: var(--success);
	}
	td.outside {
		color: var(--text-muted);
		font-style: italic;
		text-align: center;
	}
	.note-line {
		display: block;
		font-size: var(--font-xs);
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
	/* Stacked (the shared .table-stack under 50rem): a cell is a grid cell a few rem wide, so the bar, % and volume
	   wrap inside it rather than spilling into the next one, and the stage edges move off the labels. */
	@container table-stack (max-width: 50rem) {
		.stage-cell {
			display: flex;
			flex-wrap: wrap;
			white-space: normal;
			gap: 0.1rem 0.4rem;
		}
		.pct {
			min-width: 0;
			text-align: left;
		}
		th.g1,
		td.g1,
		th.g2,
		td.g2,
		th.g3,
		td.g3 {
			box-shadow: none;
		}
		td.outside {
			text-align: left;
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
