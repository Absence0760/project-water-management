<script lang="ts">
	// Per-node daily series overlay (issue #8, docs/run-comparison.md § Daily
	// series): pick the catchment or a node matched across the two runs, and one
	// series both stored, then chart A against B and B − A underneath. Its own
	// chunk: Compare runs imports it, the Scenarios tab loads it lazily. Series lists come from
	// GET …/runs/:runId and values from GET …/runs/:runId/series, one pair at a
	// time; the node matching and the delta are the pure helpers in overlay.ts.
	// A feature series only one run stored (a river pump the scenario added)
	// is drawn against zeros for the other run, under overlay.ts zeroFillable.
	// A forecast run (WP-2.12) is drawn whole with its forecast days in the
	// band, but the difference and the read-out take its record only (issue
	// #51, overlay.ts recordOf), as every figure of the run does.
	import { untrack } from 'svelte';
	import type { DailySeries } from '@water-management/engine';
	import { api, type RunCompareResponse, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import { toDisplayUnit } from '$lib/components/runs/results';
	import { CATCHMENT_GROUP, deltaStats, isFlowSeries, matchOverlay, overlayForecastFrom, pickOption, recordOf, seriesDelta, summaryText, zeroSeries } from './overlay';

	let { data }: { data: RunCompareResponse } = $props();

	type Side = RunCompareResponse['a'];
	const refsOf = async (s: Side): Promise<RunSeriesRef[]> => {
		const d = detailCache.get(s.run.id) ?? (await api.runs.get(s.project.id, s.run.id));
		detailCache.set(s.run.id, d);
		return d.series;
	};

	// --- which series each run stored ---------------------------------------------
	let refs = $state.raw<{ a: RunSeriesRef[]; b: RunSeriesRef[] } | null>(null);
	let refsError = $state<string | null>(null);
	let refsNo = 0;
	async function loadRefs() {
		const my = ++refsNo;
		refs = null;
		refsError = null;
		loaded = null;
		try {
			const [a, b] = await Promise.all([refsOf(data.a), refsOf(data.b)]);
			if (my === refsNo) refs = { a, b };
		} catch (e) {
			if (my === refsNo) refsError = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		void data.a.run.id;
		void data.b.run.id;
		untrack(loadRefs);
	});

	const match = $derived(
		refs ? matchOverlay(refs.a, refs.b, data.a.run.inputs.model?.nodes ?? [], data.b.run.inputs.model?.nodes ?? []) : null
	);

	// --- the pick ------------------------------------------------------------------
	let groupId = $state(CATCHMENT_GROUP);
	let key = $state('simulated_outflow');
	$effect(() => {
		const m = match;
		if (!m) return;
		untrack(() => {
			// Keep the pick across a new pair of runs when it still exists.
			const g = m.groups.find((x) => x.id === groupId) ?? m.groups[0];
			groupId = g?.id ?? CATCHMENT_GROUP;
			key = pickOption(g, key);
		});
	});
	const group = $derived(match?.groups.find((g) => g.id === groupId));
	const option = $derived(group?.options.find((o) => o.key === key));
	function pickGroup(id: string) {
		groupId = id;
		key = pickOption(match?.groups.find((g) => g.id === id), key);
	}

	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');
	let log = $state(false);
	const flow = $derived(isFlowSeries(option));
	const unit = $derived(option ? toDisplayUnit([], option.unit, flow ? flowUnit : 'm³/day').unit : '');
	const scale = $derived(unit === 'm³/s' && option?.unit === 'm³/day' ? 1 / 86_400 : 1);

	// --- the values --------------------------------------------------------------
	// $state.raw: 16k-value daily arrays must not be deep-proxied (see RunChart).
	// `id` is the pick the values are for: an older pair is never drawn (or
	// read out) under a newer pick's title and unit while the new one loads.
	let loaded = $state.raw<{ id: string; a: DailySeries; b: DailySeries } | null>(null);
	const pickId = $derived(group && option ? `${group.id}|${option.key}` : '');
	const pair = $derived(loaded && loaded.id === pickId ? loaded : null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let requestNo = 0;
	async function loadPair() {
		const g = group;
		const k = option?.key;
		const my = ++requestNo;
		const id = pickId;
		if (!g || !k) {
			loaded = null;
			loading = false;
			return;
		}
		loading = true;
		error = null;
		const only = option?.onlyIn;
		// The run without this series had no such feature there: zeros over its own period, nothing to fetch.
		const get = (s: Side, nodeId: string | null, none: boolean) =>
			none
				? Promise.resolve(zeroSeries(s.run.startDate, s.run.endDate))
				: cachedSeries(s.run.id, k, nodeId, () => api.runs.series(s.project.id, s.run.id, k, nodeId));
		try {
			const [a, b] = await Promise.all([get(data.a, g.nodeIdA, only === 'B'), get(data.b, g.nodeIdB, only === 'A')]);
			if (my === requestNo) loaded = { id, a, b };
		} catch (e) {
			if (my === requestNo) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (my === requestNo) loading = false;
		}
	}
	$effect(() => {
		void group;
		void option;
		untrack(loadPair);
	});

	const sideName = (s: 'A' | 'B') => {
		const side = s === 'A' ? data.a : data.b;
		const same = data.a.project.id === data.b.project.id;
		const none = option?.onlyIn && option.onlyIn !== s ? ': none (0)' : '';
		return `${s} · ${side.run.label || 'Untitled run'}${same ? '' : ` (${side.project.name})`}${none}`;
	};
	/** The run that didn't store the picked series, when one didn't (it is drawn as 0). */
	const missingSide = $derived(option?.onlyIn === 'A' ? 'B' : option?.onlyIn === 'B' ? 'A' : null);
	const conv = (d: DailySeries) => (option ? toDisplayUnit(d.values, option.unit, flow ? flowUnit : 'm³/day').values : []);
	const overlaySeries = $derived.by<ChartSeries[]>(() => {
		const p = pair;
		if (!p) return [];
		return [
			{ label: sideName('A'), startDate: p.a.startDate, values: conv(p.a), color: '--series-1', width: 1.5 },
			{ label: sideName('B'), startDate: p.b.startDate, values: conv(p.b), color: '--series-2', width: 1.25 }
		];
	});
	const forecastA = $derived(data.a.run.summary.forecast?.from ?? null);
	const forecastB = $derived(data.b.run.summary.forecast?.from ?? null);
	const band = $derived(forecastBand(overlayForecastFrom(forecastA, forecastB)));
	const records = $derived(pair ? { a: recordOf(pair.a, forecastA), b: recordOf(pair.b, forecastB) } : null);
	const delta = $derived(records ? seriesDelta(records.a, records.b) : null);
	const deltaSeries = $derived.by<ChartSeries[]>(() =>
		delta && delta.values.length ? [{ label: 'B − A', startDate: delta.startDate, values: conv(delta), color: '--series-3', width: 1.25 }] : []
	);
	const stats = $derived(records ? deltaStats(records.a, records.b) : null);
	/** "Run A is a forecast run…": which sides were cut, and where. */
	const forecastNote = $derived(
		[forecastA ? ['A', forecastA] : null, forecastB ? ['B', forecastB] : null]
			.filter((x): x is [string, string] => x !== null)
			.map(([s, from]) => `Run ${s} is a forecast run: its days from ${from} ran on forecast rain, so the difference and the read-out stop the day before.`)
			.join(' ')
	);

	const where = $derived(group ? group.label : '');
	const RECENT = 3 * 365;
</script>

{#snippet unitToggle()}
	<span class="seg" role="group" aria-label="Flow units">
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/s'} onclick={() => (flowUnit = 'm³/s')}>m³/s</button>
		<button type="button" class="btn btn-sm" aria-pressed={flowUnit === 'm³/day'} onclick={() => (flowUnit = 'm³/day')}>m³/day</button>
	</span>
{/snippet}

<LoadState loading={!refs && !refsError} error={refsError} retry={loadRefs}>
	{#if match}
		{#if match.groups.length === 0}
			<p class="muted">The two runs have no daily series in common to overlay.</p>
		{:else}
			<div class="form-row pickers">
				<div class="field">
					<label for="ov-node">Hydrological unit</label>
					<select id="ov-node" value={groupId} onchange={(e) => pickGroup(e.currentTarget.value)}>
						{#each match.groups as g (g.id)}
							<option value={g.id}>{g.label}{g.wasName ? ` (was ${g.wasName})` : ''}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label for="ov-key">Series</label>
					<select id="ov-key" value={option?.key ?? ''} onchange={(e) => (key = e.currentTarget.value)}>
						{#each group?.options ?? [] as o (o.key)}<option value={o.key}>{o.label} ({o.unit}){o.onlyIn ? ` · run ${o.onlyIn} only` : ''}</option>{/each}
					</select>
				</div>
			</div>
			<LoadState loading={loading && !pair} {error} retry={loadPair}>
				<LineChart
					title="{where} · {option?.label ?? ''} · run A vs run B"
					{unit}
					series={overlaySeries}
					logToggle={flow}
					bind:log
					recentDays={RECENT}
					recentLabel="Last 3 years"
					toolbar={flow ? unitToggle : undefined}
					{band}
				/>
				{#if missingSide && pair}
					<p class="summary" data-testid="overlay-zero-note">
						Not in run {missingSide}: shown as 0. Run {missingSide} has no such feature at {where} (no river pump, borehole,
						release rule, land cover or priority user there), so its value is 0 on every day it modelled.
					</p>
				{/if}
				{#if stats}
					<p class="summary" data-testid="overlay-summary" aria-live="polite">{summaryText(stats, unit, scale)}</p>
				{/if}
				{#if forecastNote}
					<p class="summary" data-testid="overlay-forecast-note">{forecastNote}</p>
				{/if}
				{#if deltaSeries.length}
					<LineChart
						title="{where} · {option?.label ?? ''} · difference B − A"
						{unit}
						height={200}
						series={deltaSeries}
						recentDays={RECENT}
						recentLabel="Last 3 years"
						caption="Above zero, run B is higher that day. A day either run has no value for is a gap."
					/>
				{/if}
			</LoadState>
		{/if}
		{#if match.onlyA.length || match.onlyB.length || match.noCommon.length}
			<ul class="notes muted small" data-testid="overlay-unmatched">
				{#if match.onlyA.length}
					<li>Only in run A, so nothing to overlay: {match.onlyA.map((n) => n.name).join(', ')}.</li>
				{/if}
				{#if match.onlyB.length}
					<li>Only in run B, so nothing to overlay: {match.onlyB.map((n) => n.name).join(', ')}.</li>
				{/if}
				{#if match.noCommon.length}
					<li>In both runs but with no series stored in the same unit by both: {match.noCommon.map((n) => n.name).join(', ')}.</li>
				{/if}
			</ul>
		{/if}
	{/if}
</LoadState>

<style>
	.pickers .field {
		min-width: 220px;
		flex: 1;
		max-width: 360px;
	}
	.pickers select {
		width: 100%;
	}
	.summary {
		font-size: 0.85rem;
		margin: 0.25rem 0 0.75rem;
		max-width: 90ch;
	}
	.notes {
		margin: 0.75rem 0 0;
		padding-left: 1.2rem;
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
