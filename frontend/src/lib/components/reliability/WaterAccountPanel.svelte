<!--
	The water account (engine ≥ 0.32.0, WP-3.4, docs/model.md §2.11b): per
	water year and over the run, what came into the river network, where it
	went, the change in dam storage and the closure residual; a pair of bars
	for one period (in vs out); EWR required vs met at each site. Input:
	RunSummary.supplyAssurance.waterAccount; absent on older runs.
-->
<script lang="ts">
	import type { SupplyAssurance, WaterAccountRow } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { waterYearLabel } from '$lib/components/calibration/metrics';
	import { fmtVolume } from '$lib/components/ewr/heatmap';
	import { accountBars, accountLines, ewrMetShare, notComputedText, pctText } from './reliability';

	let {
		assurance,
		engineVersion = null
	}: {
		assurance: SupplyAssurance | undefined | null;
		engineVersion?: string | null;
	} = $props();

	const uid = $props.id();
	const account = $derived(assurance?.waterAccount ?? null);
	const rows = $derived(account ? [...account.years, account.total] : []);
	const lines = $derived(accountLines(rows));
	/** The period the bars show: 'run' or a water year. */
	let period = $state<string>('run');
	const shown = $derived<WaterAccountRow | null>(
		account ? (period === 'run' ? account.total : (account.years.find((y) => String(y.waterYear) === period) ?? account.total)) : null
	);
	const bars = $derived(shown ? accountBars(shown) : null);
	const barRows = $derived(bars ? [{ name: 'In', segs: bars.inBar }, { name: 'Out and stored', segs: bars.outBar }] : []);
	const label = (r: WaterAccountRow) => (r.waterYear === null ? 'Whole run' : waterYearLabel(r.waterYear));
	const worstResidual = $derived(rows.reduce((m, r) => Math.max(m, Math.abs(r.residualM3) / Math.max(r.scaleM3, 1)), 0));
</script>

<section class="water-account" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Water account</h3>
	{#if !account}
		<p class="muted" data-testid="account-not-computed">{notComputedText(engineVersion)}</p>
	{:else}
		<p class="muted">
			What entered the river network, where it went and what stayed in the units’ dams, per water year (October to September). In − out − change
			in storage leaves a residual that should be float noise; the largest here is {worstResidual === 0 ? 'exactly 0' : `${worstResidual.toExponential(1)} of the flows`}.
			Dam releases are not modelled yet.
		</p>

		{#if bars && shown}
			<div class="head">
				<h4 id="{uid}-bh">In and out: {label(shown)}</h4>
				<div class="field inline">
					<label for="{uid}-p">Period</label>
					<select id="{uid}-p" bind:value={period}>
						<option value="run">Whole run</option>
						{#each account.years as y (y.waterYear)}
							<option value={String(y.waterYear)}>{waterYearLabel(y.waterYear!)}</option>
						{/each}
					</select>
				</div>
			</div>
			<div class="bars" role="group" aria-labelledby="{uid}-bh" data-testid="account-bars">
				{#each barRows as { name, segs } (name)}
					<div class="bar-row">
						<span class="bar-name">{name}</span>
						<div class="bar" aria-hidden="true">
							{#each segs as s, i (s.key)}
								<span class="seg s{i % 6}" style:width="{s.pct}%" title="{s.label}: {fmtVolume(s.m3)} ({fmtNum(s.pct, 1)}%)"></span>
							{/each}
						</div>
						<ul class="bar-key">
							{#each segs as s, i (s.key)}
								<li><span class="dot s{i % 6}" aria-hidden="true"></span>{s.label}: {fmtVolume(s.m3)} ({fmtNum(s.pct, 1)}%)</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		{/if}

		<div class="table-wrap scroll">
			<table class="data" data-testid="account-table">
				<caption class="visually-hidden">Water account per water year and over the whole run, m³</caption>
				<thead>
					<tr>
						<th scope="col">m³</th>
						{#each rows as r (r.waterYear ?? 'run')}<th scope="col" class="num">{label(r)}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#each lines as l (l.key)}
						<tr class={l.side}>
							<th scope="row">{l.side === 'in' ? 'In: ' : l.side === 'out' ? 'Out: ' : ''}{l.label}</th>
							{#each rows as r (r.waterYear ?? 'run')}
								{@const v = r[l.key]}
								<td class="num">{typeof v === 'number' ? (l.side === 'check' ? v.toPrecision(2) : fmtNum(v)) : '–'}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if account.total.ewr.length}
			<h4>EWR required vs met</h4>
			<div class="table-wrap scroll">
				<table class="data" data-testid="account-ewr">
					<caption class="visually-hidden">EWR required and met at each site per water year, m³</caption>
					<thead>
						<tr>
							<th scope="col">Site</th>
							{#each rows as r (r.waterYear ?? 'run')}<th scope="col" class="num">{label(r)}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each account.total.ewr as site, si (site.nodeId ?? 'outlet')}
							<tr>
								<th scope="row">{site.name}{site.nodeId === null ? ' (outlet)' : ''}</th>
								{#each rows as r (r.waterYear ?? 'run')}
									{@const e = r.ewr[si]}
									<td class="num">
										{#if e}{pctText(ewrMetShare(e), 1)} <span class="muted">of {fmtVolume(e.requiredM3)}; {fmtNum(e.daysNotMet)} days short</span>{:else}–{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="note muted">Met = the part of the requirement that passed the site (the flow, capped at the requirement each day).</p>
		{/if}
	{/if}
</section>

<style>
	.water-account {
		--seg-0: #2a78d6;
		--seg-1: #d67a2a;
		--seg-2: #3a9a5b;
		--seg-3: #8a5bd6;
		--seg-4: #c24a6b;
		--seg-5: #6b7c85;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin: 0.75rem 0 0.5rem;
	}
	.head h4 {
		margin: 0;
	}
	.field.inline {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
	}
	.bars {
		display: grid;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}
	.bar-name {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.bar {
		display: flex;
		height: 1.1rem;
		border-radius: 3px;
		overflow: hidden;
		border: 1px solid var(--border);
		margin: 0.2rem 0;
	}
	.seg {
		display: block;
		height: 100%;
	}
	.bar-key {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.9rem;
		font-size: 0.78rem;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.bar-key li {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
	}
	.s0 {
		background: var(--seg-0);
	}
	.s1 {
		background: var(--seg-1);
	}
	.s2 {
		background: var(--seg-2);
	}
	.s3 {
		background: var(--seg-3);
	}
	.s4 {
		background: var(--seg-4);
	}
	.s5 {
		background: var(--seg-5);
	}
	.scroll {
		overflow-x: auto;
	}
	tr.check th,
	tr.check td,
	tr.memo th,
	tr.memo td {
		color: var(--text-muted);
	}
	tr.storage th,
	tr.storage td {
		border-top: 1px solid var(--border);
	}
	.note {
		font-size: 0.8rem;
		margin-top: 0.4rem;
	}
</style>
