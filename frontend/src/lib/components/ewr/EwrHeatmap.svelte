<!--
	EWR compliance heat map: water-year rows × Oct…Sep columns, one cell per
	month, coloured by % of days the EWR was not met in the EWR traffic light's
	three bands (green, amber, red: the portfolio's, engine reserve/trafficLight.ts),
	or by shortfall volume on a blue ramp. The number is written in every month
	that missed a day, so the colour is never the only cue.
	It is a real <table>, so screen readers get the numbers directly; arrow
	keys move a single focus through the cells and a readout shows the detail.
	Input: RunSummary.ewrCompliance (engine 0.3.0+).
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { untrack } from 'svelte';
	import type { EwrCompliance } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import { waterYearLabel } from '$lib/components/calibration/metrics';
	import {
		bandPct,
		binVolume,
		cellPct,
		fmtCompact,
		fmtVolume,
		legend,
		maxShortfall,
		monthProfile,
		totals,
		worstYears,
		type HeatClass,
		type HeatMetric
	} from './heatmap';

	let {
		compliance,
		site: initialSite = 'outlet',
		print = false,
		headlineNote = ''
	}: {
		compliance: EwrCompliance | undefined | null;
		/** The site shown first: 'outlet' or a farm's node id. */
		site?: string;
		/** The printable report's static view: one site, named in the heading, no pickers or keyboard read-out. */
		print?: boolean;
		/** When the results are judged by a Reserve rule table: a clause for the outlet's note saying the bands aren't that test (ewr/headline.ts heatmapHeadlineNote). */
		headlineNote?: string;
	} = $props();

	const uid = $props.id();
	let site = $state(untrack(() => initialSite));
	let metric = $state<HeatMetric>('pct');
	let focus = $state<{ r: number; m: number }>({ r: 0, m: 0 });
	let hover = $state<{ r: number; m: number } | null>(null);

	const grids = $derived(compliance ? [compliance.outlet, ...compliance.farms] : []);
	const grid = $derived(
		site === 'outlet' ? compliance?.outlet : (compliance?.farms.find((f) => f.nodeId === site) ?? compliance?.outlet)
	);
	const max = $derived(grid ? maxShortfall(grid) : 0);
	const sum = $derived(compliance && grid ? totals(compliance, grid) : null);
	const profile = $derived(compliance && grid ? monthProfile(compliance, grid) : []);
	const worst = $derived(compliance && grid ? worstYears(compliance, grid) : []);
	const keyItems = $derived(legend(metric, max));
	const active = $derived(hover ?? focus);

	interface Cell {
		days: number;
		notMet: number;
		m3: number;
		pct: number | null;
		cls: HeatClass | null;
		text: string;
	}

	function cell(r: number, m: number): Cell {
		const days = compliance?.days[r]?.[m] ?? 0;
		const notMet = grid?.daysNotMet[r]?.[m] ?? 0;
		const m3 = grid?.shortfallM3[r]?.[m] ?? 0;
		const pct = cellPct(notMet, days);
		const cls: HeatClass | null = days === 0 ? null : metric === 'pct' ? bandPct(notMet, days) : `v${binVolume(m3, max)}`;
		// Blank only when the month met the EWR every day (no shortfall): a month that missed one says how much.
		const text = days === 0 || notMet === 0 ? '' : metric === 'pct' ? fmtNum(pct, 0) : fmtCompact(m3);
		return { days, notMet, m3, pct, cls, text };
	}

	/** Calendar year of a water-year row + month column (Oct–Dec belong to the start year). */
	const calYear = (r: number, m: number) => (compliance?.waterYears[r] ?? 0) + (m < 3 ? 0 : 1);

	function describe(r: number, m: number): string {
		const c = cell(r, m);
		const when = `${WATER_YEAR_MONTHS[m]} ${calYear(r, m)}`;
		if (c.days === 0) return `${when}: not simulated`;
		return `${when}: EWR not met on ${c.notMet} of ${c.days} days (${fmtNum(c.pct, 0)}%, ${bandPct(c.notMet, c.days)}), shortfall ${fmtVolume(c.m3)}`;
	}

	function onKey(e: KeyboardEvent) {
		const rows = compliance?.waterYears.length ?? 0;
		const move: Record<string, [number, number]> = {
			ArrowUp: [-1, 0],
			ArrowDown: [1, 0],
			ArrowLeft: [0, -1],
			ArrowRight: [0, 1]
		};
		let { r, m } = focus;
		if (e.key in move) {
			const [dr, dm] = move[e.key]!;
			r = Math.min(rows - 1, Math.max(0, r + dr));
			m = Math.min(11, Math.max(0, m + dm));
		} else if (e.key === 'Home') m = 0;
		else if (e.key === 'End') m = 11;
		else if (e.key === 'PageUp') r = Math.max(0, r - 5);
		else if (e.key === 'PageDown') r = Math.min(rows - 1, r + 5);
		else return;
		e.preventDefault();
		focus = { r, m };
		document.getElementById(`${uid}-c-${r}-${m}`)?.focus();
	}

	const yearPct = (r: number) => {
		const d = compliance?.days[r]?.reduce((a, b) => a + b, 0) ?? 0;
		const n = grid?.daysNotMet[r]?.reduce((a, b) => a + b, 0) ?? 0;
		return cellPct(n, d);
	};
	const yearM3 = (r: number) => grid?.shortfallM3[r]?.reduce((a, b) => a + b, 0) ?? 0;
</script>

<section class="ewr-heatmap" aria-labelledby="{uid}-h">
	<div class="head">
		<h3 id="{uid}-h">EWR compliance by month{print && grid ? `: ${site === 'outlet' ? `outlet (${grid.name})` : `${grid.name} (EWR charge)`}` : ''} <HelpTip key="ewr-days-not-met" /></h3>
		{#if compliance && grids.length && !print}
			<div class="controls">
				<div class="field inline">
					<label for="{uid}-site">Site</label>
					<select id="{uid}-site" bind:value={site}>
						<option value="outlet">Outlet ({compliance.outlet.name})</option>
						{#each compliance.farms as f (f.nodeId)}
							<option value={f.nodeId}>{f.name} (EWR charge)</option>
						{/each}
					</select>
				</div>
				<fieldset class="metric">
					<legend class="visually-hidden">Colour by</legend>
					<label><input type="radio" name="{uid}-metric" value="pct" bind:group={metric} /> % of days not met</label>
					<label><input type="radio" name="{uid}-metric" value="volume" bind:group={metric} /> Shortfall volume</label>
				</fieldset>
			</div>
		{/if}
	</div>

	{#if !compliance || !grid}
		<p class="muted">This run has no EWR compliance grid. Runs made before engine 0.3.0 don't have one; run the model again to see it.</p>
	{:else if compliance.waterYears.length === 0}
		<p class="muted">The run is empty.</p>
	{:else}
		{#if sum}
			<p class="summary">
				{#if sum.daysNotMet === 0}
					The EWR was met on every simulated day.
				{:else}
					EWR not met on <strong>{fmtNum(sum.daysNotMet)}</strong> of {fmtNum(sum.days)} days
					({fmtNum((100 * sum.daysNotMet) / sum.days, 1)}%), in {sum.monthsFailed} of {sum.months} months; total
					shortfall {fmtVolume(sum.shortfallM3)}.
					{#if worst.length}
						Worst water years: {worst.map((w) => `${waterYearLabel(w.waterYear)} (${w.daysNotMet} days)`).join(', ')}.
					{/if}
				{/if}
			</p>
		{/if}

		<ul class="legend" aria-label="Colour key">
			{#each keyItems as k (k.cls)}
				<li><span class="swatch {k.cls}" aria-hidden="true"></span>{k.label}</li>
			{/each}
			<li><span class="swatch none" aria-hidden="true"></span>Not simulated</li>
		</ul>

		{#if !print}<p class="readout" aria-hidden="true">{describe(active.r, active.m)}</p>{/if}

		<div class="table-wrap scroll">
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<table class="heat" role="grid" aria-labelledby="{uid}-h" aria-describedby="{uid}-note" onkeydown={onKey}>
				<caption class="visually-hidden">
					{metric === 'pct' ? 'Percentage of days the EWR was not met' : 'EWR shortfall volume'} per month at {grid.name}, water years October to September.
				</caption>
				<thead>
					<tr>
						<th scope="col">Water year</th>
						{#each WATER_YEAR_MONTHS as mo (mo)}<th scope="col">{mo}</th>{/each}
						<th scope="col" class="total">Year</th>
					</tr>
				</thead>
				<tbody>
					{#each compliance.waterYears as wy, r (wy)}
						<tr>
							<th scope="row">{waterYearLabel(wy)}</th>
							{#each WATER_YEAR_MONTHS as _mo, m (m)}
								{@const c = cell(r, m)}
								<td
									id="{uid}-c-{r}-{m}"
									class={c.cls ?? 'none'}
									tabindex={focus.r === r && focus.m === m ? 0 : -1}
									onfocus={() => (focus = { r, m })}
									onmouseenter={() => (hover = { r, m })}
									onmouseleave={() => (hover = null)}
									title={describe(r, m)}
								>
									<span aria-hidden="true">{c.text}</span><span class="visually-hidden">{describe(r, m)}</span>
								</td>
							{/each}
							<td class="total num">
								{metric === 'pct' ? (yearPct(r) == null ? '–' : `${fmtNum(yearPct(r), 0)}%`) : fmtCompact(yearM3(r))}
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row">All years</th>
						{#each profile as p, m (m)}
							<td class="num">{p == null ? '–' : `${fmtNum(p, 0)}%`}</td>
						{/each}
						<td class="num">{sum && sum.days ? `${fmtNum((100 * sum.daysNotMet) / sum.days, 0)}%` : '–'}</td>
					</tr>
				</tfoot>
			</table>
		</div>
		<p id="{uid}-note" class="note muted">
			{#if site === 'outlet'}
				A day counts when simulated outflow at the outlet is below the pragmatic EWR.{headlineNote ? ` ${headlineNote}` : ''}
			{:else}
				A day counts when this hydrological unit is charged part of the shortfall at an EWR site below it (runs before engine 0.17.0: when its reach shortfall was below zero).
			{/if}
			Cells show {metric === 'pct' ? '% of the month’s days' : 'shortfall volume (k = thousand m³, M = million m³)'}; blank = met every
			day.{metric === 'pct' ? ' The bands are the default EWR traffic light (provisional until the hydrologist confirms them), the portfolio’s for a team that hasn’t set its own.' : ''} The "All years" row is the share of days not met in that month across all years.{print ? '' : ' Use the arrow keys to move between months.'}
		</p>
	{/if}
</section>

<style>
	/* The volume metric: a sequential blue ramp (validated ordinal: light end ≥ 2:1 on the surface).
	   % of days not met uses the status tokens instead (.green/.amber/.red below), as the portfolio's pills. */
	.ewr-heatmap {
		--heat-0: var(--surface);
		--heat-1: #86b6ef;
		--heat-2: #3987e5;
		--heat-3: #1c5cab;
		--heat-4: #0d366b;
		--heat-ink-1: #161816;
		--heat-ink-2: #161816;
		--heat-ink-3: #ffffff;
		--heat-ink-4: #ffffff;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .ewr-heatmap {
			--heat-1: #184f95;
			--heat-2: #256abf;
			--heat-3: #3987e5;
			--heat-4: #86b6ef;
			--heat-ink-1: #ffffff;
			--heat-ink-2: #ffffff;
			--heat-ink-3: #121312;
			--heat-ink-4: #121312;
		}
	}
	:global(:root[data-theme='dark']) .ewr-heatmap {
		--heat-1: #184f95;
		--heat-2: #256abf;
		--heat-3: #3987e5;
		--heat-4: #86b6ef;
		--heat-ink-1: #ffffff;
		--heat-ink-2: #ffffff;
		--heat-ink-3: #121312;
		--heat-ink-4: #121312;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin-bottom: 0.5rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
	}
	.field.inline {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
	}
	.metric {
		border: 0;
		padding: 0;
		margin: 0;
		display: flex;
		gap: 0.75rem;
	}
	.metric label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.summary {
		color: var(--text-2);
	}
	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 0.9rem;
		padding: 0;
		margin: 0 0 0.4rem;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.swatch {
		width: 0.9rem;
		height: 0.9rem;
		border-radius: 2px;
		border: 1px solid var(--border);
	}
	.readout {
		min-height: 1.3em;
		font-size: 0.82rem;
		color: var(--text-2);
		margin: 0 0 0.35rem;
		font-variant-numeric: tabular-nums;
	}
	.scroll {
		overflow-x: auto;
		max-height: 70vh;
	}
	table.heat {
		border-collapse: separate;
		border-spacing: 2px;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	.heat th {
		font-weight: 600;
		color: var(--text-muted);
		padding: 0.15rem 0.35rem;
		white-space: nowrap;
		text-align: center;
	}
	.heat thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}
	.heat tbody th {
		text-align: right;
		color: var(--text-2);
	}
	.heat td {
		min-width: 2.4rem;
		height: 1.45rem;
		text-align: center;
		border-radius: 3px;
		padding: 0 0.2rem;
	}
	.heat td:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.heat td.total,
	.heat tfoot td {
		color: var(--text-2);
		text-align: right;
		padding-left: 0.5rem;
	}
	.heat tfoot th,
	.heat tfoot td {
		border-top: 1px solid var(--border);
	}
	/* The traffic light: the status tokens' soft fill, a stronger edge and the token as ink (the
	   portfolio's StatusPill), so each band holds ≥ 4.5:1 for its number in both themes. */
	.green {
		background: var(--success-soft);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--success) 45%, transparent);
		color: var(--success);
		font-weight: 600;
	}
	.amber {
		background: var(--warning-soft);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 55%, transparent);
		color: var(--warning);
		font-weight: 600;
	}
	/* A 2 px edge: the worst band reads apart from amber without telling red from green. */
	.red {
		background: var(--danger-soft);
		box-shadow: inset 0 0 0 2px var(--danger);
		color: var(--danger);
		font-weight: 600;
	}
	.v0 {
		background: var(--heat-0);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.v1 {
		background: var(--heat-1);
		color: var(--heat-ink-1);
	}
	.v2 {
		background: var(--heat-2);
		color: var(--heat-ink-2);
	}
	.v3 {
		background: var(--heat-3);
		color: var(--heat-ink-3);
	}
	.v4 {
		background: var(--heat-4);
		color: var(--heat-ink-4);
	}
	.none {
		background: repeating-linear-gradient(45deg, transparent 0 3px, var(--border) 3px 4px);
	}
	.note {
		font-size: 0.8rem;
		margin-top: 0.4rem;
	}
	@media (forced-colors: active) {
		.heat td {
			forced-color-adjust: none;
		}
	}
</style>
