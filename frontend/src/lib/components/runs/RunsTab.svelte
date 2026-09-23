<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { api, type Project, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import CalibrationPanel from '$lib/components/calibration/CalibrationPanel.svelte';
	import CurtailmentTable from '$lib/components/curtailment/CurtailmentTable.svelte';
	import EwrHeatmap from '$lib/components/ewr/EwrHeatmap.svelte';
	import AgreementTable from '$lib/components/series/AgreementTable.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { downloads, runDownloadItems } from '$lib/export';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { newDataSinceRun, seriesEnd } from '$lib/components/series/freshness';
	import { detailCache, forgetRun } from './cache';
	import RunCharts from './RunCharts.svelte';
	import RunSummaryView from './RunSummaryView.svelte';
	import { resultSections } from './sections';

	let {
		projectId,
		project,
		editor,
		series = null,
		runs: initialRuns = null,
		canRun,
		modelDirty,
		onRunsChange
	}: {
		projectId: string;
		project: Project;
		editor: ModelEditor;
		/** Input series list (the page's), to spot data newer than a run. */
		series?: SeriesMeta[] | null;
		/** Runs list the page already loaded, so the first frame has the final layout. */
		runs?: RunMeta[] | null;
		canRun: boolean;
		modelDirty: boolean;
		onRunsChange?: (runs: RunMeta[]) => void;
	} = $props();

	let runs = $state<RunMeta[]>(untrack(() => initialRuns ?? []));
	let loading = $state(untrack(() => initialRuns === null));
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let label = $state('');
	let running = $state(false);
	let elapsed = $state(0);
	let timer: ReturnType<typeof setInterval> | undefined;

	const selectedId = $derived(page.url.searchParams.get('run'));
	let detail = $state<{ run: Run; series: RunSeriesRef[] } | null>(
		untrack(() => {
			const id = page.url.searchParams.get('run') ?? initialRuns?.[0]?.id;
			return id ? (detailCache.get(id) ?? null) : null;
		})
	);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);

	// Display order and names come from the current model (nodes deleted since
	// the run fall back to the run's own names).
	const nodeOrder = $derived(new Map(editor.model.nodes.map((n, i) => [n.id, i] as [string, number])));
	const nodeNames = $derived.by(() => {
		const m = new Map(editor.model.nodes.map((n) => [n.id, n.name] as [string, string]));
		for (const f of detail?.run.summary.farms ?? []) if (!m.has(f.nodeId)) m.set(f.nodeId, f.name);
		return m;
	});
	const damCapacity = $derived(new Map(editor.model.nodes.map((n) => [n.id, n.damCapacityM3] as [string, number])));
	const runDays = (r: { startDate: string; endDate: string }) => toEpochDay(r.endDate) - toEpochDay(r.startDate) + 1;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		if (!runs.length) loading = true;
		loadError = null;
		try {
			runs = await api.runs.list(projectId);
			onRunsChange?.(runs);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);
	onDestroy(() => clearInterval(timer));

	function select(id: string | null) {
		const url = new URL(page.url);
		if (id) url.searchParams.set('run', id);
		else url.searchParams.delete('run');
		goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	let detailFor = untrack(() => detail?.run.id ?? '');
	async function loadDetail(id: string) {
		detailFor = id;
		const hit = detailCache.get(id);
		if (hit) {
			detail = hit;
			return;
		}
		detailLoading = true;
		detailError = null;
		try {
			const d = await api.runs.get(projectId, id);
			detailCache.set(id, d);
			if (detailFor === id) detail = d;
		} catch (e) {
			if (detailFor === id) {
				detail = null;
				detailError = msg(e);
			}
		} finally {
			if (detailFor === id) detailLoading = false;
		}
	}

	// Load details when the ?run= selection changes (only then — a failed load
	// must not re-trigger itself; the error state offers a retry). The previous
	// run stays on screen until the next one arrives.
	$effect(() => {
		const id = selectedId;
		untrack(() => {
			if (id && id !== detailFor) loadDetail(id);
		});
	});

	// Default to the newest run once the list is known.
	$effect(() => {
		if (!loading && !selectedId && runs.length) select(runs[0]!.id);
	});

	async function run(e: SubmitEvent) {
		e.preventDefault();
		running = true;
		actionError = null;
		elapsed = 0;
		const t0 = Date.now();
		timer = setInterval(() => (elapsed = Math.floor((Date.now() - t0) / 1000)), 250);
		try {
			const { run: r, removedRunIds } = await api.runs.create(projectId, label.trim() || undefined);
			label = '';
			const { summary: _summary, ...meta } = r;
			// Drop the oldest runs the server trimmed to stay within its cap.
			runs = [meta, ...runs.filter((x) => x.id !== r.id && !removedRunIds.includes(x.id))];
			onRunsChange?.(runs);
			select(r.id);
		} catch (err) {
			actionError = msg(err);
		} finally {
			clearInterval(timer);
			running = false;
		}
	}

	async function remove(r: RunMeta) {
		if (!confirm(`Delete run "${r.label || fmtDate(r.createdAt, true)}"?`)) return;
		actionError = null;
		try {
			await api.runs.remove(projectId, r.id);
			forgetRun(r.id);
			runs = runs.filter((x) => x.id !== r.id);
			onRunsChange?.(runs);
			if (selectedId === r.id) {
				detail = null;
				detailFor = '';
				select(runs[0]?.id ?? null);
			}
		} catch (err) {
			actionError = msg(err);
		}
	}

	// Inputs changed since the newest run? Settings/model saves bump the
	// project's updatedAt; new data shows as a driver series reaching past the
	// run's end (when no fixed simulation end is set).
	const latest = $derived(runs[0] ?? null);
	const stale = $derived.by(() => {
		if (!latest) return null;
		const reasons: string[] = [];
		if (project.updatedAt > latest.createdAt) reasons.push('the model or settings were saved');
		const newer = project.settings.simulationEnd ? [] : newDataSinceRun(series ?? [], latest);
		if (newer.length) reasons.push(`new data in ${newer.map((x) => x.name || x.kind.replace(/_/g, ' ')).join(', ')}, now to ${newer.map(seriesEnd).sort().pop()}`);
		return reasons.length ? reasons : null;
	});
	// What a run still needs (the engine refuses to run without these).
	const missing = $derived.by(() => {
		const out: string[] = [];
		if (!editor.model.nodes.length) out.push('a network');
		if (series && !series.some((x) => x.kind.startsWith('rain_') || x.kind === 'flow_pitman_m3s')) out.push('a rainfall (or Pitman flow) series');
		return out;
	});
	const viewingLatest = $derived(!!latest && detail?.run.id === latest.id);
	const farmNames = $derived(Object.fromEntries(editor.model.nodes.map((n) => [n.id, n.name])));
	const downloadItems = $derived(
		detail ? runDownloadItems(downloads, projectId, detail.run.id, editor.model.nodes.map((n) => ({ id: n.id, name: n.name }))) : []
	);
</script>

{#if canRun}
	<form class="panel run-bar" onsubmit={run} aria-busy={running}>
		<div class="field grow">
			<label for="run-label">Run label <span class="muted">(optional)</span></label>
			<input id="run-label" maxlength="200" placeholder="e.g. Baseline, 2026 dam raise" bind:value={label} disabled={running} />
		</div>
		<button type="submit" class="btn btn-primary" disabled={running || missing.length > 0}>
			{#if running}<span class="spin" aria-hidden="true"></span>{/if}
			{running ? 'Running model…' : 'Run model'}
		</button>
		<p class="note" role="status" aria-live="polite">
			{#if running}
				Simulating every day of the record for all nodes{elapsed >= 1 ? ` · ${elapsed} s` : ''}. Large catchments take a few seconds.
			{:else if missing.length}
				<span class="warn">
					A run needs {missing.join(' and ')}. Set up the <a href="?tab=network">network</a> and upload
					<a href="?tab=series">rainfall data</a> first.
				</span>
			{:else if modelDirty}
				<span class="warn">The model has unsaved changes — runs use the last saved version.</span>
			{:else if stale}
				<span class="warn">Inputs changed since the latest run ({stale.join('; ')}). Run again to update the results.</span>
			{:else}
				Runs use the saved network, crops, transfers, settings and time series.
			{/if}
		</p>
		{#if running}<div class="progress" aria-hidden="true"><span></span></div>{/if}
	</form>
{:else if stale}
	<p class="alert alert-info">Inputs changed since the latest run ({stale.join('; ')}); an editor can run the model again.</p>
{/if}

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}

<div class="layout">
	<section class="panel list" aria-labelledby="runs-h">
		<div class="panel-head">
			<h2 id="runs-h">Runs</h2>
			{#if runs.length >= 2}
				<a class="small" href="{base}/compare?project={encodeURIComponent(projectId)}">Compare runs</a>
			{:else if runs.length}
				<span class="muted small">{runs.length} stored</span>
			{/if}
		</div>
		{#if loading}
			<ul class="runs skeleton" aria-hidden="true">
				{#each [0, 1] as i (i)}<li><span class="sk sk-line"></span><span class="sk sk-short"></span></li>{/each}
			</ul>
			<p class="visually-hidden" role="status">Loading runs…</p>
		{:else if loadError}
			<div class="alert alert-error" role="alert">
				{loadError} <button type="button" class="btn btn-sm" onclick={load}>Try again</button>
			</div>
		{:else if runs.length === 0}
			<p class="empty">{canRun ? 'No runs yet. Run the model to see results.' : 'No runs yet.'}</p>
		{:else}
			<ul class="runs">
				{#each runs as r, i (r.id)}
					<li class:active={r.id === selectedId}>
						<button type="button" class="pick" aria-current={r.id === selectedId || undefined} onclick={() => select(r.id)}>
							<span class="lbl">{r.label || 'Untitled run'}{#if i === 0}<span class="latest">latest</span>{/if}</span>
							<span class="meta">{r.startDate} → {r.endDate}</span>
							<span class="meta">{fmtDate(r.createdAt, true)}{r.createdBy ? ` · ${r.createdBy}` : ''} · engine {r.engineVersion}</span>
						</button>
						{#if canRun}
							<button type="button" class="btn btn-icon" aria-label="Delete run {r.label || fmtDate(r.createdAt, true)}" title="Delete run" onclick={() => remove(r)}>✕</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<div class="detail">
		{#if detailError && !detail}
			<div class="alert alert-error" role="alert">
				{detailError}
				<button type="button" class="btn btn-sm" onclick={() => selectedId && loadDetail(selectedId)}>Try again</button>
			</div>
		{:else if detail}
			<section class="panel" aria-labelledby="res-h" aria-busy={detailLoading}>
				<div class="panel-head">
					<div>
						<h2 id="res-h">{detail.run.label || 'Untitled run'}</h2>
						<span class="muted small">
							{detail.run.startDate} → {detail.run.endDate} ({fmtNum(runDays(detail.run))} days) · run {fmtDate(detail.run.createdAt, true)}
							{#if !viewingLatest && latest}· <button type="button" class="linkish" onclick={() => select(latest.id)}>go to latest</button>{/if}
						</span>
					</div>
					<DownloadMenu items={downloadItems} />
				</div>
				<nav class="sections" aria-label="Result sections">
					<ul>
						{#each resultSections(detail.run.summary) as sec (sec.id)}
							<li><a href="#{sec.id}">{sec.label}</a></li>
						{/each}
					</ul>
				</nav>
				<section id="res-summary" aria-label="Run summary">
					<RunSummaryView summary={detail.run.summary} days={runDays(detail.run)} {nodeOrder} />
				</section>
			</section>
			<section class="panel" id="res-curtailment">
				<CurtailmentTable summary={detail.run.summary} {farmNames} />
			</section>
			{@const summary = detail.run.summary}
			<RunCharts
				{projectId}
				runId={detail.run.id}
				refs={detail.series}
				farms={summary.farms ?? []}
				{nodeNames}
				{nodeOrder}
				{damCapacity}
			>
				{#snippet afterHydrograph()}
					<div class="panel" id="res-calibration">
						<CalibrationPanel
							calibration={summary.calibration}
							requestedStart={project.settings.calibrationStart}
							requestedEnd={project.settings.calibrationEnd}
						/>
						{#if summary.dataQuality?.observedAgreement?.flaggedYears.length}
							<div class="agree"><AgreementTable agreement={summary.dataQuality.observedAgreement} headingLevel={3} /></div>
						{/if}
					</div>
				{/snippet}
				{#snippet afterFlowViews()}
					<div class="panel" id="res-ewr-grid">
						{#if summary.ewrCompliance}
							<EwrHeatmap compliance={summary.ewrCompliance} />
						{:else}
							<h3>EWR compliance by month</h3>
							<p class="muted">This run was made before the monthly EWR compliance grid existed. Run the model again to see it.</p>
						{/if}
					</div>
				{/snippet}
			</RunCharts>
		{:else if loading || detailLoading || (runs.length > 0 && selectedId)}
			<div class="panel skeleton-detail" aria-hidden="true">
				<span class="sk sk-title"></span>
				<div class="sk-cards">{#each [0, 1, 2, 3] as i (i)}<span class="sk sk-card"></span>{/each}</div>
				<span class="sk sk-table"></span>
			</div>
			<div class="panel" aria-hidden="true"><span class="sk sk-chart"></span></div>
			<p class="visually-hidden" role="status">Loading run results…</p>
		{:else}
			<div class="panel placeholder muted">
				Results appear here after a run: flows at the outflow gauge, calibration against observed flow, EWR compliance and each
				farm's supply and dam storage.
			</div>
		{/if}
	</div>
</div>

<style>
	.run-bar {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-wrap: wrap;
		overflow: hidden;
	}
	.run-bar .field {
		margin: 0;
	}
	.grow {
		flex: 1;
		max-width: 420px;
		min-width: min(100%, 220px);
	}
	.grow input {
		width: 100%;
	}
	.note {
		width: 100%;
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.warn {
		color: var(--warning);
		font-weight: 500;
	}
	.spin {
		width: 12px;
		height: 12px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.progress {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 3px;
		overflow: hidden;
		background: var(--accent-soft);
	}
	.progress span {
		position: absolute;
		inset: 0 auto 0 0;
		width: 30%;
		background: var(--accent);
		animation: slide 1.4s ease-in-out infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes slide {
		from {
			left: -30%;
		}
		to {
			left: 100%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin,
		.progress span {
			animation-duration: 3s;
		}
	}
	.layout {
		display: grid;
		grid-template-columns: 280px minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.detail {
		min-width: 0;
	}
	.runs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.runs li {
		display: flex;
		align-items: flex-start;
		border-bottom: 1px solid var(--border);
	}
	.runs li:last-child {
		border-bottom: 0;
	}
	.runs li.active {
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.pick {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		text-align: left;
		background: none;
		border: 0;
		padding: 0.55rem 0.6rem;
		font: inherit;
		color: inherit;
		cursor: pointer;
		min-width: 0;
	}
	.pick:hover {
		background: var(--row-hover);
	}
	.lbl {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.latest {
		font-size: 0.68rem;
		font-weight: 600;
		margin-left: 0.4rem;
		padding: 0 0.35rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
		vertical-align: 1px;
	}
	.meta {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.runs .btn-icon {
		margin: 0.45rem 0.3rem 0 0;
	}
	.small {
		font-size: 0.8rem;
	}
	.empty {
		color: var(--text-muted);
		text-align: center;
		padding: 1.5rem 0.5rem;
		margin: 0;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.placeholder {
		text-align: center;
		padding: 3rem 1rem;
	}
	/* In-page menu: the results run to about ten panels. */
	.sections ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin: 0 0 0.9rem;
		padding: 0;
	}
	.sections a {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.8rem;
		color: var(--text-2);
		text-decoration: none;
	}
	.sections a:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	@media (max-width: 640px) {
		.sections a {
			min-height: 36px;
		}
	}
	.agree {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.linkish {
		all: unset;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.linkish:focus-visible {
		outline: 2px solid var(--focus);
	}
	/* Skeletons at the final layout's size, so nothing jumps when data lands. */
	.sk {
		display: block;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}
	.skeleton li {
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.6rem;
	}
	.sk-line {
		height: 14px;
		width: 70%;
	}
	.sk-short {
		height: 10px;
		width: 90%;
	}
	.skeleton-detail {
		display: grid;
		gap: 0.9rem;
	}
	.sk-title {
		height: 20px;
		width: 40%;
	}
	.sk-cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: 0.75rem;
	}
	.sk-card {
		height: 78px;
	}
	.sk-table {
		height: 360px;
	}
	.sk-chart {
		height: 390px;
	}
</style>
