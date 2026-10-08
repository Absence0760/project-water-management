<!--
	The WR2012 five-statistic table (calibration research CR-28): MAR, mean of
	log annual flows, SD, log SD and seasonal index of observed and simulated
	flow on complete water years of monthly volumes, each with its % difference
	and good-fit band. Shown beside KGE′/NSE in the fit results and in a run's
	calibration panel. The bands are labelled indicative until confirmed
	(WR2012_GOOD_FIT_BANDS in the engine).
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { wr2012BandsNote, wr2012FitRows, wr2012FitSummary, type Wr2012FitPeriod } from '$lib/calibration/wr2012Fit';

	let { periods }: { periods: Wr2012FitPeriod[] } = $props();

	const uid = $props.id();
	let picked = $state<string | null>(null);
	const current = $derived(periods.find((p) => p.id === picked) ?? periods[0]);
	const rows = $derived(current ? wr2012FitRows(current.stats) : []);
</script>

{#if current}
	<div class="wr2012-fit" data-testid="wr2012-fit">
		<div class="head">
			<h4 id="{uid}-h">WR2012 statistics <HelpTip key="stats.wr2012Fit" /> <span class="muted">(monthly flows, hydrological years)</span></h4>
			{#if periods.length > 1}
				<label class="pick">
					<span>Period</span>
					<select value={current.id} onchange={(e) => (picked = e.currentTarget.value)}>
						{#each periods as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
					</select>
				</label>
			{/if}
		</div>
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-h">
				<thead>
					<tr>
						<th scope="col">Statistic</th>
						<th scope="col" class="num">Observed</th>
						<th scope="col" class="num">Simulated</th>
						<th scope="col" class="num">Difference</th>
						<th scope="col" class="num">{current.stats.bandsConfirmed ? 'Good fit' : 'Indicative band'}</th>
						<th scope="col">Fit</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr>
							<th scope="row">{r.label} <span class="u">{r.unit}</span></th>
							<td class="num">{r.observed}</td>
							<td class="num">{r.simulated}</td>
							<td class="num">{r.diff}</td>
							<td class="num">{r.band}</td>
							<td>
								{#if r.verdict === 'none'}<span class="muted small">{r.verdictText}</span>{:else}<span class="badge" class:badge-warn={r.verdict === 'outside'} data-verdict={r.verdict}>{r.verdictText}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">{wr2012FitSummary(current.stats)}</p>
		<p class="muted small">
			{wr2012BandsNote(current.stats.bandsConfirmed)} A month counts when at least 90 % of its days are observed; a water year
			only when all 12 do.
		</p>
	</div>
{/if}

<style>
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		margin-top: 0.75rem;
	}
	h4 {
		margin: 0 0 0.25rem;
	}
	h4 .muted {
		font-weight: 400;
		font-size: 0.8rem;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.u {
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.badge {
		text-transform: none;
		white-space: nowrap;
	}
</style>
