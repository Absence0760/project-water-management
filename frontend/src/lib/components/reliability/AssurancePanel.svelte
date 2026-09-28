<!--
	Assurance of supply (engine ≥ 0.32.0, WP-3.4, docs/model.md §2.11a): each
	farm's and other water user's reliability over the reporting window, then
	the stress classes per water-year month as a heat map in the EwrHeatmap
	grid pattern. The class name is in every cell, so colour is never the only
	cue. Input: RunSummary.supplyAssurance; absent on older runs.
-->
<script lang="ts">
	import { STRESS_LABEL, type SupplyAssurance } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import { waterYearLabel } from '$lib/components/calibration/metrics';
	import { fmtVolume } from '$lib/components/ewr/heatmap';
	import { classCounts, notComputedText, partWaterYears, pctText, STRESS_BIN, STRESS_ORDER, STRESS_SHORT, stressLegend } from './reliability';

	let {
		assurance,
		engineVersion = null
	}: {
		assurance: SupplyAssurance | undefined | null;
		/** The run's engine version, for the "not computed" note on older runs. */
		engineVersion?: string | null;
	} = $props();

	const uid = $props.id();
	let gridId = $state<string>('system');
	let focus = $state<{ r: number; m: number }>({ r: 0, m: 0 });

	const grids = $derived(assurance ? [assurance.stress.system, ...assurance.stress.nodes] : []);
	const grid = $derived(grids.find((g) => (g.nodeId ?? 'system') === gridId) ?? grids[0]);
	const legend = $derived(assurance ? stressLegend(assurance.stress) : []);
	const counts = $derived(grid ? classCounts(grid) : null);
	const partYears = $derived(assurance ? partWaterYears(assurance) : null);

	/** Calendar year of a water-year row + month column (Oct–Dec belong to the start year). */
	const calYear = (r: number, m: number) => (assurance?.stress.waterYears[r] ?? 0) + (m < 3 ? 0 : 1);

	function describe(r: number, m: number): string {
		const when = `${WATER_YEAR_MONTHS[m]} ${calYear(r, m)}`;
		if (!assurance || !grid) return when;
		if ((assurance.stress.days[r]?.[m] ?? 0) === 0) return `${when}: not simulated`;
		const c = grid.stressClass[r]?.[m];
		if (!c) return `${when}: no demand`;
		return `${when}: ${STRESS_LABEL[c]} stress, ${pctText(grid.ratio[r]?.[m], 1)} of demand supplied`;
	}

	function onKey(e: KeyboardEvent) {
		const rows = assurance?.stress.waterYears.length ?? 0;
		const move: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
		let { r, m } = focus;
		if (e.key in move) {
			const [dr, dm] = move[e.key]!;
			r = Math.min(rows - 1, Math.max(0, r + dr));
			m = Math.min(11, Math.max(0, m + dm));
		} else if (e.key === 'Home') m = 0;
		else if (e.key === 'End') m = 11;
		else return;
		e.preventDefault();
		focus = { r, m };
		document.getElementById(`${uid}-c-${r}-${m}`)?.focus();
	}
</script>

<section class="assurance" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Assurance of supply</h3>
	{#if !assurance}
		<p class="muted" data-testid="assurance-not-computed">{notComputedText(engineVersion)}</p>
	{:else}
		<p class="muted">
			Reporting window {assurance.reportStart} to {assurance.reportEnd} ({fmtNum(assurance.days)} days). A demand day counts as met when the whole
			demand was supplied; days without demand don't count. A water year is met when {pctText(assurance.annualThreshold)} or more of its demand
			was supplied (a project setting, not a standard).
		</p>
		{#if assurance.reliability.length === 0}
			<p class="muted">This network has no units or other water users.</p>
		{:else}
			<div class="table-wrap">
				<table class="data" data-testid="reliability-table">
					<caption class="visually-hidden">Reliability of supply per unit and other water user over the reporting window</caption>
					<thead>
						<tr>
							<th scope="col">Unit or user</th>
							<th scope="col" class="num">Days met<br /><span class="u">% of demand days</span></th>
							<th scope="col" class="num">Volume supplied<br /><span class="u">% of demand</span></th>
							<th scope="col" class="num">Water years met</th>
							<th scope="col" class="num">Failures</th>
							<th scope="col" class="num">Mean failure<br /><span class="u">days</span></th>
							<th scope="col" class="num">Longest failure<br /><span class="u">days</span></th>
							<th scope="col" class="num">Mean deficit<br /><span class="u">per failure</span></th>
							<th scope="col" class="num">Largest deficit<br /><span class="u">one failure</span></th>
						</tr>
					</thead>
					<tbody>
						{#each assurance.reliability as r (r.nodeId)}
							<tr>
								<th scope="row">{r.name}{#if r.kind === 'user'} <span class="muted">(user)</span>{/if}</th>
								<td class="num">{pctText(r.timeReliability, 1)}</td>
								<td class="num">{pctText(r.volumetricReliability, 1)}</td>
								<td class="num">{r.waterYears ? `${r.waterYearsMet} of ${r.waterYears} (${pctText(r.annualReliability)})` : '–'}</td>
								<td class="num">{fmtNum(r.failureRuns)}</td>
								<td class="num">{fmtNum(r.meanFailureDays, 1)}</td>
								<td class="num">{r.failureRuns ? fmtNum(r.longestFailureDays) : '–'}</td>
								<td class="num">{r.meanFailureDeficitM3 == null ? '–' : fmtVolume(r.meanFailureDeficitM3)}</td>
								<td class="num">{r.failureRuns ? fmtVolume(r.maxFailureDeficitM3) : '–'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="note muted">
				Resilience is shown as the mean length of a failure (consecutive demand days not fully met) and vulnerability as the deficit per failure,
				after Hashimoto et al. (1982). Volume supplied equals the curtailment table's supplied ÷ demand.
				{#if partYears !== null}
					Water years met counts complete water years only (1 October to 30 September inside the reporting window){partYears > 0
						? `; ${partYears === 1 ? 'the part year' : `the ${partYears} part years`} at the window's ends ${partYears === 1 ? 'is' : 'are'} left out`
						: ''}.
				{/if}
			</p>
		{/if}

		{#if grid && assurance.stress.waterYears.length}
			<div class="head">
				<h4 id="{uid}-sh">Stress classes by month</h4>
				<div class="field inline">
					<label for="{uid}-grid">Show</label>
					<select id="{uid}-grid" bind:value={gridId}>
						{#each grids as g (g.nodeId ?? 'system')}
							<option value={g.nodeId ?? 'system'}>{g.kind === 'system' ? 'All units and users' : g.name}</option>
						{/each}
					</select>
				</div>
			</div>
			{#if counts}
				<p class="summary">
					Over the whole run: {STRESS_ORDER.filter((c) => counts[c] > 0)
						.map((c) => `${fmtNum(counts[c])} ${STRESS_LABEL[c]}`)
						.join(', ') || 'no month with demand'}.
				</p>
			{/if}
			<ul class="legend" aria-label="Stress classes">
				{#each legend as k (k.cls)}
					<li><span class="swatch b{STRESS_BIN[k.cls]}" aria-hidden="true"></span><strong>{STRESS_SHORT[k.cls]}</strong>&nbsp;{k.label}: {k.range} supplied</li>
				{/each}
				<li><span class="swatch none" aria-hidden="true"></span>No demand or not simulated</li>
			</ul>
			<div class="table-wrap scroll">
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<table class="heat" role="grid" aria-labelledby="{uid}-sh" onkeydown={onKey} data-testid="stress-grid">
					<caption class="visually-hidden">Stress class per month for {grid.kind === 'system' ? 'all units and users' : grid.name}, water years October to September.</caption>
					<thead>
						<tr>
							<th scope="col">Water year</th>
							{#each WATER_YEAR_MONTHS as mo (mo)}<th scope="col">{mo}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each assurance.stress.waterYears as wy, r (wy)}
							<tr>
								<th scope="row">{waterYearLabel(wy)}</th>
								{#each WATER_YEAR_MONTHS as _mo, m (m)}
									{@const c = grid.stressClass[r]?.[m] ?? null}
									<td
										id="{uid}-c-{r}-{m}"
										class={c ? `b${STRESS_BIN[c]}` : 'none'}
										tabindex={focus.r === r && focus.m === m ? 0 : -1}
										onfocus={() => (focus = { r, m })}
										title={describe(r, m)}
									>
										<span aria-hidden="true">{c ? STRESS_SHORT[c] : ''}</span><span class="visually-hidden">{describe(r, m)}</span>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="note muted">
				The class is set by the month's supplied ÷ demand, with the node-based model's thresholds (pending the hydrologist's review). The whole run
				is shown, not only the reporting window. Use the arrow keys to move between months.
			</p>
		{/if}
	{/if}
</section>

<style>
	/* The EwrHeatmap's sequential ramp: light = Low stress, dark = Critical. */
	.assurance {
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
		:global(:root:not([data-theme='light'])) .assurance {
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
	:global(:root[data-theme='dark']) .assurance {
		--heat-1: #184f95;
		--heat-2: #256abf;
		--heat-3: #3987e5;
		--heat-4: #86b6ef;
		--heat-ink-1: #ffffff;
		--heat-ink-2: #ffffff;
		--heat-ink-3: #121312;
		--heat-ink-4: #121312;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin: 1rem 0 0.5rem;
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
		min-width: 2.6rem;
		height: 1.45rem;
		text-align: center;
		border-radius: 3px;
		padding: 0 0.2rem;
	}
	.heat td:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}
	.b0 {
		background: var(--heat-0);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.b1 {
		background: var(--heat-1);
		color: var(--heat-ink-1);
	}
	.b2 {
		background: var(--heat-2);
		color: var(--heat-ink-2);
	}
	.b3 {
		background: var(--heat-3);
		color: var(--heat-ink-3);
	}
	.b4 {
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
