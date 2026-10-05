<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	// Explorer for any stored output series of a run: pick a node (catchment
	// first, then the network order) and one of its series by name. Fetches
	// only the series picked.
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { cachedSeries } from './cache';
	import { seriesGroups, toDisplayUnit } from './results';

	let {
		projectId,
		runId,
		refs,
		nodeNames,
		nodeOrder = new Map(),
		flowUnit = 'm³/day',
		flowToolbar,
		band
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		nodeNames: Map<string, string>;
		nodeOrder?: ReadonlyMap<string, number>;
		flowUnit?: 'm³/s' | 'm³/day';
		/** Shown in the chart's toolbar while a flow series is picked (the results' m³/s ↔ m³/day switch). */
		flowToolbar?: Snippet;
		/** A forecast run's band (WP-2.12, forecast/forecast.ts forecastBand). */
		band?: { from: string; label: string; note: string };
	} = $props();

	const CATCHMENT = '__catchment';
	const groups = $derived(seriesGroups(refs, nodeOrder, nodeNames));
	let node = $state(CATCHMENT);
	let key = $state('');
	let log = $state(false);

	const group = $derived(groups.find((g) => (g.nodeId ?? CATCHMENT) === node) ?? groups[0]);
	const ref = $derived(group?.options.find((r) => r.key === key) ?? group?.options[0]);

	// Reset to the catchment's simulated outflow when the run changes.
	let lastRun = '';
	$effect(() => {
		if (runId === lastRun) return;
		lastRun = runId;
		const first = groups[0];
		node = first ? (first.nodeId ?? CATCHMENT) : CATCHMENT;
		key = first?.options.find((r) => r.key === 'simulated_outflow')?.key ?? first?.options[0]?.key ?? '';
	});

	function pickNode(n: string) {
		node = n;
		const g = groups.find((x) => (x.nodeId ?? CATCHMENT) === n);
		// Keep the same kind of series when the new node has it.
		if (!g?.options.some((r) => r.key === key)) key = g?.options[0]?.key ?? '';
	}

	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let data = $state.raw<ChartSeries[]>([]);
	let unit = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let requestNo = 0;

	$effect(() => {
		const r = ref;
		const fu = flowUnit;
		if (!r) {
			data = [];
			return;
		}
		const my = ++requestNo;
		// untrack: reading `data` here would make it a dependency of this effect,
		// and the fetch below writes `data` — an endless refetch loop that froze
		// the Runs tab (the cached promise resolves immediately every time).
		loading = untrack(() => !data.length);
		error = null;
		cachedSeries(runId, r.key, r.nodeId, () => api.runs.series(projectId, runId, r.key, r.nodeId))
			.then((d) => {
				if (my !== requestNo) return;
				const conv = toDisplayUnit(d.values, r.unit, fu);
				unit = conv.unit;
				data = [{ label: r.label, startDate: d.startDate, values: conv.values }];
			})
			.catch((e) => {
				if (my === requestNo) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (my === requestNo) loading = false;
			});
	});

	const where = $derived(node === CATCHMENT ? 'Catchment' : (nodeNames.get(node) ?? 'Node'));
	const title = $derived(`${where} · ${ref?.label ?? ''}`);
	const isFlow = $derived(ref?.unit === 'm³/day' && !/demand|supplied|deficit|ewr/.test(ref?.key ?? ''));
</script>

{#if refs.length === 0}
	<p class="muted">This run stored no output series.</p>
{:else}
	<div class="form-row pickers">
		<div class="field">
			<label for="rc-node">Hydrological unit</label>
			<select id="rc-node" value={node} onchange={(e) => pickNode(e.currentTarget.value)}>
				{#each groups as g (g.nodeId ?? CATCHMENT)}
					<option value={g.nodeId ?? CATCHMENT}>{g.label}</option>
				{/each}
			</select>
		</div>
		<div class="field">
			<label for="rc-key">Series</label>
			<select id="rc-key" value={ref?.key ?? ''} onchange={(e) => (key = e.currentTarget.value)}>
				{#each group?.options ?? [] as r (r.key)}<option value={r.key}>{r.label} ({r.unit})</option>{/each}
			</select>
		</div>
	</div>
	<LoadState {loading} {error}>
		<LineChart
			{title}
			{unit}
			series={data}
			logToggle={isFlow}
			bind:log
			recentDays={3 * 365}
			recentLabel="Last 3 years"
			toolbar={isFlow ? flowToolbar : undefined}
			{band}
		/>
	</LoadState>
{/if}

<style>
	.pickers .field {
		min-width: 220px;
		flex: 1;
		max-width: 360px;
	}
	.pickers select {
		width: 100%;
	}
	@media (max-width: 640px) {
		.pickers .field {
			min-width: 0;
			max-width: none;
			flex-basis: 100%;
		}
		.pickers select {
			min-height: 44px;
		}
	}
</style>
