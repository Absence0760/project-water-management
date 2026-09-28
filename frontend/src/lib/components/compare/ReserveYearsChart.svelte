<script lang="ts" module>
	export interface ChartRun {
		/** "Baseline", "What-if 1", … */
		name: string;
		projectId: string;
		runId: string;
		/** CSS colour of its bars. */
		colour: string;
	}
</script>

<script lang="ts">
	// Days below the reserve, each water year (issue #17, board A4): grouped
	// bars per water year, one per run compared (baseline, what-if 1, what-if
	// 2). Counted from each run's `ewr_shortfall` series by the engine's
	// reserveDaysByWaterYear, the same test as the summary's EWR days not met.
	// Its own chunk (CompareView loads it lazily); series come through the
	// Runs tab's cache.
	import { reserveDaysByWaterYear, waterYearLabel, type ReserveYear } from '@water-management/engine';
	import { api, ApiError } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { cachedSeries } from '$lib/components/runs/cache';

	// The chart fills the height its box gives it (a flex column), at least `minHeight` px.
	let { runs, minHeight = 240 }: { runs: ChartRun[]; minHeight?: number } = $props();

	// $state.raw: plain arrays, no deep proxies.
	let years = $state.raw<(ReserveYear[] | null)[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let attempt = $state(0);

	const key = $derived(runs.map((r) => `${r.projectId}:${r.runId}`).join('|'));
	$effect(() => {
		const k = key;
		const list = runs;
		void attempt;
		loading = true;
		error = null;
		Promise.allSettled(
			list.map((r) => cachedSeries(r.runId, 'ewr_shortfall', null, () => api.runs.series(r.projectId, r.runId, 'ewr_shortfall', null)))
		).then((res) => {
			if (k !== key) return;
			const failed = res.find((x): x is PromiseRejectedResult => x.status === 'rejected' && !(x.reason instanceof ApiError && x.reason.status === 404));
			if (failed) error = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
			years = res.map((x) => (x.status === 'fulfilled' ? reserveDaysByWaterYear(x.value.startDate, x.value.values) : null));
			loading = false;
		});
	});

	// Every water year any run covers, ascending.
	const allYears = $derived([...new Set(years.flatMap((ys) => ys?.map((y) => y.waterYear) ?? []))].sort((a, b) => a - b));
	const at = (i: number, wy: number) => years[i]?.find((y) => y.waterYear === wy) ?? null;
	const maxBelow = $derived(Math.max(0, ...years.flatMap((ys) => ys?.map((y) => y.below) ?? [])));
	// A round top: 10, 20, 30, 60, 90, 120 … days.
	const top = $derived(maxBelow <= 10 ? 10 : maxBelow <= 30 ? Math.ceil(maxBelow / 10) * 10 : Math.ceil(maxBelow / 30) * 30);
	const ticks = $derived([0, top / 3, (2 * top) / 3, top].map((v) => Math.round(v)));
	const anyPart = $derived(years.some((ys) => ys?.some((y) => !y.complete)));
	const missingRuns = $derived(runs.filter((_, i) => years.length && years[i] === null).map((r) => r.name));

	let width = $state(0);
	let height = $state(0);
	// The top pad leaves room for the value axis's unit ("days") over its ticks.
	const pad = { l: 34, r: 8, t: 22, b: 24 };
	const plotW = $derived(Math.max(0, width - pad.l - pad.r));
	const plotH = $derived(height - pad.t - pad.b);
	const groupW = $derived(allYears.length ? plotW / allYears.length : 0);
	// Bars: at most 14 px each, a 2 px gap between a group's bars.
	const barW = $derived(Math.max(1, Math.min(14, (groupW * 0.8 - 2 * (runs.length - 1)) / runs.length)));
	const y = (v: number) => pad.t + plotH - (top ? (v / top) * plotH : 0);
	// About six labelled years along the axis.
	const labelEvery = $derived(Math.max(1, Math.ceil(allYears.length / 6)));

	const summary = $derived(
		runs
			.map((r, i) => {
				const ys = years[i];
				if (!ys) return `${r.name}: no series`;
				const total = ys.reduce((s, x) => s + x.below, 0);
				return `${r.name}: ${total} days below in ${ys.length} water year${ys.length === 1 ? '' : 's'}`;
			})
			.join('; ')
	);
</script>

<LoadState {loading} {error} retry={() => attempt++}>
	{#if allYears.length === 0}
		<p class="muted">These runs stored no reserve shortfall series to count.</p>
	{:else}
		<div class="chart">
		<ul class="legend" aria-label="Runs">
			{#each runs as r (r.name)}<li><span class="swatch" style:background={r.colour} aria-hidden="true"></span>{r.name}</li>{/each}
		</ul>
		<div class="plot" bind:clientWidth={width} bind:clientHeight={height} style:min-height="{minHeight}px">
			{#if width > 0 && height > 0}
				<svg {width} {height} role="img" aria-label="Days below the reserve per water year. {summary}.">
					<g class="grid">
						{#each ticks as t (t)}
							<line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} class:base={t === 0} />
							<text x={pad.l - 6} y={y(t) + 4} text-anchor="end">{t}</text>
						{/each}
						<text class="unit" x="2" y="11" data-testid="reserve-years-unit">days below</text>
					</g>
					{#if maxBelow === 0}
						<!-- Every bar is 0: say so on the plot, where empty bars would read as "no data". -->
						<text class="none" x={pad.l + plotW / 2} y={pad.t + plotH / 2} text-anchor="middle" data-testid="reserve-years-none">No day below the reserve in any year</text>
					{/if}
					{#each allYears as wy, gi (wy)}
						{@const gx = pad.l + gi * groupW + (groupW - (barW * runs.length + 2 * (runs.length - 1))) / 2}
						{#each runs as r, i (r.name)}
							{@const v = at(i, wy)}
							{#if v}
								<rect
									x={gx + i * (barW + 2)}
									y={y(v.below)}
									width={barW}
									height={Math.max(0, y(0) - y(v.below))}
									rx={Math.min(2, barW / 2)}
									fill={r.colour}
									opacity={v.complete ? 1 : 0.45}
								><title>{waterYearLabel(wy)} · {r.name}: {v.below} day{v.below === 1 ? '' : 's'} below{v.complete ? '' : ` (part year, ${v.days} days run)`}</title></rect>
							{/if}
						{/each}
						{#if gi % labelEvery === 0 || gi === allYears.length - 1}
							<text class="x" x={pad.l + gi * groupW + groupW / 2} y={height - 6} text-anchor="middle">{waterYearLabel(wy)}</text>
						{/if}
					{/each}
				</svg>
			{/if}
		</div>
		<p class="muted small note">
			Days in each water year (Oct–Sep) when the simulated outflow was below the pragmatic EWR at the outlet.{#if anyPart}{' '}Faded bars are part years: the run covers only some of that year.{/if}{#if missingRuns.length}{' '}{missingRuns.join(' and ')} stored no shortfall series.{/if}
		</p>
		<details class="as-table">
			<summary>Show as a table</summary>
			<div class="table-wrap">
				<table class="data compact">
					<caption class="visually-hidden">Days below the reserve per water year</caption>
					<thead>
						<tr>
							<th scope="col">Water year</th>
							{#each runs as r (r.name)}<th scope="col" class="num">{r.name}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each allYears as wy (wy)}
							<tr>
								<th scope="row">{waterYearLabel(wy)}{#if runs.some((_, i) => at(i, wy) && !at(i, wy)!.complete)}<span class="muted">{" · part year"}</span>{/if}</th>
								{#each runs as r, i (r.name)}
									{@const v = at(i, wy)}
									<td class="num">{v ? v.below : '–'}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
		</div>
	{/if}
</LoadState>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		list-style: none;
		margin: 0 0 0.4rem;
		padding: 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.swatch {
		width: 12px;
		height: 12px;
		border-radius: 2px;
	}
	.chart {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	/* The svg is out of flow, so its size never feeds back into the box it measures. */
	.plot {
		position: relative;
		flex: 1;
		width: 100%;
		min-width: 0;
	}
	svg {
		display: block;
		position: absolute;
		inset: 0;
	}
	.grid line {
		stroke: var(--chart-grid);
	}
	.grid line.base {
		stroke: var(--chart-axis);
	}
	text {
		font-size: 11px;
		fill: var(--text-muted);
	}
	text.none {
		font-size: 13px;
		fill: var(--text-2);
	}
	.note {
		margin: 0.4rem 0 0.2rem;
	}
	.as-table summary {
		cursor: pointer;
		font-size: 0.85rem;
		min-height: 24px;
	}
	.as-table .table-wrap {
		max-height: 18rem;
		overflow: auto;
	}
</style>
