<script lang="ts">
	// Summary → the latest run's outflow against the pragmatic EWR, the Runs
	// tab's "EWR vs simulated outflow" chart (flowSeries.ts), with a 30 days /
	// 1 year / All switch and the days below the reserve shaded (the run's
	// ewr_shortfall series, summaryChart.ts). Its own chunk (it pulls in uPlot),
	// loaded by OverviewTab only once the run's record is in. Series come
	// through the Runs tab's cache, so opening the run there next draws at once.
	// With `fill` the chart takes the height its panel is given (the Summary's
	// first screen fits the window, issue #17 A1) instead of a fixed one.
	// River & reserve shows the same chart, larger (river/RiverTab.svelte),
	// with the Runs tab's old controls turned on: the m³/s ↔ m³/day switch
	// (`units`) and Earlier / Later by the window picked (`pannable`). The
	// shaded days are dates from the shortfall series, so they hold in both units.
	import type { DailySeries } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { ewrChartSeries, type CatchmentFlows } from '$lib/components/runs/flowSeries';
	import { toDisplayUnit } from '$lib/components/runs/results';
	import { fmtNum } from '$lib/format/number';
	import { belowReserve, FLOW_OPEN_DAYS, FLOW_WINDOWS } from './summaryChart';

	let {
		projectId,
		runId,
		refs,
		forecastFrom = null,
		fill = false,
		more = null,
		units = false,
		pannable = false
	}: {
		projectId: string;
		runId: string;
		/** The run's stored series (its detail record), so only series it has are fetched. */
		refs: RunSeriesRef[];
		/** A forecast run's first forecast day: the chart shades from it. */
		forecastFrom?: string | null;
		/** Fill the panel's height (its parent sizes it). */
		fill?: boolean;
		/** A link beside the heading (the Summary's "More on River & reserve"). */
		more?: { href: string; label: string } | null;
		/** The m³/s ↔ m³/day switch (River & reserve; the Summary shows m³/s only). */
		units?: boolean;
		/** Earlier / Later through the record, by the window picked, and Shift+drag (River & reserve). */
		pannable?: boolean;
	} = $props();

	const SLOTS = [
		['simulated', 'simulated_outflow'],
		['ewr', 'ewr'],
		['shortfall', 'ewr_shortfall']
	] as const;
	/** The chart's height when it doesn't fill, and the least it gets when it does. */
	const FIXED_H = 240;
	const MIN_H = 180;

	// $state.raw: long daily arrays must not become deep proxies (RunCharts.svelte).
	let flows = $state.raw<CatchmentFlows & { shortfall?: DailySeries }>({});
	let loading = $state(true);
	let error = $state<string | null>(null);
	let log = $state(true);
	let attempt = $state(0);

	$effect(() => {
		const id = runId;
		void attempt;
		const present = SLOTS.filter(([, key]) => refs.some((r) => r.key === key && r.nodeId === null));
		loading = true;
		error = null;
		Promise.all(
			present.map(async ([slot, key]) => {
				const d = await cachedSeries(id, key, null, () => api.runs.series(projectId, id, key, null));
				return [slot, d] as const;
			})
		)
			.then((pairs) => {
				if (id === runId) flows = Object.fromEntries(pairs);
			})
			.catch((e) => {
				if (id === runId) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === runId) loading = false;
			});
	});

	let unit = $state<'m³/s' | 'm³/day'>('m³/s');
	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', unit).values;
	const series = $derived(ewrChartSeries(flows, conv));
	const band = $derived(forecastBand(forecastFrom));
	const shade = $derived(flows.shortfall ? belowReserve(flows.shortfall) : []);
	const shortDays = $derived(shade.reduce((n, r) => n + (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000 + 1, 0));
	const caption = $derived(
		flows.shortfall && shortDays === 0
			? 'The outflow never fell below the dashed EWR line: the EWR was met every day.'
			: flows.shortfall
			? `Shaded: the ${fmtNum(shortDays)} day${shortDays === 1 ? '' : 's'} the outflow was below the dashed EWR line (EWR not met).`
			: 'Days the outflow dips below the dashed EWR line count as EWR not met.'
	);

	// Filling: the plot gets what the slot leaves after the chart's own head,
	// legend and caption (measured from the drawn chart, so wrapping is counted).
	let slot: HTMLDivElement | undefined = $state();
	let fig: HTMLDivElement | undefined = $state();
	let fillH = $state(FIXED_H);
	$effect(() => {
		if (!fill || !slot || !fig) return;
		const s = slot;
		const f = fig;
		const measure = () => {
			const wrap = f.querySelector<HTMLElement>('.u-wrap');
			if (!wrap) return;
			const target = Math.max(MIN_H, Math.floor(s.clientHeight - (f.offsetHeight - wrap.offsetHeight)));
			if (Math.abs(target - fillH) > 2) fillH = target;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(s);
		ro.observe(f);
		return () => ro.disconnect();
	});
	const height = $derived(fill ? fillH : FIXED_H);
</script>

{#snippet unitToggle()}
	<span class="seg" role="group" aria-label="Flow units">
		<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/s'} onclick={() => (unit = 'm³/s')}>m³/s</button>
		<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/day'} onclick={() => (unit = 'm³/day')}>m³/day</button>
	</span>
{/snippet}

<section class="panel flow" class:fill aria-labelledby="flow-h" aria-busy={loading}>
	<div class="head">
		<h2 id="flow-h">Flow vs reserve</h2>
		{#if more}<a class="small" href={more.href}>{more.label}</a>{/if}
	</div>
	<LoadState {loading} {error} retry={() => attempt++}>
		{#if series.length === 0}
			<p class="muted">This run stored no outflow or EWR series.</p>
		{:else}
			<div class="slot" bind:this={slot}>
				<div bind:this={fig}>
					<LineChart
						title="EWR vs simulated outflow"
						{unit}
						{height}
						{series}
						{shade}
						logToggle
						bind:log
						recentDays={FLOW_OPEN_DAYS}
						windows={FLOW_WINDOWS}
						{pannable}
						toolbar={units ? unitToggle : undefined}
						{band}
						{caption}
					/>
				</div>
			</div>
		{/if}
	</LoadState>
</section>

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.25rem;
	}
	/* A 24 px target (WCAG 2.5.8). */
	.head a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.flow h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.flow.fill {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		margin: 0;
	}
	/* The slot is sized by the panel, not by the chart, so the chart can be fitted to it. */
	.fill .slot {
		flex: 1 1 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
