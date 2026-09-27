<!--
	The reporting-window picker above the curtailment table (issue #44): last
	7 / 14 / 30 days, the project's window, the whole record or a custom range.
	Another window is worked out in the browser from the run's stored daily
	series by the engine (windowedCurtailment.ts), the EWR site setting each
	farm's charge included: no re-run, no change to the project setting, so a
	viewer can use it too. The choice is `?window=` in the URL
	(reportWindow.ts), a history entry of its own, so back and forward step
	through the windows looked at.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type Run, type RunSeriesRef } from '$lib/api';
	import CurtailmentTable from '$lib/components/curtailment/CurtailmentTable.svelte';
	import {
		describePeriod,
		forecastDaysIn,
		parseWindowParam,
		presetLabel,
		resolveWindow,
		sameWindow,
		windowParam,
		WINDOW_PARAM,
		WINDOW_PRESETS,
		type WindowChoice,
		type WindowPreset
	} from './reportWindow';
	import type { CropArea, CropDef, DemandObject, NetworkNode, Transfer } from '@water-management/engine';
	import { curtailmentSeriesKeys, missingSeries, prepareWindowed, type RunNetwork, type SeriesKey, type Stored } from './windowedCurtailment';

	let {
		projectId,
		run,
		refs,
		network,
		farmNames = {}
	}: {
		projectId: string;
		run: Run;
		/** The run's stored series (GET …/runs/:runId). */
		refs: RunSeriesRef[];
		/** Today's nodes and transfers, when the run carries no model snapshot (an older API). */
		network: RunNetwork;
		farmNames?: Record<string, string>;
	} = $props();

	const stored = $derived(run.summary.curtailment ?? null);
	const choice = $derived(parseWindowParam(page.url.searchParams.get(WINDOW_PARAM)));
	const resolution = $derived(stored ? resolveWindow(choice, run, stored) : null);
	const target = $derived(resolution?.ok ? resolution.window : null);
	/** The window differs from the one the run reported over: work it out from the series. */
	const recompute = $derived(!!stored && !!target && !sameWindow(target, stored));
	/** The network the run used: its model snapshot, else today's. */
	const runNetwork = $derived<RunNetwork>(
		run.model?.nodes
			? {
					nodes: run.model.nodes as NetworkNode[],
					transfers: (run.model.transfers as Transfer[] | undefined) ?? [],
					// Crops with their own irrigation efficiency (engine ≥ 0.43.0) set a farm's consumptive share.
					crops: (run.model.crops as CropDef[] | undefined) ?? [],
					cropAreas: (run.model.cropAreas as CropArea[] | undefined) ?? [],
					apanMm: (run.settings?.apanMm as number[] | undefined) ?? [],
					// Demand objects (engine ≥ 1.7.0) set their unit's consumptive share from its return flow.
					demandObjects: (run.model.demandObjects as DemandObject[] | undefined) ?? []
				}
			: network
	);
	// With the run's stored series, so a run that stores its binding sites (engine ≥ 1.5.0) isn't asked for the flows.
	const keys = $derived(stored ? curtailmentSeriesKeys(stored, runNetwork, refs) : null);
	/** Why this run can't be re-windowed (saved before the series it needs existed); null when it can. */
	const unavailable = $derived.by(() => {
		if (!stored || stored.farms.length === 0) return null;
		if (!keys || missingSeries(keys, refs).length) return 'This run was saved before its tables could be worked out for another window. Run the model again to pick one.';
		return null;
	});

	const idOf = (k: SeriesKey) => `${k.nodeId ?? ''}|${k.key}`;
	// $state.raw: long daily arrays must not become deep proxies (RunCharts.svelte). Replace, never mutate.
	let loaded = $state.raw<{ runId: string; series: ReadonlyMap<string, Stored> }>({ runId: '', series: new Map() });
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let attempt = $state(0);
	/** The run whose series are being fetched, so flipping windows mid-fetch doesn't start a second one. */
	let inflight = '';

	// Fetch the series once per run, the first time another window is picked (several per node and EWR site).
	$effect(() => {
		const runId = run.id;
		void attempt;
		if (!recompute || unavailable || !keys) return;
		const have = loaded.runId === runId ? loaded.series : new Map<string, Stored>();
		const todo = keys.filter((k) => !have.has(idOf(k)));
		if (!todo.length || inflight === runId) return;
		inflight = runId;
		loading = true;
		loadError = null;
		fetchAll(runId, todo)
			.then((got) => {
				if (run.id !== runId) return;
				loaded = { runId, series: new Map([...(loaded.runId === runId ? loaded.series : []), ...got]) };
			})
			.catch((e) => {
				if (run.id === runId) loadError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (inflight === runId) inflight = '';
				if (run.id === runId) loading = false;
			});
	});

	/** Six requests at a time. */
	async function fetchAll(runId: string, todo: SeriesKey[]): Promise<[string, Stored][]> {
		const out: [string, Stored][] = [];
		let next = 0;
		const worker = async () => {
			while (next < todo.length) {
				const k = todo[next++]!;
				const s = await api.runs.series(projectId, runId, k.key, k.nodeId);
				out.push([idOf(k), s.values]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
		return out;
	}

	/** The run read once (for a run saved before engine 1.5.0, the binding-site recompute is the costly part), then any window from it. */
	const prepared = $derived.by(() => {
		if (!recompute || !keys || unavailable || loaded.runId !== run.id) return null;
		const series = loaded.series;
		if (!keys.every((k) => series.has(idOf(k)))) return null;
		try {
			return { ok: true as const, run: prepareWindowed(run, runNetwork, (nodeId, key) => series.get(idOf({ nodeId, key }))) };
		} catch (e) {
			return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
		}
	});
	const windowed = $derived(prepared?.ok && target ? prepared.run.over(target) : null);
	const workError = $derived(prepared && !prepared.ok ? prepared.error : null);
	/** The table shown: the picked window once worked out, the run's own until then. */
	const shownPicked = $derived(!recompute || !!windowed);
	const period = $derived(shownPicked && resolution?.ok ? presetLabel(choice.preset) : presetLabel('project'));
	const forecastDays = $derived(target && shownPicked ? forecastDaysIn(target, run.summary.forecastRain) : 0);

	function pick(next: WindowChoice) {
		const url = new URL(page.url);
		const v = windowParam(next);
		if (v) url.searchParams.set(WINDOW_PARAM, v);
		else url.searchParams.delete(WINDOW_PARAM);
		if (url.search === page.url.search) return;
		goto(url, { noScroll: true, keepFocus: true });
	}
	function pickPreset(p: WindowPreset) {
		if (p !== 'custom') return pick({ preset: p });
		// A custom range starts from the days shown now.
		const w = target ?? stored;
		if (w) pick({ preset: 'custom', start: w.reportStart, end: w.reportEnd });
	}
	function pickDate(which: 'start' | 'end', value: string) {
		if (!value || choice.preset !== 'custom') return;
		pick({ ...choice, [which]: value });
	}
</script>

{#if stored && stored.farms.length > 0}
	<div class="window-bar" data-testid="report-window">
		<div class="field">
			<label for="rw-preset">Reporting window</label>
			<select id="rw-preset" value={choice.preset} disabled={!!unavailable} aria-describedby="rw-status" onchange={(e) => pickPreset(e.currentTarget.value as WindowPreset)}>
				{#each WINDOW_PRESETS as p (p.preset)}
					<option value={p.preset}>{p.label}{p.preset === 'project' ? ` (${stored.reportStart} to ${stored.reportEnd})` : ''}</option>
				{/each}
			</select>
		</div>
		{#if choice.preset === 'custom' && !unavailable}
			<div class="field">
				<label for="rw-start">From</label>
				<input id="rw-start" type="date" min={run.startDate} max={run.endDate} value={choice.start} onchange={(e) => pickDate('start', e.currentTarget.value)} />
			</div>
			<div class="field">
				<label for="rw-end">To</label>
				<input id="rw-end" type="date" min={run.startDate} max={run.endDate} value={choice.end} onchange={(e) => pickDate('end', e.currentTarget.value)} />
			</div>
		{/if}
	</div>
	<div class="window-note" id="rw-status" role="status" aria-live="polite">
		{#if unavailable}
			<p>{unavailable}</p>
		{:else if resolution && !resolution.ok}
			<p class="warn">{resolution.error} Showing the project window.</p>
		{:else if recompute && loading}
			<p>Working out {presetLabel(choice.preset).toLowerCase()} from this run's daily results…</p>
		{:else if recompute && !windowed}
			<!-- The error itself is in the alert below. -->
			<p>Showing the project window.</p>
		{:else if target}
			<p>
				<strong>{presetLabel(choice.preset)}</strong>: {describePeriod(target)}.
				{#if recompute}
					Worked out in your browser from this run's daily results: nothing is re-run, and the project setting is unchanged.
					Downloads and the printable report keep the project window.
				{:else if choice.preset === 'project'}
					The window this run reported over, from the project setting. Pick another to see a different period; nothing is re-run or saved.
				{:else}
					The same days as the project window.
				{/if}
				{#if resolution?.ok && resolution.note}{resolution.note}{/if}
				{#if forecastDays}{forecastDays} of these days fall in the forecast period, where the rain is forecast, not recorded.{/if}
				{#if windowed?.bindingApproximate}The transfer rules form a loop, so the EWR site setting each unit's charge is approximate.{/if}
			</p>
		{/if}
	</div>
	{#if loadError && recompute}
		<div class="alert alert-error" role="alert">
			Couldn't load the run's daily results: {loadError}
			<button type="button" class="btn btn-sm" onclick={() => attempt++}>Try again</button>
		</div>
	{:else if workError && recompute}
		<div class="alert alert-error" role="alert">Couldn't work out this window from the run's daily results: {workError}</div>
	{/if}
{/if}
<div aria-busy={recompute && loading}>
	<CurtailmentTable summary={run.summary} {farmNames} curtailment={windowed ? windowed.curtailment : undefined} {period} board />
</div>

<style>
	.window-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.window-bar .field {
		margin: 0;
		min-width: 0;
	}
	.window-bar select {
		max-width: 100%;
	}
	.window-note p {
		margin: 0.4rem 0 0.25rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		max-width: 80ch;
	}
	.window-note .warn {
		color: var(--warning);
		font-weight: 500;
	}
</style>
