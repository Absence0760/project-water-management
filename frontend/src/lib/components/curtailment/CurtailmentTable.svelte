<!--
	Curtailment targets per farm: the b023 [Shortfalls] report over the run's
	reporting window (RunSummary.curtailment, engine ≥ 0.3.0). Formulas and
	workbook quirks: docs/model.md §2.11. Sign convention: negative = reduce,
	positive = below the equitable share; EWR charges and shortfalls are
	volumes, shown positive like the Farms table (issue #45). The equitable share is a fairness
	benchmark, never an allocation (audit Q11): no label says "gain".
-->
<script lang="ts">
	import { EQUITABLE_SHARE_FOOTNOTE, type CurtailmentSummary, type RunSummary } from '@water-management/engine';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { curtailmentRows, cutCount, ewrSiteRows, fmtCharged, fmtSigned, fmtVol } from './curtailment';
	import ShareThePainBoard from './ShareThePainBoard.svelte';
	import { basicNeedsNote } from './shareThePain';
	import { SUPPLY_TARGET } from '$lib/components/runs/results';

	let {
		summary,
		farmNames = {},
		curtailment,
		period,
		board = false
	}: {
		summary: RunSummary;
		/** Current farm names by node id, for farms renamed since the run. */
		farmNames?: Record<string, string>;
		/** The table over another window (runs/windowedCurtailment.ts, issue #44); absent = the run's own. */
		curtailment?: CurtailmentSummary | null;
		/** The name of the period shown ("Last 7 days"), put before its dates. */
		period?: string;
		/** Lead with the share-the-pain board (issue #53 R3) over the same window: the Runs tab shows it, the printable report doesn't. */
		board?: boolean;
	} = $props();

	const c = $derived(curtailment === undefined ? (summary.curtailment ?? null) : curtailment);
	const range = $derived(c ? `${c.reportStart} – ${c.reportEnd}` : '');
	const rows = $derived(c ? curtailmentRows(c, farmNames) : []);
	const cuts = $derived(c ? cutCount(c) : 0);
	const sites = $derived(c ? ewrSiteRows(c, farmNames) : []);
	/** Engine ≥ 0.17.0: R is the EWR charge at the EWR sites, split by what the farm can change (audit Q17). */
	const attributed = $derived(!!c?.ewrAttribution);
</script>

<section class="curtailment" aria-labelledby="curtailment-heading">
	<h3 id="curtailment-heading">Curtailment targets</h3>
	{#if !c}
		<p class="muted">
			This run was made before curtailment targets were added. Run the model again to see them.
		</p>
	{:else if c.farms.length === 0}
		<p class="muted">This run has no hydrological units, so there is nothing to curtail.</p>
	{:else}
		<p class="muted small">
			<span data-testid="curtailment-period">{#if period}<strong>{period}</strong>: daily averages{:else}Daily averages{/if} over {range} ({fmtNum(c.days)} day{c.days === 1 ? '' : 's'}).</span>
			{#if c.equitableFraction === null}
				No hydrological unit had irrigation demand in this window, so there is no supply to share.
			{:else}
				The catchment supplied {fmtPct(c.equitableFraction)} of total demand: the
				<strong>equitable share of supply (fairness benchmark)</strong>. Each hydrological unit's equitable share volume is that same
				share of its own demand.
			{/if}
		</p>
		{#if board}
			<ShareThePainBoard curtailment={c} names={farmNames} {period} />
			<h4 id="curtailment-farms-heading">Per hydrological unit</h4>
		{/if}
		<p class="muted small">
			<strong>Sign convention:</strong> <span class="neg">−</span> = reduce, <span class="pos">+</span> = below the equitable share.
			<em>Above (−) / below (+) equitable share</em> compares the supply with the fairness benchmark (equitable
			share volume − supplied). <em>Total change</em> also removes the
			hydrological unit's {attributed ? 'EWR charge' : 'EWR shortfall'}. {attributed ? 'EWR charge, irrigate less and store less' : 'EWR shortfall'}
			are volumes charged, shown without a sign, the same as in the Hydrological units table. 1 l/s = 86.4 m³/day.
			{#if cuts}
				<span class="flag-key" aria-hidden="true"></span>
				{cuts} of {rows.length} hydrological unit{rows.length === 1 ? '' : 's'} must cut (highlighted).
			{:else}
				No hydrological unit needs to cut.
			{/if}
		</p>
		<div class="table-wrap">
			<table class="data">
				<caption class="visually-hidden">
					Curtailment targets per hydrological unit, {period ? `${period}, ` : ''}{c.reportStart} to {c.reportEnd}. Negative changes are
					reductions, positive ones are below the equitable share; EWR charges are volumes charged.
				</caption>
				<thead>
					<tr class="group">
						<th scope="col" rowspan="2">Hydrological unit</th>
						<th scope="colgroup" colspan="3">Irrigation used</th>
						<th scope="colgroup" colspan="3">Equitable share (fairness benchmark, ex EWR)</th>
						<th scope="colgroup" colspan={attributed ? 10 : 5}>To balance and meet the EWR</th>
					</tr>
					<tr>
						<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Supplied<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Supplied<br /><span class="u">% of demand</span></th>
						<th scope="col" class="num">Equitable share volume<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Above (−) / below (+) equitable share<br /><span class="u">m³/day</span></th>
						<th scope="col" class="num">Above (−) / below (+) equitable share<br /><span class="u">l/s</span></th>
						<th scope="col" class="num">{attributed ? 'EWR charge' : 'EWR shortfall'}<br /><span class="u">m³/day charged</span></th>
						{#if attributed}
							<th scope="col" class="num" title="The part of the EWR charge met by irrigating less">Irrigate less<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num" title="The part of the EWR charge met by storing less or passing inflow">Store less / pass inflow<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num" title="The cut in supply that meets the irrigation part: irrigate less ÷ (1 − β(1 − e))">Supply cut<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Supply cut<br /><span class="u">l/s</span></th>
							<th scope="col">EWR site<br /><span class="u">setting the charge</span></th>
						{/if}
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
								{:else if r.action === 'store'}
									<span class="badge">{r.verdict}</span>
								{/if}
								{#if r.beyondShare}
									<span class="badge badge-warn">EWR cut exceeds this hydrological unit's equitable share by {r.beyondShare} m³/day</span>
								{/if}
								{#if r.basicNeedsHeld}
									<span class="badge" data-testid="basic-needs-held">{basicNeedsNote(r.basicNeedsHeld, r.basicNeeds)}</span>
								{/if}
							</th>
							<td class="num">{r.demand}</td>
							<td class="num">{r.supplied}</td>
							<td class="num">{r.suppliedPct}</td>
							<td class="num">{r.target}</td>
							<td class="num" class:neg={r.reduceGain.startsWith('-')} class:pos={r.reduceGain.startsWith('+')}>{r.reduceGain}</td>
							<td class="num" class:neg={r.reduceGainLs.startsWith('-')} class:pos={r.reduceGainLs.startsWith('+')}>{r.reduceGainLs}</td>
							<td class="num">{r.ewrShortfall}</td>
							{#if attributed}
								<td class="num">{r.ewrIrrigation}</td>
								<td class="num">{r.ewrStorage}</td>
								<td class="num" class:neg={r.supplyCut.startsWith('-')}>{r.supplyCut}</td>
								<td class="num" class:neg={r.supplyCutLs.startsWith('-')}>{r.supplyCutLs}</td>
								<td>{r.bindingSite}</td>
							{/if}
							<td class="num strong" class:neg={r.action === 'cut'} class:pos={r.action === 'gain'}>{r.totalChange}</td>
							<td class="num" class:neg={r.totalChangeLs.startsWith('-')} class:pos={r.totalChangeLs.startsWith('+')}>{r.totalChangeLs}</td>
							<td class="num">{r.volumeLeft}</td>
							<td class="num" title={r.demandLeftTitle ?? undefined}>{r.demandLeftPct}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">All hydrological units</th>
						<td class="num">{fmtVol(c.totals.demandM3Day)}</td>
						<td class="num">{fmtVol(c.totals.suppliedM3Day)}</td>
						<td class="num">{fmtPct(c.equitableFraction)}</td>
						<td class="num">{fmtVol(c.totals.targetM3Day)}</td>
						<td class="num">{fmtSigned(c.totals.reduceGainM3Day)}</td>
						<td class="num">{fmtSigned(c.totals.reduceGainLs)}</td>
						<td class="num">{fmtCharged(c.totals.ewrShortfallM3Day)}</td>
						{#if attributed}
							<td class="num">{fmtCharged(c.totals.ewrChargeIrrigationM3Day)}</td>
							<td class="num">{fmtCharged(c.totals.ewrChargeStorageM3Day)}</td>
							<td class="num">{fmtSigned(c.totals.ewrSupplyCutM3Day)}</td>
							<td class="num"></td>
							<td></td>
						{/if}
						<td class="num">{fmtSigned(c.totals.totalChangeM3Day)}</td>
						<td class="num"></td>
						<td class="num">{fmtVol(c.totals.volumeLeftM3Day)}</td>
						<td class="num"></td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p class="muted small note">
			<strong>{EQUITABLE_SHARE_FOOTNOTE}</strong> A positive value is not water the hydrological unit can get: a surplus downstream
			can't reach a hydrological unit upstream. <em>Demand left</em> is volume left ÷ demand (the workbook labels
			this column “reduction of demand required”), as a whole %; “—” means demand under 1 m³/day, where a % is
			not meaningful. {#if attributed}<em>Total change</em> and <em>volume left</em> count only the supply cut; the
			volume left never goes below 0, and a hydrological unit whose EWR cut is larger than its equitable share is flagged.{/if}
		</p>
		{#if attributed}
			<p class="muted small note">
				<strong>EWR charge:</strong> the EWR is assessed at each EWR site (the outlet and every gauge). A site's
				shortfall is charged to the hydrological units upstream of it in proportion to their net impact that day (inflow + runoff +
				transfers − outflow); the part the hydrological units did not cause is natural. A hydrological unit above several sites carries the
				largest of its charges. The charge splits by what the hydrological unit can change: irrigating less, or storing less and
				passing inflow. <span data-testid="supply-cut-note"
					>Supply cuts are larger than the irrigate-less charge because part of what a hydrological unit pumps returns to the river.</span
				>
			</p>
		{/if}
		{#if c.otherUsers?.length}
			<h4 id="other-users-heading">Other water users</h4>
			<p class="muted small">
				Towns, industry and unlisted users are outside the irrigation equitable share. They are charged for the EWR by
				their net impact (taken − returned) like hydrological units. A <strong>junior</strong> user is curtailed for its charge; a
				<strong>senior</strong> one is not, and its charge stands (it is not moved onto the hydrological units). Daily averages over {range}.
			</p>
			<div class="table-wrap">
				<table class="data" aria-labelledby="other-users-heading">
					<thead>
						<tr>
							<th scope="col">User</th>
							<th scope="col">Priority</th>
							<th scope="col" class="num">Demand<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Taken<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Supplied<br /><span class="u">% of demand</span></th>
							<th scope="col" class="num">Returned<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">EWR charge<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Supply cut<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Charge left standing<br /><span class="u">m³/day</span></th>
						</tr>
					</thead>
					<tbody>
						{#each c.otherUsers as u (u.nodeId)}
							{@const short = u.fractionSupplied !== null && u.fractionSupplied < SUPPLY_TARGET}
							<tr>
								<th scope="row">{farmNames[u.nodeId] ?? u.name}{#if short}<span class="badge badge-warn">below {fmtPct(SUPPLY_TARGET, 0)}</span>{/if}</th>
								<td>{u.curtailed ? 'junior (curtailed)' : 'senior (not curtailed)'}</td>
								<td class="num">{fmtVol(u.demandM3Day)}</td>
								<td class="num">{fmtVol(u.suppliedM3Day)}</td>
								<td class="num" class:neg={short}>{u.fractionSupplied === null ? '–' : fmtPct(u.fractionSupplied)}</td>
								<td class="num">{fmtVol(u.returnedM3Day)}</td>
								<td class="num">{fmtCharged(u.ewrChargeM3Day)}</td>
								<td class="num" class:neg={u.supplyCutM3Day < 0}>{fmtSigned(u.supplyCutM3Day)}</td>
								<td class="num">{fmtCharged(u.uncurtailedChargeM3Day)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if sites.length}
			<h4 id="ewr-sites-heading">EWR sites</h4>
			<p class="muted small">Days not met and daily averages over {range}; shortfalls are volumes (m³/day), shown positive.</p>
			{#if sites.length === 1}
				<p class="muted small">
					EWR assessed at 1 site (outlet). Add gauges at the Reserve determination's EWR sites to protect upstream
					reaches.
				</p>
			{/if}
			<div class="table-wrap">
				<table class="data" aria-labelledby="ewr-sites-heading">
					<thead>
						<tr>
							<th scope="col">Site</th>
							<th scope="col" class="num">Hydrological units upstream</th>
							<th scope="col" class="num">Days not met</th>
							<th scope="col" class="num">Shortfall<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Charged to hydrological units<br /><span class="u">m³/day</span></th>
							<th scope="col" class="num">Natural<br /><span class="u">m³/day</span></th>
						</tr>
					</thead>
					<tbody>
						{#each sites as s (s.nodeId)}
							<tr>
								<th scope="row">{s.name}</th>
								<td class="num">{s.farmCount}</td>
								<td class="num">{s.daysNotMet}</td>
								<td class="num">{s.shortfall}</td>
								<td class="num">{s.charged}</td>
								<td class="num">{s.natural}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</section>

<style>
	.curtailment h3 {
		margin-top: 1.1rem;
	}
	.note {
		margin-top: 0.5rem;
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
