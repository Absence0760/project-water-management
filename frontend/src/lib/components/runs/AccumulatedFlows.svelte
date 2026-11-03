<script lang="ts">
	// Accumulated flow at each unit (Runs & results, `#res-cumulative`; docs/ui.md § Runs & results): one daily line per
	// hydrological unit and the catchment outlet, each the flow accumulated down the network to it (accumulated.ts),
	// in the page's flow unit. "Flow shown" picks natural accumulated (the default), modelled arriving, modelled
	// leaving or the incremental runoff alone. Zoom is the chart's own; the numbers cover the days in view. Each
	// series comes through the Runs cache, four at a time.
	import { untrack, type Snippet } from 'svelte';
	import { api, type RunSeriesRef } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '#lib/components/charts/series.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { fmtDay, fmtPct, fmtReading } from '#lib/format/number.js';
	import { cachedSeries } from './cache';
	import { dayAt, eachAtOnce, FLOW_SHOWN, flowLines, lineStats, ownShare, partId, runNetwork, sumParts, unitsUpstream, viewDays, type FlowShown, type NetNode, type SeriesPart } from './accumulated';
	import { toDisplayUnit } from './results';

	let {
		projectId,
		runId,
		refs,
		runNodes,
		liveNodes,
		nodeNames,
		nodeOrder,
		flowUnit = 'm³/s',
		flowToolbar,
		band
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		/** The run's model snapshot's nodes: each unit's kind and where it drains, as the run had them. */
		runNodes: readonly NetNode[] | undefined;
		/** Today's model's nodes, for a run whose snapshot lacks them. */
		liveNodes: readonly NetNode[];
		nodeNames: ReadonlyMap<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		flowUnit?: 'm³/s' | 'm³/day';
		/** The page's m³/s ↔ m³/day switch (FlowUnitSwitch), in the chart's toolbar. */
		flowToolbar?: Snippet;
		/** A forecast run's forecast days, hatched (forecast/forecast.ts forecastBand); the flows run on through them. */
		band?: { from: string; label: string; note: string };
	} = $props();

	let shownFlow = $state<FlowShown>('natural');
	const choice = $derived(FLOW_SHOWN.find((c) => c.id === shownFlow)!);
	const units = $derived(unitsUpstream(refs, runNetwork(runNodes, liveNodes), nodeOrder, nodeNames));
	const lines = $derived(flowLines(shownFlow, units, refs));

	/** Each stored series loaded, by partId: replaced, never mutated ($state.raw, RunChart's note). */
	let loadedParts = $state.raw<Map<string, { startDate: string; values: (number | null)[] }>>(new Map());
	/** The run `loadedParts` belong to: another run's never shows beside this one's lines. */
	let partsRun = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(0);
	let toLoad = $state(0);
	let attempt = $state(0);
	let requestNo = 0;
	/** What to fetch, as a key: a new names map with the same lines doesn't fetch again. */
	const partsKey = $derived([...new Set(lines.flatMap((l) => l.parts.map(partId)))].join(','));

	$effect(() => {
		void partsKey;
		void attempt;
		const run = runId;
		const have = untrack(() => (partsRun === run ? loadedParts : new Map<string, { startDate: string; values: (number | null)[] }>()));
		const want = untrack(() => {
			const seen = new Map<string, SeriesPart>();
			for (const l of lines) for (const p of l.parts) seen.set(partId(p), p);
			return [...seen.values()].filter((p) => !have.has(partId(p)));
		});
		const my = ++requestNo;
		if (!want.length) {
			loading = false;
			if (untrack(() => partsRun) !== run) {
				loadedParts = have;
				partsRun = run;
			}
			return;
		}
		loading = true;
		error = null;
		loaded = 0;
		toLoad = want.length;
		eachAtOnce(
			want,
			(p) => cachedSeries(run, p.key, p.nodeId, () => api.runs.series(projectId, run, p.key, p.nodeId)).then((d) => [partId(p), { startDate: d.startDate, values: d.values }] as const),
			4,
			(n) => {
				if (my === requestNo) loaded = n;
			}
		)
			.then((got) => {
				if (my !== requestNo) return;
				loadedParts = new Map([...have, ...got]);
				partsRun = run;
			})
			.catch((e) => {
				if (my === requestNo) error = `Couldn't load the flows: ${e instanceof Error ? e.message : String(e)}`;
			})
			.finally(() => {
				if (my === requestNo) loading = false;
			});
	});

	/** Lines switched off in the pick-list, by id. */
	let hiddenIds = $state.raw<ReadonlySet<string>>(new Set());
	const toggle = (id: string, on: boolean) => {
		const next = new Set(hiddenIds);
		if (on) next.delete(id);
		else next.add(id);
		hiddenIds = next;
	};

	/** Each line's daily m³/day once all its series are in (none while loading another run's or a new choice's). */
	const summed = $derived.by(() => {
		if (partsRun !== runId) return [];
		const out = [];
		for (const l of lines) {
			const parts = l.parts.map((p) => loadedParts.get(partId(p)));
			if (parts.some((p) => !p)) continue;
			out.push({ line: l, startDate: parts[0]!.startDate, ...sumParts(parts.map((p) => p!.values)), own: l.own ? (loadedParts.get(partId(l.own))?.values ?? null) : null });
		}
		return out;
	});
	const shown = $derived(summed.filter((s) => !hiddenIds.has(s.line.id)));

	const series = $derived.by<ChartSeries[]>(() =>
		shown.map((s) => {
			const conv = toDisplayUnit(s.values, 'm³/day', flowUnit);
			return { label: s.line.label, startDate: s.startDate, values: conv.values, color: s.line.color, style: s.line.style };
		})
	);
	const unitShown = $derived(toDisplayUnit([], 'm³/day', flowUnit).unit);

	/** The chart's visible x range (epoch seconds), from its onview. */
	let view = $state.raw<{ min: number; max: number } | null>(null);
	const onview = (v: { min: number; max: number }) => {
		const cur = untrack(() => view);
		if (!cur || cur.min !== v.min || cur.max !== v.max) view = { min: v.min, max: v.max };
	};
	const first = $derived(shown[0]);
	const span = $derived(first ? viewDays(first.startDate, first.values.length, view) : null);
	const viewFrom = $derived(first && span ? dayAt(first.startDate, span.from) : null);
	const viewTo = $derived(first && span ? dayAt(first.startDate, span.to) : null);

	/** Mean, lowest and highest over the days in view, in the unit shown; and, for natural, the unit's own share. */
	const numbers = $derived(
		shown.map((s, i) => {
			const vals = series[i]!.values as (number | null)[];
			const { from, to } = viewDays(s.startDate, s.values.length, view);
			return { id: s.line.id, label: s.line.label, ...lineStats(vals, from, to), own: s.own ? ownShare(s.own, s.values, from, to) : null };
		})
	);
	const gapLines = $derived(summed.filter((s) => s.gapDays > 0).map((s) => `${s.line.label} (${s.gapDays} days)`));

	let chartReady = $state(false);
</script>

{#if units.length === 0}
	<p class="muted">This run stored no flows for its hydrological units.</p>
{:else}
	<div class="form-row controls">
		<div class="field">
			<label for="acc-flow">Flow shown</label>
			<select id="acc-flow" bind:value={shownFlow}>
				{#each FLOW_SHOWN as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
			</select>
		</div>
	</div>
	<fieldset class="pick">
		<legend>Lines shown <span class="muted">({lines.filter((l) => !hiddenIds.has(l.id)).length} of {lines.length})</span></legend>
		<div class="boxes">
			{#each lines as l (l.id)}
				<label class="check"><input type="checkbox" checked={!hiddenIds.has(l.id)} onchange={(e) => toggle(l.id, e.currentTarget.checked)} /><i aria-hidden="true" class:dash={l.style === 'dashed'} style:border-color="var({l.color})"></i>{l.label}</label>
			{/each}
		</div>
		{#if lines.length > 4}
			<div class="all">
				<button type="button" class="btn btn-sm" disabled={hiddenIds.size === 0} onclick={() => (hiddenIds = new Set())}>Show all</button>
				<button type="button" class="btn btn-sm" disabled={lines.every((l) => hiddenIds.has(l.id))} onclick={() => (hiddenIds = new Set([...hiddenIds, ...lines.map((l) => l.id)]))}>Show none</button>
			</div>
		{/if}
	</fieldset>
	<LoadState loading={loading && summed.length === 0} {error} retry={() => attempt++}>
		<div class="acc" data-testid="accumulated-flows" data-flow={shownFlow} data-lines={series.length} data-view-from={viewFrom ?? undefined} data-view-to={viewTo ?? undefined} data-ready={chartReady && !loading}>
			{#if loading}<p class="muted small" role="status">Loading the units’ flows… {loaded} of {toLoad}</p>{/if}
			{#if series.length === 0}
				<p class="muted">No lines picked: tick a unit above to draw it.</p>
			{:else}
				<LineChart
					title="Accumulated flow at each unit · {choice.label}"
					toolsLabel="Accumulated flow at each unit controls"
					unit={unitShown}
					{series}
					logToggle
					toolbar={flowToolbar}
					{onview}
					{band}
					bind:ready={chartReady}
				/>
				<p class="note small">
					{choice.note} Zoom in on a period by dragging across the chart, and move it with Shift+drag or Earlier / Later.
					A day missing from any series a line adds up is left out of that line, never counted as less flow{gapLines.length ? `: ${gapLines.join(', ')}` : ' (this run has none)'}.
					Gauges and other water users have no line of their own; the flow through them reaches the units below.
				</p>
				<details class="numbers">
					<summary>Show the numbers</summary>
					<div class="table-wrap">
						<table class="data">
							<caption>{choice.label}, {viewFrom && viewTo ? `${fmtDay(viewFrom)} to ${fmtDay(viewTo)}` : 'the run'} ({unitShown})</caption>
							<thead>
								<tr>
									<th scope="col">Line</th>
									<th scope="col" class="num">Mean</th>
									<th scope="col" class="num">Lowest</th>
									<th scope="col" class="num">Highest</th>
									{#if shownFlow === 'natural'}<th scope="col" class="num">The unit’s own runoff</th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each numbers as r (r.id)}
									<tr data-line={r.id}>
										<th scope="row">{r.label}</th>
										<td class="num" data-mean={r.mean ?? undefined}>{fmtReading(r.mean)}</td>
										<td class="num">{fmtReading(r.min)}</td>
										<td class="num">{fmtReading(r.max)}</td>
										{#if shownFlow === 'natural'}<td class="num">{r.own === null ? '–' : fmtPct(r.own)}</td>{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}
		</div>
	</LoadState>
{/if}

<style>
	.controls .field {
		min-width: 220px;
		max-width: 360px;
		flex: 1;
	}
	.controls select {
		width: 100%;
	}
	.pick {
		border: 0;
		margin: 0 0 0.5rem;
		padding: 0;
		min-width: 0;
	}
	.pick legend {
		font-weight: 600;
		font-size: var(--font-sm);
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.boxes {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		font-size: var(--font-sm);
	}
	.boxes label {
		align-items: center;
		min-height: 24px;
	}
	/* The line's swatch: its colour and style, so the box says which line it is. */
	.boxes i {
		display: inline-block;
		width: 1.2em;
		border-top: 3px solid;
	}
	.boxes i.dash {
		border-top-style: dashed;
	}
	.all {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}
	.note {
		margin: 0.4rem 0 0;
		color: var(--text-2);
	}
	.numbers {
		margin-top: 0.5rem;
	}
	.numbers table {
		width: auto;
	}
	.numbers caption {
		text-align: left;
		font-size: var(--font-sm);
		color: var(--text-2);
	}
	@media (max-width: 640px) {
		.controls .field {
			min-width: 0;
			max-width: none;
			flex-basis: 100%;
		}
		.controls select,
		.boxes label {
			min-height: 44px;
		}
		.all :global(.btn) {
			min-height: 44px;
		}
	}
</style>
