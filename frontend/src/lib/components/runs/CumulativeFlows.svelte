<script lang="ts">
	// Cumulative flow at each unit (Runs & results, `#res-cumulative`; docs/ui.md § Runs & results): one line per
	// hydrological unit, and the catchment outlet, each the running total of its daily outflow in Mm³ (cumulative.ts).
	// Zoom is the chart's own (drag a box, Shift+drag, Earlier / Later); "Count from the first day in view" restarts
	// every line at 0 on the view's first day, so two periods can be compared. Each line's series comes through the
	// Runs cache, four at a time.
	import { untrack } from 'svelte';
	import { api, type RunSeriesRef } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '#lib/components/charts/series.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import { cachedSeries } from './cache';
	import { countWindow, cumulativeLines, dayAt, eachAtOnce, rebase, runningTotal, volumeBetween, type CumulativeLine } from './cumulative';

	let {
		projectId,
		runId,
		refs,
		runNodes,
		nodeKinds,
		nodeNames,
		nodeOrder,
		band
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		/** The run's model snapshot's nodes (each unit's kind as the run had it). */
		runNodes: readonly { id: string; kind?: unknown }[] | undefined;
		/** Today's model's kinds, for a run without the snapshot. */
		nodeKinds: ReadonlyMap<string, string>;
		nodeNames: ReadonlyMap<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		/** A forecast run's forecast days, hatched (forecast/forecast.ts forecastBand): the totals run on through them. */
		band?: { from: string; label: string; note: string };
	} = $props();

	const lines = $derived(cumulativeLines(refs, runNodes, nodeKinds, nodeOrder, nodeNames));

	/** Each line's running total, by line id, as loaded: replaced, never mutated ($state.raw, RunChart's note). */
	let totals = $state.raw<Map<string, { startDate: string; totals: number[]; gapDays: number }>>(new Map());
	/** The run `totals` belong to: another run's never shows beside this one's lines. */
	let totalsRun = $state<string | null>(null);
	/** What to fetch, as a key: a new names map with the same lines doesn't fetch again. */
	const lineKey = $derived(lines.map((l) => `${l.id}|${l.key}`).join(','));
	let loading = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(0);
	let attempt = $state(0);
	let requestNo = 0;

	$effect(() => {
		void lineKey;
		const want = untrack(() => lines);
		const run = runId;
		void attempt;
		const my = ++requestNo;
		loading = true;
		error = null;
		loaded = 0;
		eachAtOnce(
			want,
			(l: CumulativeLine) => cachedSeries(run, l.key, l.nodeId, () => api.runs.series(projectId, run, l.key, l.nodeId)).then((d) => ({ id: l.id, startDate: d.startDate, ...runningTotal(d.values) })),
			4,
			(n) => {
				if (my === requestNo) loaded = n;
			}
		)
			.then((all) => {
				if (my !== requestNo) return;
				totals = new Map(all.map((t) => [t.id, t]));
				totalsRun = run;
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
	const shown = $derived(totalsRun === runId ? lines.filter((l) => !hiddenIds.has(l.id) && totals.has(l.id)) : []);

	/** Count from the first day in view (on) or the run's first day (off, the default). */
	let fromView = $state(false);
	/** The chart's visible x range (epoch seconds), from its onview. */
	let view = $state.raw<{ min: number; max: number } | null>(null);
	const ref0 = $derived(shown[0] ? totals.get(shown[0].id) : undefined);
	// Primitive results: a pan within a day changes nothing below.
	const fromIndex = $derived(ref0 ? countWindow(ref0.startDate, ref0.totals.length, view, fromView).from : 0);
	const toIndex = $derived(ref0 ? countWindow(ref0.startDate, ref0.totals.length, view, fromView).to : 0);
	const countFrom = $derived(ref0 ? dayAt(ref0.startDate, fromIndex) : null);
	const countTo = $derived(ref0 ? dayAt(ref0.startDate, toIndex) : null);

	// Each line's first counted day, as one string: the lines are rebuilt only when one moves, not on every frame of
	// a pan (the chart takes new values in place, LineChart's inPlace).
	const froms = $derived(shown.map((l) => countWindow(totals.get(l.id)!.startDate, totals.get(l.id)!.totals.length, view, fromView).from).join(','));
	const series = $derived.by<ChartSeries[]>(() => {
		const from = froms.split(',').map(Number);
		return shown.map((l, i) => {
			const t = totals.get(l.id)!;
			return { label: l.label, startDate: t.startDate, values: rebase(t.totals, from[i] ?? 0), color: l.color, style: l.style };
		});
	});
	/** The volume each shown line counts to the last day in view (the table under the chart). */
	const atEnd = $derived(
		shown.map((l) => {
			const t = totals.get(l.id)!;
			const { from, to } = countWindow(t.startDate, t.totals.length, view, fromView);
			return { id: l.id, label: l.label, mm3: volumeBetween(t.totals, from, to) };
		})
	);
	const gapLines = $derived(shown.filter((l) => (totals.get(l.id)?.gapDays ?? 0) > 0).map((l) => `${l.label} (${totals.get(l.id)!.gapDays} days)`));

	let chartReady = $state(false);
	const onview = (v: { min: number; max: number }) => {
		const cur = untrack(() => view);
		if (!cur || cur.min !== v.min || cur.max !== v.max) view = { min: v.min, max: v.max };
	};
	const caption = $derived(
		`Cumulative volume ${fromView ? 'from the first day in view' : `since ${countFrom ? fmtDay(countFrom) : 'the run’s first day'}`}, Mm³: each line adds up its unit’s daily outflow (what leaves it downstream, the flow from upstream included).`
	);
</script>

<!-- The count-from switch, in the chart's own controls. -->
{#snippet countSwitch()}
	<button type="button" class="btn btn-sm" aria-pressed={fromView} onclick={() => (fromView = !fromView)}>Count from the first day in view</button>
{/snippet}

{#if lines.length === 0}
	<p class="muted">This run stored no outflow series for its hydrological units.</p>
{:else}
	<fieldset class="pick">
		<legend>Lines shown <span class="muted">({lines.length - lines.filter((l) => hiddenIds.has(l.id)).length} of {lines.length})</span></legend>
		<div class="boxes">
			{#each lines as l (l.id)}
				<label class="check"><input type="checkbox" checked={!hiddenIds.has(l.id)} onchange={(e) => toggle(l.id, e.currentTarget.checked)} /><i aria-hidden="true" class:dash={l.style === 'dashed'} style:border-color="var({l.color})"></i>{l.label}</label>
			{/each}
		</div>
		{#if lines.length > 4}
			<div class="all">
				<button type="button" class="btn btn-sm" disabled={hiddenIds.size === 0} onclick={() => (hiddenIds = new Set())}>Show all</button>
				<button type="button" class="btn btn-sm" disabled={hiddenIds.size === lines.length} onclick={() => (hiddenIds = new Set(lines.map((l) => l.id)))}>Show none</button>
			</div>
		{/if}
	</fieldset>
	<LoadState loading={loading && totalsRun !== runId} {error} retry={() => attempt++}>
		<div
			class="cum"
			data-testid="cumulative-flows"
			data-lines={series.length}
			data-count-from={countFrom ?? undefined}
			data-count-to={countTo ?? undefined}
			data-from-view={fromView}
			data-ready={chartReady && !loading && (fromView ? !!view : true)}
		>
			{#if loading}<p class="muted small" role="status">Loading the units’ flows… {loaded} of {lines.length}</p>{/if}
			{#if series.length === 0}
				<p class="muted">No lines picked: tick a unit above to draw it.</p>
			{:else}
				<LineChart
					title="Cumulative flow at each unit"
					toolsLabel="Cumulative flow at each unit controls"
					unit="Mm³"
					{series}
					toolbar={countSwitch}
					{caption}
					{onview}
					{band}
					inPlace
					bind:ready={chartReady}
				/>
				<p class="note small">
					Zoom in on a period by dragging across the chart, move it with Shift+drag or Earlier / Later, and switch on
					<strong>Count from the first day in view</strong> to see the volume over that period alone (a dry spell’s, a wet
					season’s). A day without a value adds nothing: the total carries over it{gapLines.length ? `, which it does for ${gapLines.join(', ')}` : ' (this run has none)'}.
					Gauges aren’t drawn (their flow is the sum of the units above them), nor are other water users.
				</p>
				<details class="numbers">
					<summary>Show the numbers</summary>
					<div class="table-wrap">
						<table class="data">
							<caption class="visually-hidden">Cumulative flow at each unit, Mm³</caption>
							<thead>
								<tr>
									<th scope="col">Unit</th>
									<th scope="col" class="num">{countFrom && countTo ? `${fmtDay(countFrom)} to ${fmtDay(countTo)} (Mm³)` : 'Mm³'}</th>
								</tr>
							</thead>
							<tbody>
								{#each atEnd as r (r.id)}
									<tr data-line={r.id}><th scope="row">{r.label}</th><td class="num">{fmtNum(r.mm3, 3)}</td></tr>
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
	@media (max-width: 640px) {
		.boxes label {
			min-height: 44px;
		}
		.all :global(.btn) {
			min-height: 44px;
		}
	}
</style>
