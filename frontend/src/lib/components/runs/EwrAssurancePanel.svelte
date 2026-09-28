<!--
	A run's Reserve compliance (RunSummary.ewrAssurance, engine ≥ 0.21.0;
	docs/model.md §2.9c): per EWR site with a rule table, the months met, the
	share met per month of the year (chart and table), the FDC check, and each
	month in a collapsed table. From engine 1.19.0 (CR-29) also the EWR as
	%nMAR, % of time and volume not met from daily data, and the monthly
	flow-duration curves of natural and present-day flow on the EWR curve.
-->
<script lang="ts">
	import { EWR_ASSURANCE_MIN_YEARS, type EwrAssuranceSite } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { describeMonths, monthName, WATER_YEAR_MONTHS } from '$lib/format/months';
	import { waterYearLabel } from '$lib/components/calibration/metrics';
	import {
		conditionText,
		describeMethod,
		fdcText,
		fewYears,
		fmtFlow,
		fmtMm3,
		highFlowVerdict,
		monthLabel,
		naturalMarLine,
		reserveCellText,
		reserveGrid,
		shareOfRequired,
		sourceLine,
		UNIT_LABEL,
		verdict
	} from './ewrAssurance';
	import EwrDailyCompliance from './EwrDailyCompliance.svelte';
	import EwrFdcOverlay from './EwrFdcOverlay.svelte';
	import { nmarTile } from './ewrReporting';

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
	const grid = $derived(reserveGrid(site));
	const split = $derived(!!site.lowFlow);
	const src = $derived(sourceLine(site));
	const mar = $derived(naturalMarLine(site));
	const nmar = $derived(nmarTile(site));

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
	<p class="muted small">{describeMethod(site)}</p>
	<p class="small" class:muted={!src.low} class:caution={src.low}>{src.text}</p>
	{#if mar}<p class="small" class:muted={!mar.caution} class:caution={mar.caution}>{mar.text}</p>{/if}

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
		{#if site.lowFlow}
			<div class="stat">
				<dt>Low flows met</dt>
				<dd>{site.lowFlow.rate === null ? '–' : fmtPct(site.lowFlow.rate)}</dd>
				<dd class="sub">
					{fmtNum(site.lowFlow.met)} of {fmtNum(site.lowFlow.months)} months at or above the maintenance-to-drought low flow; longest run short {fmtNum(site.lowFlow.longestNotMetRun)}
				</dd>
			</div>
		{/if}
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
		{#if nmar}
			<div class="stat">
				<dt>EWR as % of natural MAR</dt>
				<dd>{nmar.value}<small>%nMAR</small></dd>
				<dd class="sub">{nmar.sub}</dd>
			</div>
		{/if}
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
					{#if split}<th scope="col" class="num">Low flows met <span class="u">%</span></th>{/if}
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
						{#if split}
							<td class="num" class:short={m.lowFlowRate != null && m.lowFlowRate < 1}>{m.lowFlowRate == null ? '–' : fmtPct(m.lowFlowRate, 0)}</td>
						{/if}
						<td class="num">{fmtFlow(m.meanRequired)}</td>
						<td class="num">{fmtFlow(m.meanActual)}</td>
						<td class="num">{m.years ? fmtMm3(m.deficitM3) : '–'}</td>
						<td class="num">{fdcText(m.fdc)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<EwrDailyCompliance {site} />
	<EwrFdcOverlay {site} />

	{#if grid.waterYears.length}
		<div class="reserve-heat">
			<div class="table-wrap">
				<table class="data compact heat" aria-labelledby="{uid}-heat">
					<caption id="{uid}-heat">
						Each month at {site.isOutlet ? `the outlet (${site.name})` : site.name}: simulated flow as a share of the requirement
					</caption>
					<thead>
						<tr>
							<th scope="col">Water year</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each grid.waterYears as wy, r (wy)}
							<tr>
								<th scope="row">{waterYearLabel(wy)}</th>
								{#each grid.cells[r]! as c, k (k)}
									{#if c}
										<td class="num cell {c.state}" title={reserveCellText(c)}>
											<span aria-hidden="true">{c.state === 'met' ? '' : c.state === 'high' ? '◐' : '●'}{c.state === 'met' || c.share === null ? '' : fmtNum(c.share * 100, 0)}</span>
											<span class="sr-only">{reserveCellText(c)}</span>
										</td>
									{:else}
										<td class="num cell none"><span class="sr-only">not assessed</span></td>
									{/if}
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<ul class="key small" aria-label="Key">
				<li><span class="swatch met"></span> met</li>
				{#if split}<li><span class="swatch high"></span> ◐ low flows met, high flows short</li>{/if}
				<li><span class="swatch low"></span> ● {split ? 'low flows short' : 'not met'}</li>
				<li>Numbers: simulated flow as % of the month’s requirement.</li>
			</ul>
		</div>
	{/if}

	{#if site.highFlows?.length}
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-hf">
				<caption id="{uid}-hf">High flows: freshets and floods, by water year <HelpTip key="reserve-high-flows" /></caption>
				<thead>
					<tr>
						<th scope="col">Component</th>
						<th scope="col">Peaks in</th>
						<th scope="col" class="num">Peak <span class="u">m³/s</span></th>
						<th scope="col" class="num">Event days</th>
						<th scope="col" class="num">Per year</th>
						<th scope="col">Result</th>
					</tr>
				</thead>
				<tbody>
					{#each site.highFlows as h, k (k)}
						<tr class:short-row={h.overall.rate !== null && h.overall.rate < 1}>
							<th scope="row">{h.label}</th>
							<td>{describeMonths(h.months)}</td>
							<td class="num">{fmtFlow(h.peakAppliedM3s)}</td>
							<td class="num">{fmtNum(h.durationDays)}</td>
							<td class="num">{fmtNum(h.perYear)}</td>
							<td>{highFlowVerdict(h)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<details open={print}>
			<summary>High flows year by year</summary>
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-hfy">
					<caption id="{uid}-hfy">Events per water year: natural, simulated and required (no more than natural flow had)</caption>
					<thead>
						<tr>
							<th scope="col">Component</th>
							<th scope="col">Water year</th>
							<th scope="col" class="num">Natural</th>
							<th scope="col" class="num">Simulated</th>
							<th scope="col" class="num">Required</th>
							<th scope="col">Met</th>
						</tr>
					</thead>
					<tbody>
						{#each site.highFlows as h, k (k)}
							{#each h.years as y (y.waterYear)}
								<tr class:short-row={!y.met}>
									<th scope="row">{h.label}</th>
									<td>{waterYearLabel(y.waterYear)}</td>
									<td class="num">{fmtNum(y.natural)}</td>
									<td class="num">{fmtNum(y.actual)}</td>
									<td class="num">{fmtNum(y.required)}</td>
									<td>{y.required === 0 ? 'not required' : y.met ? 'met' : 'not met'}</td>
								</tr>
							{/each}
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	{/if}

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
						{#if split}
							<th scope="col" class="num">Low flow required <span class="u">{u}</span></th>
							<th scope="col">Low flows</th>
						{/if}
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
							{#if split}
								<td class="num">{fmtFlow(m.requiredLowFlow)}</td>
								<td>{m.lowFlowMet ? 'met' : 'not met'}</td>
							{/if}
							<td>{m.met ? 'met' : 'not met'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</section>

<style>
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
	/* The Reserve heat map: the EWR heat map's blue ramp (EwrHeatmap.svelte), met = the surface. */
	.reserve-heat {
		--rh-high: #86b6ef;
		--rh-high-ink: #161816;
		--rh-low: #0d366b;
		--rh-low-ink: #ffffff;
		margin: 0.75rem 0;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .reserve-heat {
			--rh-high: #256abf;
			--rh-high-ink: #ffffff;
			--rh-low: #86b6ef;
			--rh-low-ink: #121312;
		}
	}
	:global(:root[data-theme='dark']) .reserve-heat {
		--rh-high: #256abf;
		--rh-high-ink: #ffffff;
		--rh-low: #86b6ef;
		--rh-low-ink: #121312;
	}
	.heat td.cell {
		min-width: 2.6rem;
		text-align: center;
		border: 1px solid var(--border);
	}
	.heat td.high,
	.swatch.high {
		background: var(--rh-high);
		color: var(--rh-high-ink);
	}
	.heat td.low,
	.swatch.low {
		background: var(--rh-low);
		color: var(--rh-low-ink);
	}
	.heat td.none {
		background: var(--surface-2);
	}
	.swatch {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border: 1px solid var(--border-strong);
		vertical-align: middle;
		background: var(--surface);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		padding: 0;
		margin: 0.35rem 0 0;
		color: var(--text-muted);
	}
	.months {
		max-height: 28rem;
		overflow: auto;
	}
</style>
