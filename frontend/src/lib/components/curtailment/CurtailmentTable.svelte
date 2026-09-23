<!--
	Curtailment targets per farm: the b023 [Shortfalls] report over the run's
	reporting window (RunSummary.curtailment, engine ≥ 0.3.0). Formulas and
	workbook quirks: docs/model.md §2.11. Sign convention: negative = reduce,
	positive = may gain.
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { curtailmentRows, cutCount, fmtSigned, fmtVol } from './curtailment';

	let {
		summary,
		farmNames = {}
	}: {
		summary: RunSummary;
		/** Current farm names by node id, for farms renamed since the run. */
		farmNames?: Record<string, string>;
	} = $props();

	const c = $derived(summary.curtailment ?? null);
	const rows = $derived(c ? curtailmentRows(c, farmNames) : []);
	const cuts = $derived(c ? cutCount(c) : 0);
</script>

<section class="curtailment" aria-labelledby="curtailment-heading">
	<h3 id="curtailment-heading">Curtailment targets</h3>
	{#if !c}
		<p class="muted">
			This run was made before curtailment targets were added. Run the model again to see them.
		</p>
	{:else if c.farms.length === 0}
		<p class="muted">This run has no farms, so there is nothing to curtail.</p>
	{:else}
		<p class="muted small">
			Daily averages over {c.reportStart} – {c.reportEnd} ({fmtNum(c.days)} day{c.days === 1 ? '' : 's'}).
			{#if c.equitableFraction === null}
				No farm had irrigation demand in this window, so there is no supply to share.
			{:else}
				The catchment supplied {fmtPct(c.equitableFraction)} of total demand. Each farm's
				<strong>target</strong> is that same share of its own demand.
			{/if}
		</p>
		<p class="muted small">
			<strong>Sign convention:</strong> <span class="neg">−</span> = reduce, <span class="pos">+</span> = may gain.
			<em>Reduce/gain</em> shares irrigation fairly (target − supplied). <em>Total change</em> also removes the
			farm's EWR shortfall. 1 l/s = 86.4 m³/day; l/s values are truncated toward zero, as in the workbook.
			{#if cuts}
				<span class="flag-key" aria-hidden="true"></span>
				{cuts} of {rows.length} farm{rows.length === 1 ? '' : 's'} must cut (highlighted).
			{:else}
				No farm needs to cut.
			{/if}
		</p>
		<div class="table-wrap">
			<table class="data">
				<caption class="visually-hidden">
					Curtailment targets per farm, {c.reportStart} to {c.reportEnd}. Negative values are
					reductions, positive values are gains.
				</caption>
				<thead>
					<tr class="group">
						<th scope="col" rowspan="2">Farm</th>
						<th scope="colgroup" colspan="3">Irrigation used</th>
						<th scope="colgroup" colspan="3">Fair share (ex EWR)</th>
						<th scope="colgroup" colspan="5">To balance and meet the EWR</th>
					</tr>
					<tr>
						<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Supplied<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Supplied<br /><span class="u">% of demand</span></th>
						<th scope="col" class="num">Target<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Reduce / gain<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Reduce / gain<br /><span class="u">l/s</span></th>
						<th scope="col" class="num">EWR shortfall<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Total change<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Total change<br /><span class="u">l/s</span></th>
						<th scope="col" class="num">Volume left<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Demand left<br /><span class="u">%</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.nodeId)}
						<tr class:flag={r.action === 'cut'}>
							<th scope="row">
								{r.name}
								{#if r.action === 'cut'}
									<span class="badge badge-warn">{r.verdict}</span>
								{:else if r.action === 'gain'}
									<span class="badge badge-gain">{r.verdict}</span>
								{/if}
							</th>
							<td class="num">{r.demand}</td>
							<td class="num">{r.supplied}</td>
							<td class="num">{r.suppliedPct}</td>
							<td class="num">{r.target}</td>
							<td class="num" class:neg={r.reduceGain.startsWith('-')} class:pos={r.reduceGain.startsWith('+')}>{r.reduceGain}</td>
							<td class="num" class:neg={r.reduceGainLs.startsWith('-')} class:pos={r.reduceGainLs.startsWith('+')}>{r.reduceGainLs}</td>
							<td class="num" class:neg={r.ewrShortfall.startsWith('-')}>{r.ewrShortfall}</td>
							<td class="num strong" class:neg={r.action === 'cut'} class:pos={r.action === 'gain'}>{r.totalChange}</td>
							<td class="num" class:neg={r.totalChangeLs.startsWith('-')} class:pos={r.totalChangeLs.startsWith('+')}>{r.totalChangeLs}</td>
							<td class="num">{r.volumeLeft}</td>
							<td class="num">{r.demandLeftPct}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">All farms</th>
						<td class="num">{fmtVol(c.totals.demandM3Day)}</td>
						<td class="num">{fmtVol(c.totals.suppliedM3Day)}</td>
						<td class="num">{fmtPct(c.equitableFraction)}</td>
						<td class="num">{fmtVol(c.totals.targetM3Day)}</td>
						<td class="num">{fmtSigned(c.totals.reduceGainM3Day)}</td>
						<td class="num">{fmtSigned(c.totals.reduceGainLs)}</td>
						<td class="num">{fmtSigned(c.totals.ewrShortfallM3Day, 0)}</td>
						<td class="num">{fmtSigned(c.totals.totalChangeM3Day)}</td>
						<td class="num"></td>
						<td class="num">{fmtVol(c.totals.volumeLeftM3Day)}</td>
						<td class="num"></td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="muted small note">
			The fair share assumes water can move between any two farms. It ignores where a farm sits in the network, so a
			“gain” may not be physically reachable. <em>Demand left</em> is volume left ÷ demand (the workbook labels
			this column “reduction of demand required”).
		</p>
	{/if}
</section>

<style>
	.curtailment h3 {
		margin-top: 1.1rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.note {
		margin-top: 0.5rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	tr.group th {
		text-align: center;
		border-bottom: 1px solid var(--border);
	}
	.neg {
		color: var(--danger);
	}
	.pos {
		color: var(--success);
	}
	td.strong {
		font-weight: 600;
	}
	.badge {
		margin-left: 0.35rem;
		text-transform: none;
	}
	.badge-gain {
		background: var(--success-soft);
		color: var(--success);
		border-color: transparent;
	}
	.flag-key {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		background: var(--row-flag);
		border: 1px solid var(--warning);
		vertical-align: -1px;
		margin-right: 0.25rem;
	}
</style>
