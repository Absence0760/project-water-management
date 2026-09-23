<script lang="ts">
	// One catchment series from both runs on one chart. Values are fetched
	// lazily per side from GET /projects/:id/runs/:runId/series.
	import { untrack } from 'svelte';
	import { api, type RunCompareResponse } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import LoadState from '$lib/components/common/LoadState.svelte';

	let { data }: { data: RunCompareResponse } = $props();

	const PREFERRED = ['simulated_outflow', 'natural_flow', 'ewr_shortfall'];
	const options = $derived(data.catchmentSeries);
	let key = $state('');

	// Pick a sensible default whenever the pair of runs changes.
	$effect(() => {
		void data.a.run.id;
		void data.b.run.id;
		untrack(() => {
			if (!options.some((o) => o.key === key)) {
				key = PREFERRED.find((k) => options.some((o) => o.key === k)) ?? options[0]?.key ?? '';
			}
		});
	});

	const chosen = $derived(options.find((o) => o.key === key));
	const runName = (side: 'A' | 'B') => {
		const s = side === 'A' ? data.a : data.b;
		const same = data.a.project.id === data.b.project.id;
		return `${side} · ${s.run.label || 'Untitled run'}${same ? '' : ` (${s.project.name})`}`;
	};

	let series = $state<ChartSeries[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let requestNo = 0;

	async function load(k: string) {
		const my = ++requestNo;
		loading = true;
		error = null;
		try {
			const [a, b] = await Promise.all([
				api.runs.series(data.a.project.id, data.a.run.id, k, null),
				api.runs.series(data.b.project.id, data.b.run.id, k, null)
			]);
			if (my !== requestNo) return; // a newer choice won
			series = [
				{ label: runName('A'), startDate: a.startDate, values: a.values },
				{ label: runName('B'), startDate: b.startDate, values: b.values }
			];
		} catch (e) {
			if (my === requestNo) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (my === requestNo) loading = false;
		}
	}

	$effect(() => {
		const k = key;
		void data.a.run.id;
		void data.b.run.id;
		untrack(() => {
			if (k) load(k);
			else series = [];
		});
	});
</script>

{#if options.length === 0}
	<p class="muted">The two runs have no catchment series in common to overlay.</p>
{:else}
	<div class="field pick">
		<label for="cmp-series">Catchment series</label>
		<select id="cmp-series" bind:value={key}>
			{#each options as o (o.key)}<option value={o.key}>{o.label} ({o.unit})</option>{/each}
		</select>
	</div>
	<LoadState {loading} {error} retry={() => key && load(key)}>
		<LineChart title="{chosen?.label ?? ''} · run A vs run B" unit={chosen?.unit ?? ''} {series} />
	</LoadState>
{/if}

<style>
	.pick {
		max-width: 360px;
	}
</style>
