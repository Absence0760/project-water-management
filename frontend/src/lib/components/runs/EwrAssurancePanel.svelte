<!--
	A run's Reserve compliance (RunSummary.ewrAssurance, engine ≥ 0.21.0;
	docs/model.md §2.9c): per EWR site with a rule table, the months met, the
	share met per month of the year (chart and table), the FDC check, and each
	month in a collapsed table.
-->
<script lang="ts">
	import { EWR_ASSURANCE_MIN_YEARS, type EwrAssuranceSite } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import { conditionText, describeMethod, fdcText, fewYears, fmtFlow, fmtMm3, monthLabel, shareOfRequired, UNIT_LABEL, verdict } from './ewrAssurance';

	let {
		sites,
		print = false
	}: {
		sites: EwrAssuranceSite[];
		/** The printable report: Month by month opens (the report shows each site in its own panel). */
		print?: boolean;
	} = $props();

	const uid = $props.id();
	let chosen = $state(0);
	const site = $derived(sites[Math.min(chosen, sites.length - 1)]!);
	const u = $derived(UNIT_LABEL[site.unit] ?? site.unit);
	const few = $derived(fewYears(site, EWR_ASSURANCE_MIN_YEARS));
	const rateClass = (r: number | null) => (r === null ? 'none' : r >= 1 ? 'good' : r >= 0.8 ? 'ok' : 'bad');

	// The chart: share of months met per month of the year, on a fixed 0–100 % axis.
	const W = 480;
	const H = 150;
	const TOP = 16;
	const BOTTOM = 18;
	const bw = W / 12;
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Reserve compliance by month <HelpTip key="reserve-compliance" /></h3>
	{#if sites.length > 1}
		<div class="field site">
			<label for="{uid}-site">EWR site</label>
			<select id="{uid}-site" bind:value={chosen}>
				{#each sites as s, i (s.nodeId ?? '(outlet)')}<option value={i}>{s.isOutlet ? `Outlet (${s.name})` : s.name}</option>{/each}
			</select>
		</div>
	{/if}
	<p class="muted small">{describeMethod(site)} Source: {site.source}</p>

	<p class="flag {rateClass(site.overall.rate)}" role="status">
		<strong>{site.isOutlet ? `Outlet (${site.name})` : site.name}:</strong>
		{verdict(site)}
	</p>
	{#if few !== null}
		<p class="small caution">
			Some calendar months have only {fmtNum(few)} complete year{few === 1 ? '' : 's'} in the run (fewer than {EWR_ASSURANCE_MIN_YEARS}){site.naturalSource === 'run'
				? ', so the natural-flow percentiles rest on few years'
				: ''}: read the rates as indicative.
		</p>
	{/if}

	<dl class="stats">
		<div class="stat">
			<dt>Months met</dt>
			<dd>{site.overall.rate === null ? '–' : fmtPct(site.overall.rate)}</dd>
			<dd class="sub">{fmtNum(site.overall.met)} of {fmtNum(site.overall.months)}</dd>
		</div>
		<div class="stat">
			<dt>Longest run not met</dt>
			<dd>{fmtNum(site.overall.longestNotMetRun)}<small>months</small></dd>
			<dd class="sub">consecutive months below the requirement</dd>
		</div>
		<div class="stat">
			<dt>Deficit</dt>
			<dd>{fmtMm3(site.overall.deficitM3)}<small>Mm³</small></dd>
			<dd class="sub">
				{site.overall.meanShortfallPct === null ? 'no month short' : `short months average ${fmtNum(site.overall.meanShortfallPct, 0)} % below`}
			</dd>
		</div>
		<div class="stat">
			<dt>FDC check</dt>
			<dd>{site.fdc.rate === null ? '–' : fmtPct(site.fdc.rate, 0)}</dd>
			<dd class="sub">{fmtNum(site.fdc.met)} of {fmtNum(site.fdc.cells)} month × % point checks: simulated flow duration on or above the EWR curve</dd>
		</div>
	</dl>

	<svg viewBox="0 0 {W} {H}" class="bars" role="img" aria-label="Share of months met per month of the year at {site.name} (the table below holds the values)">
		{#each [0, 0.5, 1] as g (g)}
			<line x1="0" x2={W} y1={H - BOTTOM - g * (H - BOTTOM - TOP)} y2={H - BOTTOM - g * (H - BOTTOM - TOP)} class="grid" />
		{/each}
		{#each site.byMonth as m, i (m.month)}
			{@const h = (m.rate ?? 0) * (H - BOTTOM - TOP)}
			<g>
				<title>{monthName(m.month)}: {m.rate === null ? 'not assessed' : `${fmtNum(m.met)} of ${fmtNum(m.years)} met`}</title>
				{#if m.rate !== null}
					<rect x={i * bw + 5} y={H - BOTTOM - h} width={bw - 10} height={Math.max(h, 1)} rx="2" class={rateClass(m.rate)} />
					<text x={i * bw + bw / 2} y={H - BOTTOM - h - 3} class="v">{fmtNum(m.rate * 100, 0)}</text>
				{:else}
					<text x={i * bw + bw / 2} y={H - BOTTOM - 3} class="v">–</text>
				{/if}
				<text x={i * bw + bw / 2} y={H - 4} class="m">{monthName(m.month)}</text>
			</g>
		{/each}
		<text x="2" y="10" class="axis">% of months met</text>
	</svg>

	<div class="table-wrap">
		<table class="data compact" aria-labelledby="{uid}-moy">
			<caption id="{uid}-moy">By month of the year: months met and mean flows ({u})</caption>
			<thead>
				<tr>
					<th scope="col">Month</th>
					<th scope="col" class="num">Years</th>
					<th scope="col" class="num">Met</th>
					<th scope="col" class="num">Met <span class="u">%</span></th>
					<th scope="col" class="num">Mean required <span class="u">{u}</span></th>
					<th scope="col" class="num">Mean simulated <span class="u">{u}</span></th>
					<th scope="col" class="num">Deficit <span class="u">Mm³</span></th>
					<th scope="col" class="num">FDC points met</th>
				</tr>
			</thead>
			<tbody>
				{#each site.byMonth as m (m.month)}
					<tr>
						<th scope="row">{monthName(m.month)}</th>
						<td class="num">{fmtNum(m.years)}</td>
						<td class="num">{m.years ? fmtNum(m.met) : '–'}</td>
						<td class="num" class:short={m.rate !== null && m.rate < 1}>{m.rate === null ? '–' : fmtPct(m.rate, 0)}</td>
						<td class="num">{fmtFlow(m.meanRequired)}</td>
						<td class="num">{fmtFlow(m.meanActual)}</td>
						<td class="num">{m.years ? fmtMm3(m.deficitM3) : '–'}</td>
						<td class="num">{fdcText(m.fdc)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<details open={print}>
		<summary>Month by month ({fmtNum(site.months.length)} months)</summary>
		<div class="table-wrap months">
			<table class="data compact" aria-labelledby="{uid}-each">
				<caption id="{uid}-each">Each complete month: natural flow, its condition, the requirement it selects and the simulated flow ({u})</caption>
				<thead>
					<tr>
						<th scope="col">Month</th>
						<th scope="col" class="num">Natural <span class="u">{u}</span></th>
						<th scope="col" class="num">Condition <span class="u">% exceedance</span></th>
						<th scope="col" class="num">Required <span class="u">{u}</span></th>
						<th scope="col" class="num">Simulated <span class="u">{u}</span></th>
						<th scope="col" class="num">Of required</th>
						<th scope="col">Met</th>
					</tr>
				</thead>
				<tbody>
					{#each site.months as m (`${m.year}-${m.month}`)}
						<tr class:short-row={!m.met}>
							<th scope="row">{monthLabel(m)}</th>
							<td class="num">{fmtFlow(m.natural)}</td>
							<td class="num">{conditionText(m)}</td>
							<td class="num">{fmtFlow(m.required)}</td>
							<td class="num">{fmtFlow(m.actual)}</td>
							<td class="num">{shareOfRequired(m)}</td>
							<td>{m.met ? 'met' : 'not met'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</section>

<style>
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.site {
		max-width: 320px;
		margin: 0.25rem 0 0.5rem;
	}
	.site select {
		width: 100%;
	}
	.flag {
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius, 6px);
		border-left: 4px solid var(--border-strong);
		background: var(--surface-2);
		margin: 0.5rem 0;
	}
	.flag.good {
		border-left-color: var(--success);
	}
	.flag.ok {
		border-left-color: var(--warning);
	}
	.flag.bad {
		border-left-color: var(--danger);
	}
	.caution {
		color: var(--warning);
	}
	.stats {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.bars {
		width: 100%;
		max-width: 560px;
		height: auto;
		display: block;
		margin: 0.75rem 0;
	}
	.bars rect.good {
		fill: var(--success);
	}
	.bars rect.ok {
		fill: var(--warning);
	}
	.bars rect.bad {
		fill: var(--danger);
	}
	.grid {
		stroke: var(--border);
	}
	.v,
	.m {
		font-size: 10px;
		text-anchor: middle;
		fill: var(--text-2);
	}
	.m {
		fill: var(--text-muted);
	}
	.axis {
		font-size: 10px;
		fill: var(--text-muted);
	}
	tr.short-row {
		background: var(--row-flag);
	}
	td.short {
		color: var(--warning);
		font-weight: 600;
	}
	details {
		margin-top: 0.75rem;
	}
	summary {
		cursor: pointer;
		min-height: 36px;
		display: flex;
		align-items: center;
	}
	.months {
		max-height: 28rem;
		overflow: auto;
	}
</style>
