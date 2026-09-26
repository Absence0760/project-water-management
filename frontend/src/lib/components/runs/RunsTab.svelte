<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { api, PINNED_RUNS_MAX, type Nomination, type Project, type Publication, type PublicationMeta, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import CalibrationPanel from '$lib/components/calibration/CalibrationPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import CurtailmentTable from '$lib/components/curtailment/CurtailmentTable.svelte';
	import EwrAgreementTable from '$lib/components/ewr/EwrAgreementTable.svelte';
import EwrHeatmap from '$lib/components/ewr/EwrHeatmap.svelte';
	import AgreementTable from '$lib/components/series/AgreementTable.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { downloads, runDownloadItems, type FarmTableItem } from '$lib/export';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { newDataSinceRun, seriesEnd } from '$lib/components/series/freshness';
	import { detailCache, forgetRun } from './cache';
	import RunCharts from './RunCharts.svelte';
	import RunSummaryView from './RunSummaryView.svelte';
	import SelfChecksPanel from './SelfChecksPanel.svelte';
	import RunoffPanel from './RunoffPanel.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import RunNotes from './RunNotes.svelte';
	import { currentNomination, evidenceLine, modelDriftWarning } from './evidence';
	import { activeSectionId, resultGroups } from './sections';
	import { filterRuns, RUN_FILTER_FROM, runYears } from './runList';
	import { publishedRunIds } from './publication';
	// Reserve compliance (engine ≥ 0.21.0) is its own chunk: only runs with a rule table load it.
	const loadAssurancePanel = () => import('./EwrAssurancePanel.svelte');
	// The WR2012 report (only for a run that has one) and the evidence panel are their own chunks
	// too, so the Runs chunk stays within its 41 KB budget as panels are added.
	const loadWr2012Panel = () => import('./Wr2012Panel.svelte');
	const loadEvidencePanel = () => import('./EvidencePanel.svelte');
	// Publishing a run and the WP-2.3 notice editor: their own chunk, like the evidence panel.
	const loadPublicationPanel = () => import('./PublicationPanel.svelte');
	// The plausibility checks (engine ≥ 0.25.0) are their own chunk too: tables and a chart most visits never scroll to.
	const loadPlausibilityPanel = () => import('./PlausibilityPanel.svelte');
	// Uncertainty bands (engine ≥ 0.26.0, issue #4 phase 9): their own chunk, fetched when a run is shown.
	const loadUncertaintyPanel = () => import('$lib/components/uncertainty/UncertaintyPanel.svelte');
	// The preview of an all-farms download (Download menu → Preview): its own chunk, fetched on first use.
	const loadTableDialog = () => import('$lib/components/export/DailyTableDialog.svelte');

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
	/** The project's evidence history, oldest first (010_run_nomination). */
	let nominations = $state<Nomination[]>([]);
	/** The project's publications (022_publication): the current one and the history, newest first. */
	let publication = $state<{ current: Publication | null; history: PublicationMeta[] } | null>(null);
	let publicationError = $state<string | null>(null);
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
	// Farms and gauges for the day trace, in network order: only nodes the shown run has series for
	// (a node added since the run has none; a deleted one lost its series with it).
	const traceNodes = $derived.by(() => {
		const inRun = new Set((detail?.series ?? []).map((s) => s.nodeId));
		return editor.model.nodes.filter((n) => inRun.has(n.id)).map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
	});
	const damCapacity = $derived(new Map(editor.model.nodes.map((n) => [n.id, n.damCapacityM3] as [string, number])));
	const runDays = (r: { startDate: string; endDate: string }) => toEpochDay(r.endDate) - toEpochDay(r.startDate) + 1;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		if (!runs.length) loading = true;
		loadError = null;
		try {
			const [list, history] = await Promise.all([api.runs.list(projectId), api.runs.nominations(projectId)]);
			runs = list;
			nominations = history;
			onRunsChange?.(runs);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	/** Loaded on its own, so a failure shows in the publication panel without hiding the runs. */
	async function loadPublication() {
		publicationError = null;
		try {
			publication = await api.publication.get(projectId);
		} catch (e) {
			publicationError = msg(e);
		}
	}
	onMount(() => {
		load();
		loadPublication();
	});
	const currentPublishedRunId = $derived(publication?.current?.runId ?? null);
	// Every run the history holds: the server keeps them, so they get no delete button.
	const heldByPublication = $derived(publishedRunIds(publication?.history));
	function published(p: { current: Publication; history: PublicationMeta[] }) {
		publication = p;
		runs = runs.map((r) => ({ ...r, published: r.id === p.current.runId }));
		onRunsChange?.(runs);
	}
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

	/** A run's notes were saved: the shown run, its cached detail and its row in the list take the new note and stamp. */
	function notesSaved(updated: RunMeta) {
		const fields = { notes: updated.notes, notesUpdatedAt: updated.notesUpdatedAt, notesUpdatedBy: updated.notesUpdatedBy };
		if (detail?.run.id === updated.id) detail = { ...detail, run: { ...detail.run, ...fields } };
		const cached = detailCache.get(updated.id);
		if (cached) detailCache.set(updated.id, { ...cached, run: { ...cached.run, ...fields } });
		runs = runs.map((r) => (r.id === updated.id ? { ...r, ...fields } : r));
		onRunsChange?.(runs);
	}

	// Each run's place in the evidence history, from the history itself so a
	// nomination shows at once: 'current', 'past' or absent.
	const evidenceById = $derived.by(() => {
		const m = new Map<string, 'current' | 'past'>();
		for (const n of nominations) m.set(n.runId, 'past');
		const cur = currentNomination(nominations);
		if (cur) m.set(cur.runId, 'current');
		return m;
	});
	const drift = $derived(modelDriftWarning(runs, nominations));
	const evidenceFmt = (iso: string) => fmtDate(iso, true);
	/** The run header's evidence line for the shown run, or null when it was never nominated. */
	const shownEvidence = $derived(detail ? evidenceLine(detail.run.id, nominations, evidenceFmt) : null);

	/** A run was nominated: the history and every run's status follow. */
	function nominated(history: Nomination[]) {
		nominations = history;
		const status = (id: string) => evidenceById.get(id) ?? null;
		runs = runs.map((r) => ({ ...r, evidence: status(r.id) }));
		onRunsChange?.(runs);
	}

	/** Pin or unpin a run (015_run_pinned): the storage cap keeps a pinned run. */
	async function togglePin(r: RunMeta) {
		actionError = null;
		try {
			const { pinned } = await api.runs.setPinned(projectId, r.id, !r.pinned);
			runs = runs.map((x) => (x.id === r.id ? { ...x, pinned } : x));
			onRunsChange?.(runs);
		} catch (err) {
			actionError = msg(err);
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
	// The rail's filter over run labels (shown from RUN_FILTER_FROM runs up).
	let runQuery = $state('');
	const shownRuns = $derived(filterRuns(runs, runQuery));
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
		if (series && !series.some((x) => x.kind.startsWith('rain_'))) out.push('a rainfall series');
		return out;
	});
	const viewingLatest = $derived(!!latest && detail?.run.id === latest.id);
	const farmNames = $derived(Object.fromEntries(editor.model.nodes.map((n) => [n.id, n.name])));
	// The rail's in-page menu, and which section is being read (scroll spy).
	const groups = $derived(detail ? resultGroups(detail.run.summary) : []);
	const sections = $derived(groups.flatMap((g) => g.sections));
	let activeSection = $state<string | null>(null);
	$effect(() => {
		const ids = sections.map((x) => x.id);
		if (!ids.length) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const root = document.documentElement;
			// A section counts as reached once its top passes under the sticky header.
			const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 8;
			const tops = ids.flatMap((id) => {
				const el = document.getElementById(id);
				return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
			});
			activeSection = activeSectionId(tops, line, window.innerHeight + window.scrollY >= root.scrollHeight - 2);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Panels below load their charts after the summary, which moves every later section.
		const grow = new ResizeObserver(schedule);
		grow.observe(document.body);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			grow.disconnect();
		};
	});
	const downloadItems = $derived(
		detail
			? runDownloadItems(
					downloads,
					projectId,
					detail.run.id,
					editor.model.nodes.map((n) => ({ id: n.id, name: n.name })),
					detail.run.summary.farms.length > 0 ? { onPreview: previewFarmTable } : null
				)
			: []
	);
	// Download menu → Preview: the all-farms table in a dialog, mounted on first use and kept.
	let tablePreview = $state<FarmTableItem | null>(null);
	let tablePreviewOpen = $state(false);
	function previewFarmTable(item: FarmTableItem) {
		tablePreview = item;
		tablePreviewOpen = true;
	}
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
{#if drift}<p class="alert alert-warning" role="status" data-testid="evidence-drift">{drift}</p>{/if}

<div class="layout">
	<!-- The rail: the runs list, then an in-page menu of the result panels. It
	     stays in view beside the long results page (sticky on wide screens) and
	     marks the section being read. -->
	<aside class="rail">
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
				{#if runs.length >= RUN_FILTER_FROM}
					<input class="filter" type="search" aria-label="Filter runs by label" placeholder="Filter {runs.length} runs" bind:value={runQuery} />
					{#if runQuery.trim()}<p class="muted small filter-count" role="status">{shownRuns.length ? `${shownRuns.length} of ${runs.length} runs` : 'No run label matches.'}</p>{/if}
				{/if}
				<!-- Compact rows: the label (two lines at most, the full label on
				     hover), when it ran and the years it covers, then small status
				     tags. The full dates, author and engine are in the results header. -->
				<ul class="runs">
					{#each shownRuns as r (r.id)}
						<li class:active={r.id === selectedId}>
							<button type="button" class="pick" title={r.label || 'Untitled run'} aria-current={r.id === selectedId || undefined} onclick={() => select(r.id)}>
								<span class="lbl">{r.label || 'Untitled run'}</span>
								<span class="meta">{fmtDate(r.createdAt, true)} · {runYears(r.startDate, r.endDate)}</span>
								{#if r.id === latest?.id || r.legacy || evidenceById.has(r.id) || r.pinned || r.id === currentPublishedRunId}
									<span class="tags">
										{#if r.id === latest?.id}<span class="tag">latest</span>{/if}
										{#if r.id === currentPublishedRunId}<span class="tag tag-owner" title="The published baseline: stakeholders and farmers see this run's figures. Kept while a publication holds it.">Published</span>{/if}
										{#if evidenceById.get(r.id) === 'current'}<span class="tag tag-owner" title="The project's nominated evidence run. Kept for good: it can't be deleted.">Evidence</span>{:else if evidenceById.get(r.id) === 'past'}<span class="tag" title="Nominated as evidence before, since replaced. Kept for good: it can't be deleted.">Former evidence</span>{/if}
										{#if r.pinned}<span class="tag" title="Pinned: newer runs never push it out, and it can't be deleted until it is unpinned.">Pinned</span>{/if}
										{#if r.legacy}<span class="tag tag-warn" title="Legacy runoff model (b023 workbook): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence.">Workbook comparison</span>{/if}
									</span>
								{/if}
							</button>
							{#if canRun}
								<div class="acts">
									<button
										type="button"
										class="btn btn-icon pin"
										aria-pressed={!!r.pinned}
										aria-label="Pin run {r.label || fmtDate(r.createdAt, true)}"
										title={r.pinned ? 'Unpin: newer runs can push it out again' : `Pin: newer runs never push it out (at most ${PINNED_RUNS_MAX} per project)`}
										onclick={() => togglePin(r)}
										><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 2h4l-.5 4 2.5 2.5v1H4v-1L6.5 6zM8 9.5V14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg></button
									>
									{#if !evidenceById.has(r.id) && !r.pinned && !heldByPublication.has(r.id)}
										<button type="button" class="btn btn-icon" aria-label="Delete run {r.label || fmtDate(r.createdAt, true)}" title="Delete run" onclick={() => remove(r)}>✕</button>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		{#if sections.length}
			<nav class="panel sections" aria-label="Result sections">
				<h2 class="rail-h">On this page</h2>
				<ul class="groups">
					{#each groups as g, gi (gi)}
						<li>
							{#if g.label}<span class="grp-h" id="grp-{gi}">{g.label}</span>{/if}
							<ul aria-labelledby={g.label ? `grp-${gi}` : undefined}>
								{#each g.sections as sec (sec.id)}
									<li><a href="#{sec.id}" aria-current={sec.id === activeSection ? 'location' : undefined}>{sec.label}</a></li>
								{/each}
							</ul>
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
	</aside>

	<div class="detail">
		{#if detailError && !detail}
			<div class="alert alert-error" role="alert">
				{detailError}
				<button type="button" class="btn btn-sm" onclick={() => selectedId && loadDetail(selectedId)}>Try again</button>
			</div>
		{:else if detail}
			{@const summary = detail.run.summary}
			<!-- The run's own settings: older cached details lack them, so fall back to the project's. -->
			{@const shownSettings = detail.run.settings}
			{@const runSettings = shownSettings ?? project.settings}
			{@const runSeries = detail.series}
			{@const shownRunId = detail.run.id}
			{@const shownRun = detail.run}
			<section class="panel" aria-labelledby="res-h" aria-busy={detailLoading}>
				<div class="panel-head">
					<div>
						<h2 id="res-h">{detail.run.label || 'Untitled run'}</h2>
						{#if detail.run.legacy}
							<span
								class="badge badge-warn"
								title="Legacy runoff model (b023 workbook): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence."
								>Workbook comparison</span
							>
						{/if}
						{#if evidenceById.get(detail.run.id) === 'current'}
							<span class="badge badge-owner">Evidence</span>
						{:else if evidenceById.get(detail.run.id) === 'past'}
							<span class="badge">Former evidence</span>
						{/if}
						{#if detail.run.id === currentPublishedRunId}<a class="badge badge-owner" href="#res-publication">Published</a>{/if}
						{#if shownEvidence}<a class="muted small evidence-line" href="#res-evidence">{shownEvidence}</a>{/if}
						<span class="muted small">
							{detail.run.startDate} → {detail.run.endDate} ({fmtNum(runDays(detail.run))} days) · run {fmtDate(detail.run.createdAt, true)}{detail.run.createdBy ? ` by ${detail.run.createdBy}` : ''} · engine {detail.run.engineVersion}
							{#if !viewingLatest && latest}· <button type="button" class="linkish" onclick={() => select(latest.id)}>go to latest</button>{/if}
						</span>
					</div>
					<div class="head-acts">
						<!-- The printable report of this run (routes/projects/[id]/report, docs/ui.md § Report). -->
						<a class="btn btn-sm" href="{base}/projects/{encodeURIComponent(projectId)}/report?run={encodeURIComponent(shownRunId)}">Report</a>
						<DownloadMenu items={downloadItems} />
					</div>
				</div>
				<section id="res-summary" aria-label="Run summary">
					<RunSummaryView summary={detail.run.summary} days={runDays(detail.run)} {nodeOrder} />
				</section>
			</section>
			<section class="panel" id="res-notes">
				{#key shownRunId}
					<RunNotes {projectId} run={shownRun} canEdit={canRun} flagLevel={summary.wr2012?.flag.level ?? null} onSaved={notesSaved} />
				{/key}
				<!-- One menu entry with the notes (sections.ts); the run header links straight here. -->
				<div class="evidence" id="res-evidence">
					{#key shownRunId}
						<Lazy load={loadEvidencePanel}>
							{#snippet children(EvidencePanel)}
								<EvidencePanel {projectId} run={shownRun} history={nominations} canEdit={canRun} onNominated={nominated} />
							{/snippet}
						</Lazy>
					{/key}
				</div>
			</section>
			<section class="panel" id="res-publication">
				{#if publicationError}
					<div class="alert alert-error" role="alert">
						Couldn’t load the publication: {publicationError}
						<button type="button" class="btn btn-sm" onclick={loadPublication}>Try again</button>
					</div>
				{:else if publication}
					{#key shownRunId}
						<Lazy load={loadPublicationPanel}>
							{#snippet children(PublicationPanel)}
								<PublicationPanel {projectId} run={shownRun} current={publication!.current} history={publication!.history} canEdit={canRun} onChange={published} />
							{/snippet}
						</Lazy>
					{/key}
				{:else}
					<p class="muted" role="status">Loading the publication…</p>
				{/if}
			</section>
			<RunCharts
				{projectId}
				runId={detail.run.id}
				refs={detail.series}
				farms={summary.farms ?? []}
				{nodeNames}
				{nodeOrder}
				{damCapacity}
			>
				{#snippet riverLead()}
					{#if summary.ewrAssurance?.length}
						<div class="panel" id="res-reserve">
							<Lazy load={loadAssurancePanel}>
								{#snippet children(EwrAssurancePanel)}
									<EwrAssurancePanel sites={summary.ewrAssurance ?? []} />
								{/snippet}
							</Lazy>
						</div>
					{/if}
				{/snippet}
				{#snippet riverTail()}
					<div class="panel" id="res-ewr-grid">
						{#if summary.ewrCompliance}
							<EwrHeatmap compliance={summary.ewrCompliance} />
						{:else}
							<h3>EWR compliance by month</h3>
							<p class="muted">This run was made before the monthly EWR compliance grid existed. Run the model again to see it.</p>
						{/if}
					</div>
				{/snippet}
				{#snippet farmsLead()}
					<section class="panel" id="res-curtailment">
						<CurtailmentTable {summary} {farmNames} />
					</section>
				{/snippet}
				{#snippet modelTail()}
					<div class="panel" id="res-calibration">
						<CalibrationPanel
							calibration={summary.calibration}
							requestedStart={runSettings.calibrationStart ?? null}
							requestedEnd={runSettings.calibrationEnd ?? null}
						/>
						{#if shownSettings}
							<div class="provenance">
								<FitProvenance record={shownSettings.fitRecord} settings={shownSettings} />
							</div>
						{/if}
						{#if summary.dataQuality?.observedAgreement?.flaggedYears.length}
							<div class="agree"><AgreementTable agreement={summary.dataQuality.observedAgreement} headingLevel={3} /></div>
						{/if}
						<!-- Uncertainty bands (issue #4 phase 9): with the calibration they come from, one menu entry. -->
						<div class="uncertainty" id="res-uncertainty">
							<Lazy load={loadUncertaintyPanel}>
								{#snippet children(UncertaintyPanel)}
									{#key shownRunId}
										<UncertaintyPanel {projectId} runId={shownRunId} runEngineVersion={shownRun.engineVersion} canEdit={canRun} />
									{/key}
								{/snippet}
							</Lazy>
						</div>
					</div>
					{#if summary.runoff}
						<div class="panel" id="res-runoff">
							<RunoffPanel balance={summary.runoff} {projectId} runId={shownRunId} refs={runSeries} />
						</div>
					{/if}
					{#if summary.wr2012}
						<div class="panel" id="res-wr2012">
							<Lazy load={loadWr2012Panel}>
								{#snippet children(Wr2012Panel)}
									<Wr2012Panel report={summary.wr2012!} />
								{/snippet}
							</Lazy>
						</div>
					{/if}
					<div class="panel" id="res-ewr-agreement">
						<EwrAgreementTable {summary} />
					</div>
					{#if summary.plausibility}
						<div class="panel" id="res-plausibility">
							<Lazy load={loadPlausibilityPanel}>
								{#snippet children(PlausibilityPanel)}
									<PlausibilityPanel checks={summary.plausibility!} {projectId} runId={shownRunId} runoffModel={shownRun.runoffModel} {runs} />
								{/snippet}
							</Lazy>
						</div>
					{/if}
				{/snippet}
				{#snippet deeperLead()}
					<section class="panel" id="res-checks">
						<SelfChecksPanel
							{summary}
							{projectId}
							runId={shownRunId}
							startDate={shownRun.startDate}
							endDate={shownRun.endDate}
							nodes={traceNodes}
						/>
					</section>
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

{#if tablePreview}
	<Lazy load={loadTableDialog}>
		{#snippet children(DailyTableDialog)}
			<DailyTableDialog
				bind:open={tablePreviewOpen}
				title={tablePreview!.label.replace(/ \(CSV\)$/, '')}
				url={tablePreview!.url}
				description={tablePreview!.hint}
			/>
		{/snippet}
	</Lazy>
{/if}

<style>
	.head-acts {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.evidence-line {
		display: block;
		margin: 0.15rem 0;
	}
	.evidence {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.provenance,
	.uncertainty {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
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
		grid-template-columns: 250px minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.rail {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	/* Wide screens: the rail rides along beside the results, scrolling on its own if taller than the window. */
	@media (min-width: 901px) {
		.rail {
			position: sticky;
			top: calc(var(--header-h) + 0.75rem);
			max-height: calc(100vh - var(--header-h) - 1.5rem);
			overflow-y: auto;
			overscroll-behavior: contain;
		}
		/* A long runs list scrolls inside its panel and gives up height to the menu
		   below, so the whole menu stays in view on a laptop screen however many
		   sections it lists: the rail is a column where only the list shrinks (a
		   fixed 25vh cap overflowed once the menu grew a line). */
		.rail {
			display: flex;
			flex-direction: column;
		}
		.rail .list {
			flex: 0 1 auto;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.rail .sections {
			flex: none;
		}
		.rail .runs {
			flex: 0 1 auto;
			min-height: 7.5rem;
			max-height: 24rem;
			overflow-y: auto;
		}
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
	/* A label shows at most two lines; the full label is the row's tooltip and the results heading. */
	.lbl {
		font-weight: 600;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.meta {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.15rem;
	}
	.tag {
		font-size: 0.68rem;
		font-weight: 600;
		line-height: 1.5;
		padding: 0 0.35rem;
		border-radius: 999px;
		white-space: nowrap;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.tag-owner {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.tag-warn {
		background: var(--warning-soft);
		color: var(--warning);
	}
	/* Pin above delete, in a narrow column, so the label keeps the rail's width. */
	.acts {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.35rem 0.3rem 0 0;
	}
	.filter {
		width: 100%;
		margin-bottom: 0.4rem;
	}
	.filter-count {
		margin: 0 0 0.4rem;
	}
	.pin svg {
		fill: none;
	}
	.pin[aria-pressed='true'] {
		color: var(--accent);
	}
	.pin[aria-pressed='true'] svg {
		fill: currentColor;
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
	/* In-page menu: the results run to about fifteen panels. A vertical list in
	   the rail on wide screens, wrapping chips above the results on narrow ones. */
	.rail-h {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin: 0 0 0.4rem;
	}
	.sections ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	/* A group's name above its links (sections.ts), quieter than the links. */
	.grp-h {
		display: block;
		margin: 0.4rem 0 0.05rem;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.sections a {
		display: block;
		padding: 0.25rem 0.6rem;
		border-left: 2px solid var(--border);
		font-size: 0.85rem;
		color: var(--text-2);
		text-decoration: none;
	}
	.sections a:hover {
		color: var(--accent);
		border-left-color: var(--accent);
	}
	.sections a[aria-current='location'] {
		color: var(--accent);
		border-left-color: var(--accent);
		background: var(--accent-soft);
		font-weight: 600;
	}
	@media (max-width: 900px) {
		.sections ul {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
		}
		/* Each group's chips wrap on their own lines, under the group's name. */
		.sections ul.groups {
			display: block;
		}
		.sections a {
			display: inline-flex;
			align-items: center;
			min-height: 36px;
			padding: 0 0.6rem;
			border: 1px solid var(--border);
			border-radius: 999px;
			font-size: 0.8rem;
		}
		.sections a:hover,
		.sections a[aria-current='location'] {
			border-color: var(--accent);
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
