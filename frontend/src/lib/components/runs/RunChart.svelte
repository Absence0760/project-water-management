<script lang="ts">
	import { untrack } from 'svelte';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { CATCHMENT, COMPARE, comparisonRefs, seriesForNode } from './chartPick';

	let {
		projectId,
		runId,
		refs,
		nodeNames
	}: { projectId: string; runId: string; refs: RunSeriesRef[]; nodeNames: Map<string, string> } = $props();

	const compare = $derived(comparisonRefs(refs));
	const nodeOptions = $derived.by(() => {
		const ids = [...new Set(refs.map((r) => r.nodeId).filter((x): x is string => !!x))];
		return ids
			.map((id) => ({ id, name: nodeNames.get(id) ?? 'Unknown node' }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	let node = $state(CATCHMENT);
	let key = $state('');

	const keyOptions = $derived(seriesForNode(refs, node));

	// Default selection whenever the run (or the chosen node) changes.
	$effect(() => {
		void runId;
		untrack(() => {
			const hasCatchment = seriesForNode(refs, CATCHMENT).length > 0;
			pickNode(hasCatchment ? CATCHMENT : (nodeOptions[0]?.id ?? CATCHMENT));
		});
	});

	function pickNode(n: string) {
		node = n;
		key = n === CATCHMENT && compare.length > 1 ? COMPARE : (seriesForNode(refs, n)[0]?.key ?? '');
	}

	const wanted = $derived<RunSeriesRef[]>(
		key === COMPARE ? compare : keyOptions.filter((r) => r.key === key)
	);

	let data = $state<ChartSeries[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let requestNo = 0;

	async function fetchSeries(list: RunSeriesRef[]) {
		const my = ++requestNo;
		loading = true;
		error = null;
		try {
			const results = await Promise.all(list.map((r) => api.runs.series(projectId, runId, r.key, r.nodeId)));
			if (my !== requestNo) return; // a newer selection won
			data = results.map((d, i) => ({ label: list[i]!.label, startDate: d.startDate, values: d.values }));
		} catch (e) {
			if (my === requestNo) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (my === requestNo) loading = false;
		}
	}

	$effect(() => {
		const list = wanted;
		untrack(() => {
			if (list.length) fetchSeries(list);
			else data = [];
		});
	});

	const title = $derived.by(() => {
		const where = node === CATCHMENT ? 'Catchment' : (nodeNames.get(node) ?? 'Node');
		return key === COMPARE ? `${where} · natural vs simulated vs observed flow` : `${where} · ${wanted[0]?.label ?? ''}`;
	});
</script>

{#if refs.length === 0}
	<p class="muted">This run stored no output series.</p>
{:else}
	<div class="form-row pickers">
		<div class="field">
			<label for="rc-node">Node</label>
			<select id="rc-node" value={node} onchange={(e) => pickNode(e.currentTarget.value)}>
				{#if seriesForNode(refs, CATCHMENT).length}<option value={CATCHMENT}>Catchment (outflow)</option>{/if}
				{#each nodeOptions as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="rc-key">Series</label>
			<select id="rc-key" bind:value={key}>
				{#if node === CATCHMENT && compare.length > 1}
					<option value={COMPARE}>Flow comparison ({compare.map((c) => c.label).join(' / ')})</option>
				{/if}
				{#each keyOptions as r (r.key)}<option value={r.key}>{r.label} ({r.unit})</option>{/each}
			</select>
		</div>
	</div>
	<LoadState {loading} error={error}>
		<LineChart {title} unit={wanted[0]?.unit ?? ''} series={data} />
	</LoadState>
{/if}

<style>
	.pickers .field {
		min-width: 220px;
	}
</style>
