<script lang="ts">
	import { isScenarioRun } from '$lib/components/runs/scenarioRun';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { compareTabHref } from '$lib/components/compare/picker';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { resolveQualityFlags, toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { apanDailyOfInput, chirpsSourceOfInput, originOfFit, rebuildingNote, runChirpsFactors } from '$lib/series/provenance';
	import { kindLabel } from '$lib/series/kinds';
	import { api, PINNED_RUNS_MAX, type Nomination, type Project, type Publication, type PublicationMeta, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import CalibrationCheck from '$lib/components/calibration/CalibrationCheck.svelte';
	import type { CheckNode } from '$lib/components/calibration/calibrationCheck';
	import CalibrationPanel from '$lib/components/calibration/CalibrationPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import EwrAgreementTable from '$lib/components/ewr/EwrAgreementTable.svelte';
	import AgreementTable from '$lib/components/series/AgreementTable.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { downloads, runDownloadItems, type FarmTableItem } from '$lib/export';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { dataEnd, newDataSinceRun } from '$lib/components/series/freshness';
	import { detailCache, forgetRun, prefetchSeries } from './cache';
	import { CATCHMENT_FLOW_KEYS } from './flowSeries';
	import { notesPreview } from './notes';
	import RunCharts from './RunCharts.svelte';
	import RunSummaryView from './RunSummaryView.svelte';
	import SelfChecksPanel from './SelfChecksPanel.svelte';
	import WaterBalanceTable from './WaterBalanceTable.svelte';
	import RunoffPanel from './RunoffPanel.svelte';
	import { unitRainOf } from './unitRain';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import RunNotes from './RunNotes.svelte';
	import ValidationPanel from '$lib/components/liability/ValidationPanel.svelte';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { currentNomination, evidenceLine, modelDriftWarning } from './evidence';
	import { movedHref, otherPageGroups, resultGroups } from './sections';
	import { supplyHref } from '$lib/components/supply/links';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { historyDays, ranAgo } from '$lib/components/overview/latestRun';
	import { holdAnchor } from '$lib/help/anchor';
	import SectionNav from '$lib/components/common/SectionNav.svelte';
	import { defaultRunId, filterRuns, isRunGone, RUN_FILTER_FROM, runErrorText, runYears } from './runList';
	import { publishedRunIds } from './publication';
	import { riverHref } from '$lib/components/river/links';
	import { hasForecastRain, runBlockers } from './runReady';
	// Panels every shown run renders (evidence, "Check reproduction", "Changes since this run",
	// publication) are in the Runs chunk: as chunks of their own they loaded on every visit anyway
	// and cost ~7 KB gzip of split overhead (issue #9). Assurance of supply moved to Hydrological units
	// with the other unit panels (issue #17).
	// The plausibility checks (engine ≥ 0.25.0) render for every run that has them, which is every
	// run since, so they are in this chunk too (tab chunks have their own ceiling,
	// scripts/guards/check_web_bundle_budget.mjs).
	import PlausibilityPanel from './PlausibilityPanel.svelte';
	import EvidencePanel from './EvidencePanel.svelte';
	import ReproducePanel from './ReproducePanel.svelte';
	import PublicationPanel from './PublicationPanel.svelte';
	import RunInputsPanel from '$lib/components/history/RunInputsPanel.svelte';
	import { runExclusions } from './exclusionShading';
	import { FORMER_MEMBER } from '$lib/format/maker';
	// The WR2012 report: its own chunk, only a run that has one loads it.
	const loadWr2012Panel = () => import('./Wr2012Panel.svelte');
	// Rain for each unit (issue #482): its own chunk, only a run that ran per unit loads it.
	const loadUnitRainPanel = () => import('./UnitRainPanel.svelte');
	// Reserve compliance, EWR vs outflow, EWR by month, the uncertainty bands, the outcome matrix, the
	// seasonal outlook and the water account moved to River & reserve (issue #17, river/RiverTab.svelte);
	// this page links there.
	// A forecast run's forecast days (WP-2.12): their own chunk, only forecast runs load it.
	const loadForecastPanel = () => import('$lib/components/forecast/ForecastPanel.svelte');
	// A run judged by a DRM table: its tables × s, as it read them (issue #90 B1); its own chunk.
	const loadRunScaledEwr = () => import('./RunScaledEwrTables.svelte');
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
		busy = false,
		beforeRun,
		onRunsChange,
		onInputsRestored
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
		/** A run the page started (the new-data line's Re-run model) is still going: this form waits for it. */
		busy?: boolean;
		/** Asked before a run starts: the page saves unsaved edits first (with the person's say); false stops the run. */
		beforeRun?: () => Promise<boolean>;
		onRunsChange?: (runs: RunMeta[]) => void;
		/** "Restore these inputs" changed the saved settings and model: the page reloads them. */
		onInputsRestored?: () => Promise<void>;
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
	/** This form's run or the page's: either way another can't start yet. */
	const runBusy = $derived(running || busy);
	let elapsed = $state(0);
	let timer: ReturnType<typeof setInterval> | undefined;

	const selectedId = $derived(page.url.searchParams.get('run'));
	let detail = $state<{ run: Run; series: RunSeriesRef[] } | null>(
		untrack(() => {
			const id = page.url.searchParams.get('run') ?? defaultRunId(initialRuns ?? [], project.role);
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
	const runDays = (r: { startDate: string; endDate: string }) => toEpochDay(r.endDate) - toEpochDay(r.startDate) + 1;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** Bumped by every change made here to the list or the evidence history (commit), so a load in flight can tell its answer is older. */
	let edits = 0;
	/** A change made here: the list (and the page's copy) take it. */
	function commit(next: RunMeta[]) {
		runs = next;
		edits++;
		onRunsChange?.(runs);
	}
	async function load() {
		if (!runs.length) loading = true;
		loadError = null;
		try {
			for (;;) {
				const at = edits;
				const [list, history] = await Promise.all([api.runs.list(projectId), api.runs.nominations(projectId)]);
				// A run made, removed, pinned or nominated here meanwhile: this answer predates it, so ask again
				// rather than put back the list from before it.
				if (edits !== at) continue;
				runs = list;
				nominations = history;
				onRunsChange?.(runs);
				break;
			}
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
		// A link to a panel that moved to River & reserve (#res-reserve, #res-ewr, …) or Hydrological units
		// (#res-curtailment from a bookmarked "units short this week", …), or to the link rows those
		// groups left here for a while (#res-river, #res-units), issue #17: there instead, for the same
		// run (and reporting window), replacing this entry so Back skips it.
		const moved = movedHref(page.url.hash.slice(1), page.url.searchParams.get('run'), page.url.searchParams.get('window'));
		if (moved) {
			goto(moved, { replaceState: true, noScroll: true });
			return;
		}
		load();
		loadPublication();
	});
	const currentPublishedRunId = $derived(publication?.current?.runId ?? null);
	// Every run the history holds: the server keeps them, so they get no delete button.
	const heldByPublication = $derived(publishedRunIds(publication?.history));
	function published(p: { current: Publication; history: PublicationMeta[] }) {
		publication = p;
		commit(runs.map((r) => ({ ...r, published: r.id === p.current.runId })));
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
			// The first charts' flows go out now, before the results page renders (cache.ts prefetchSeries).
			prefetchSeries(id, d.series, CATCHMENT_FLOW_KEYS.map(([, key]) => ({ key, nodeId: null })), (key, nodeId) => api.runs.series(projectId, id, key, nodeId));
			detailCache.set(id, d);
			if (detailFor === id) detail = d;
		} catch (e) {
			if (detailFor === id) {
				detail = null;
				detailError = runErrorText(e);
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

	// A link to a results panel (#res-publication from the Summary's published
	// baseline, #res-notes from a note): the panels render only once the run's details are in,
	// after the browser's own jump, so scroll there then and hold it while the
	// panels above load (holdAnchor), with focus on the panel's heading so Tab
	// carries on from there. Once: later jumps (the section menu) find their
	// panel on the page and are the browser's.
	let fragmentShown = false;
	/** The validation statement is open: the known-bug badge opens it (issue #103). */
	let validationOpen = $state(false);
	let releaseFragment = () => {};
	let destroyed = false;
	$effect(() => {
		if (!detail || fragmentShown) return;
		fragmentShown = true;
		const hash = untrack(() => page.url.hash.slice(1));
		if (!hash.startsWith('res-') || movedHref(hash, null)) return;
		// The known-bug badge's link (issue #103): the statement opens on load too, not only on a click.
		if (hash === 'res-validation') validationOpen = true;
		tick().then(() => {
			const el = destroyed ? null : document.getElementById(hash);
			if (!el) return;
			releaseFragment = holdAnchor(el);
			const heading = el.querySelector<HTMLElement>('h2, h3, h4') ?? el;
			if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
			heading.focus({ preventScroll: true });
		});
	});
	onDestroy(() => {
		destroyed = true;
		releaseFragment();
	});

	// Once the list is known and the URL names no run: the newest run, or for a
	// viewer the published baseline (runList.ts defaultRunId). ?run= always wins.
	$effect(() => {
		if (!loading && !selectedId && runs.length) select(defaultRunId(runs, project.role));
	});

	async function run(e: SubmitEvent) {
		e.preventDefault();
		await start(false);
	}
	/** Run the model, or (forecast) a forecast run: the history as an ordinary run, then the forecast days (WP-2.12). */
	async function start(forecast: boolean) {
		if (runBusy) return;
		if (beforeRun && !(await beforeRun())) return;
		running = true;
		actionError = null;
		elapsed = 0;
		const t0 = Date.now();
		timer = setInterval(() => (elapsed = Math.floor((Date.now() - t0) / 1000)), 250);
		try {
			const { run: r, removedRunIds } = await api.runs.create(projectId, label.trim() || undefined, { forecast });
			label = '';
			const { summary: _summary, ...meta } = r;
			// Drop the oldest runs the server trimmed to stay within its cap.
			commit([meta, ...runs.filter((x) => x.id !== r.id && !removedRunIds.includes(x.id))]);
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
		commit(runs.map((r) => (r.id === updated.id ? { ...r, ...fields } : r)));
	}

	// Each run's place in the evidence history, from the history itself so a
	// nomination shows at once: 'current', 'past' or absent.
	const evidenceById = $derived.by(() => {
		const m = new Map<string, 'current' | 'past'>();
		for (const n of nominations) if (n.runId) m.set(n.runId, 'past');
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
		commit(runs.map((r) => ({ ...r, evidence: status(r.id) })));
	}

	/** The scenarios based on a run (024_scenarios): it is kept, and can't be deleted, while they exist. */
	const citedByScenario = (r: RunMeta) => (r.citedBy ?? []).filter((c) => c.kind === 'scenario');
	const signedBy = (r: RunMeta) => (r.citedBy ?? []).filter((c) => c.kind === 'signoff').map((c) => c.name);

	/** Pin or unpin a run (015_run_pinned): the storage cap keeps a pinned run. */
	async function togglePin(r: RunMeta) {
		actionError = null;
		try {
			const { pinned } = await api.runs.setPinned(projectId, r.id, !r.pinned);
			commit(runs.map((x) => (x.id === r.id ? { ...x, pinned } : x)));
		} catch (err) {
			actionError = runErrorText(err);
		}
	}

	async function remove(r: RunMeta) {
		if (!(await confirmDialog({ title: `Delete run “${r.label || fmtDate(r.createdAt, true)}”?`, confirmLabel: 'Delete run', danger: true }))) return;
		actionError = null;
		try {
			await api.runs.remove(projectId, r.id);
		} catch (err) {
			// Already gone (deleted elsewhere, or trimmed): it leaves the list all the same.
			if (!isRunGone(err)) {
				actionError = runErrorText(err);
				return;
			}
		}
		forgetRun(r.id);
		commit(runs.filter((x) => x.id !== r.id));
		if (selectedId === r.id) {
			detail = null;
			detailFor = '';
			select(runs[0]?.id ?? null);
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
		if (newer.length) reasons.push(`new data in ${newer.map((x) => x.name || x.kind.replace(/_/g, ' ')).join(', ')}, now to ${newer.map(dataEnd).sort().pop()}`);
		return reasons.length ? reasons : null;
	});
	// What a run still needs, and whether forecast rain allows a forecast run (runReady.ts, shared with
	// the section header's Run model on the other sections). The editor's model, like the Network tab's
	// total (unsaved edits have their own note).
	const hasForecast = $derived(hasForecastRain(series));
	const blockers = $derived(runBlockers(editor.model, project.settings, series));
	const missing = $derived(blockers.missing);
	const overAllocated = $derived(blockers.overAllocated);
	const viewingLatest = $derived(!!latest && detail?.run.id === latest.id);
	// The in-page menu (SectionNav): above the results, or beside them from 62rem of results (a 1440 px
	// window), where 13rem of index leaves the results about as wide as at 1280 px without it (issue #462). The index lists the
	// main panels of the two pages the river and unit panels moved to; the bar leaves them to the run header.
	const RESULTS_RAIL_FROM_REM = 62;
	let navLayout = $state<'bar' | 'rail'>('bar');
	const navGroups = $derived(
		detail ? [...resultGroups(detail.run.summary), ...(navLayout === 'rail' ? otherPageGroups(detail.run.id) : [])] : []
	);
	const downloadItems = $derived(
		detail
			? runDownloadItems(
					downloads,
					projectId,
					detail.run.id,
					editor.model.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
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

	// The section header (workspace/SectionHeader) carries the title: the tab gives it the runs
	// line and, for an editor, the run form, the one place a run starts from the header (last, after Add data).
	$effect(() => fillHeader({ context: headerContext, main: canRun ? runForm : undefined }));
	const runCount = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`;

	// The rail fits the window from wherever it starts: under the header at the top of the page,
	// at its sticky offset once scrolled (the playbook's window fit, as a max-height, since the page
	// itself is a reading page and scrolls). The grid's own top is the rail's unstuck top.
	let layoutEl: HTMLDivElement | undefined = $state();
	let railEl: HTMLElement | undefined = $state();
	let layoutTop = $state(0);
	let stickTop = $state(0);
	let scrollY = $state(0);
	$effect(() => {
		if (!layoutEl || !railEl) return;
		const grid = layoutEl;
		const rail = railEl;
		const measure = () => {
			layoutTop = grid.getBoundingClientRect().top + window.scrollY;
			stickTop = parseFloat(getComputedStyle(rail).top) || 0;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	const railTop = $derived(Math.max(stickTop, layoutTop - scrollY));
</script>

<svelte:window bind:scrollY />

{#snippet headerContext()}
	{#if loading && !runs.length}Loading runs…{:else if !runs.length}No runs yet{:else}{runCount(runs.length)}{latest ? ` · newest ran ${ranAgo(latest.createdAt)}` : ''}{/if}
{/snippet}
<!-- The run form: in the section header, after Add data; its status line opens the page. -->
{#snippet runForm()}
	<form class="run-form" onsubmit={run} aria-busy={runBusy}>
		<label class="run-label" for="run-label">Run label <span class="visually-hidden">(optional)</span></label>
		<input id="run-label" maxlength="200" placeholder="optional, e.g. Baseline" bind:value={label} disabled={runBusy} />
		{#if hasForecast}
			<button
				type="button"
				class="btn"
				disabled={runBusy || missing.length > 0 || !!overAllocated}
				aria-describedby="run-note"
				title="The record as an ordinary run, then the days after the last recorded rain on forecast rain, shown apart. Keeps one forecast run."
				onclick={() => start(true)}>Run forecast</button
			>
		{/if}
		<button type="submit" class="btn btn-primary" disabled={runBusy || missing.length > 0 || !!overAllocated} aria-describedby="run-note">
			{#if runBusy}<span class="spin" aria-hidden="true"></span>{/if}
			{runBusy ? 'Running model…' : 'Run model'}
		</button>
	</form>
{/snippet}

<div class="runs-page">
{#if canRun}
	<!-- The run form's status: one slim line (the form is in the section header). -->
	<div class="run-status">
		<p class="note" id="run-note" role="status" aria-live="polite">
			{#if runBusy}
				Simulating every day of the record for all nodes{elapsed >= 1 ? ` · ${elapsed} s` : ''}. Large catchments take a few seconds.
			{:else if missing.length}
				<span class="warn">
					A run needs {missing.join(' and ')}. Set up the <a href="?tab=network">network</a> and upload
					<a href="?tab=series">rainfall data</a> first.
				</span>
			{:else if overAllocated}
				<span class="warn" data-testid="shares-over">
					The run can't start: {overAllocated}. See the <a href="?tab=network">network</a> or
					<a href="?tab=settings">settings</a>.
				</span>
			{:else if modelDirty}
				<span class="warn">The model has unsaved changes: Run model asks to save them first, since a run uses the saved model.</span>
			{:else if stale}
				<span class="warn">Inputs changed since the latest run ({stale.join('; ')}). Run again to update the results.</span>
			{:else}
				Runs use the saved network, crops, transfers, settings and time series.
			{/if}
		</p>
		{#if runBusy}<div class="progress" aria-hidden="true"><span></span></div>{/if}
	</div>
{:else if stale}
	<p class="alert alert-info">Inputs changed since the latest run ({stale.join('; ')}); an editor can run the model again.</p>
{/if}

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
{#if rebuildingNote(series, (s) => s.name || kindLabel(s.kind))}
	<p class="alert alert-info" role="status" data-testid="rebuilding-note">{rebuildingNote(series, (s) => s.name || kindLabel(s.kind))}</p>
{/if}
{#if drift}<p class="alert alert-warning" role="status" data-testid="evidence-drift">{drift}</p>{/if}

<div class="layout" bind:this={layoutEl} style:--rail-top="{railTop}px">
	<!-- The rail: the runs list, in view beside the long results page (sticky on wide screens). -->
	<aside class="rail" bind:this={railEl}>
		<section class="panel list" aria-labelledby="runs-h">
			<div class="panel-head">
				<h2 id="runs-h">Runs</h2>
				{#if runs.length >= 2}
					<a class="small" href={compareTabHref(null, null)}>Compare runs</a>
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
								{#if r.id === latest?.id || r.legacy || evidenceById.has(r.id) || r.pinned || r.id === currentPublishedRunId || r.scenarioName || citedByScenario(r).length || r.reproducible === false || r.trigger === 'auto' || r.trigger === 'forecast' || r.errata?.length}
									<span class="tags">
										{#if r.id === latest?.id}<span class="tag">latest</span>{/if}
										{#if r.trigger === 'auto'}<span class="tag" title="Made automatically after new data arrived (Settings → Automatic runs). Only the newest automatic run is kept, unless it is pinned or published.">Auto</span>{/if}
										{#if r.trigger === 'forecast'}<span class="tag tag-warn" title="A forecast run: the days from {r.forecastFrom} run on forecast rain and are shown apart; its other figures cover the record before them. Only the newest forecast run is kept, unless it is pinned or published.">Forecast</span>{/if}
										{#if r.id === currentPublishedRunId}<span class="tag tag-owner" title="The published baseline: stakeholders and farmers see this run's figures. Kept while a publication holds it.">Published</span>{/if}
										{#if evidenceById.get(r.id) === 'current'}<span class="tag tag-owner" title="The project's nominated evidence run. Kept for good: it can't be deleted.">Evidence</span>{:else if evidenceById.get(r.id) === 'past'}<span class="tag" title="Nominated as evidence before, since replaced or withdrawn. Kept for good: it can't be deleted.">Former evidence</span>{/if}
										{#if r.pinned}<span class="tag" title="Pinned: newer runs never push it out, and it can't be deleted until it is unpinned.">Pinned</span>{/if}
										{#if r.scenarioName}<span class="tag" title="Made by the scenario “{r.scenarioName}”: its changes applied to its base run.">Scenario</span>{/if}
										{#if citedByScenario(r).length}<span class="tag" title="The base of {citedByScenario(r).map((c) => `“${c.name}”`).join(', ')}: kept for good while {citedByScenario(r).length === 1 ? 'that scenario exists' : 'those scenarios exist'}, so it can't be deleted or unpinned.">Scenario base</span>{/if}
										{#if r.reproducible === false}<span class="tag" title="Made before runs stored their input series: it can't be re-run from them, only compared by hash.">Inputs not stored</span>{/if}
										{#if signedBy(r).length}<span class="tag tag-owner" title="Signed off by {signedBy(r).join(', ')} (see its report). Kept for good: it can't be deleted.">Signed off</span>{/if}
										{#if r.errata?.length}<span class="tag tag-warn" title="May be affected by {r.errata.length === 1 ? 'a known engine bug' : `${r.errata.length} known engine bugs`} ({r.errata.join(', ')}): each changes results only under its conditions. See the run's validation statement, and re-run on the current engine to compare.">May be affected</span>{/if}
										{#if r.legacy}<span class="tag tag-warn" title="Legacy runoff model (b023 workbook, removed in engine 1.0.0): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence; it can’t be re-run.">Workbook comparison</span>{/if}
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
									{#if !evidenceById.has(r.id) && !r.pinned && !heldByPublication.has(r.id) && !r.citedBy?.length}
										<button type="button" class="btn btn-icon" aria-label="Delete run {r.label || fmtDate(r.createdAt, true)}" title="Delete run" onclick={() => remove(r)}>✕</button>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</aside>

	<div class="detail">
		<!-- In-page menu, grouped by the question each panel answers: from 62rem of results a side index on the
		     right (the runs list is the left column), with the main panels of River & reserve and Hydrological
		     units under their pages; narrower a bar sticking under the app header above the results (issue #462). -->
		<SectionNav groups={navGroups} label="Result sections" railFrom={RESULTS_RAIL_FROM_REM} railSide="right" bind:layout={navLayout}>
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
								title="Legacy runoff model (b023 workbook, removed in engine 1.0.0): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence; it can’t be re-run."
								>Workbook comparison</span
							>
						{/if}
						{#if evidenceById.get(detail.run.id) === 'current'}
							<span class="badge badge-owner">Evidence</span>
						{:else if evidenceById.get(detail.run.id) === 'past'}
							<span class="badge">Former evidence</span>
						{/if}
						{#if detail.run.id === currentPublishedRunId}<a class="badge badge-owner" href="#res-publication">Published</a>{/if}
						{#if detail.run.errata?.length}<a
								class="badge badge-warn errata-badge"
								href="#res-validation"
								title="{detail.run.errata.join(', ')}: each changes results only under its conditions, which the validation statement gives (docs/engine-errata.md). Re-run on the current engine to compare."
								data-testid="run-errata"
								onclick={() => (validationOpen = true)}
								>May be affected by {detail.run.errata.length === 1 ? 'a known bug' : `${detail.run.errata.length} known bugs`}</a
							>{/if}
						{#if summary.forecast}<a class="badge badge-warn" href="#res-forecast">Forecast from {summary.forecast.from}</a>{/if}
						{#if shownEvidence}<a class="muted small evidence-line" href="#res-evidence">{shownEvidence}</a>{/if}
						<!-- The note leads the reader to the Record group, below the results (sections.ts). -->
						{#if notesPreview(detail.run.notes)}<a class="muted small evidence-line" href="#res-notes" data-testid="notes-preview">Notes: {notesPreview(detail.run.notes)}</a>{/if}
						<span class="muted small">
							{detail.run.startDate} → {detail.run.endDate} ({fmtNum(runDays(detail.run))} days) · run {fmtDate(detail.run.createdAt, true)} by {detail.run.createdBy ?? FORMER_MEMBER} · engine {detail.run.engineVersion}
							{#if !viewingLatest && latest}· <button type="button" class="linkish" onclick={() => select(latest.id)}>go to latest</button>{/if}
						</span>
						<!-- The river and unit panels have their own pages (issue #17): one link each, keeping the run. -->
						<nav class="outcomes small" aria-label="Outcomes for this run">
							<span class="muted">For this run:</span>
							<a
								href={riverHref(shownRunId)}
								aria-label="River & reserve for this run"
								title="EWR against outflow, reserve compliance, EWR by month, the uncertainty bands, the outcome matrix, the seasonal outlook and the water account">River &amp; reserve <span aria-hidden="true">→</span></a
							>
							<a
								href={supplyHref(shownRunId)}
								aria-label="Hydrological units for this run"
								title="Each hydrological unit's supply against its demand, the hydrological unit results table, the curtailment targets and assurance of supply">Hydrological units <span aria-hidden="true">→</span></a
							>
						</nav>
					</div>
					<div class="head-acts">
						<!-- This run against the published baseline (docs/run-comparison.md): A = published, B = this run. -->
						{#if currentPublishedRunId && currentPublishedRunId !== shownRunId}
							<a class="btn btn-sm" href={compareTabHref({ projectId, runId: currentPublishedRunId }, { projectId, runId: shownRunId })}>Compare with published</a>
						{/if}
						<!-- The printable report of this run (routes/projects/[id]/report, docs/ui.md § Report). -->
						<a class="btn btn-sm" href="{base}/projects/{encodeURIComponent(projectId)}/report?run={encodeURIComponent(shownRunId)}">Report</a>
						<!-- The licensing evidence report (issue #71, docs/ui.md § Evidence report): for the nominated run, or an application run on it. -->
						{#if shownRun.evidence === 'current' || isScenarioRun(shownRun)}
							<a class="btn btn-sm" href="{base}/projects/{encodeURIComponent(projectId)}/report?run={encodeURIComponent(shownRunId)}&evidence" data-testid="evidence-report-link">Evidence report</a>
						{/if}
						<DownloadMenu items={downloadItems} />
					</div>
				</div>
				<section id="res-summary" aria-label="Run summary">
					<RunSummaryView summary={detail.run.summary} days={historyDays(detail.run)} headline={project.settings.ewrHeadline ?? null} reserveHref={riverHref(detail.run.id, 'res-reserve')} otherUsesHref={(hash) => supplyHref(shownRunId, { hash })} />
					{#if summary.catchment.outletEwr && shownSettings?.ewrDailySource}
						<Lazy load={loadRunScaledEwr}>
							{#snippet children(RunScaledEwrTables)}
								<RunScaledEwrTables source={shownSettings.ewrDailySource!} info={summary.catchment.outletEwr!} />
							{/snippet}
						</Lazy>
					{/if}
				</section>
			</section>
			{#if summary.forecast}
				<Lazy load={loadForecastPanel}>
					{#snippet children(ForecastPanel)}
						<ForecastPanel forecast={summary.forecast!} {nodeNames} />
					{/snippet}
				</Lazy>
			{/if}
			<RunCharts
				{projectId}
				runId={detail.run.id}
				refs={detail.series}
				{nodeNames}
				{nodeOrder}
				forecastFrom={summary.forecast?.from ?? null}
				exclusions={runExclusions(shownSettings, summary.calibration?.exclusions)}
				flagUse={shownSettings ? resolveQualityFlags(shownSettings.qualityFlags) : null}
			>
				{#snippet modelTail(flow)}
					<div class="panel" id="res-calibration">
						<CalibrationPanel
							calibration={summary.calibration}
							requestedStart={runSettings.calibrationStart ?? null}
							requestedEnd={runSettings.calibrationEnd ?? null}
						/>
						<!-- Flow against use at each gauge with a record (issue #444): where a calibration gap is read. -->
						<CalibrationCheck
							{projectId}
							runId={shownRunId}
							refs={runSeries}
							nodes={(shownRun.model?.nodes ?? []) as unknown as CheckNode[]}
							{nodeNames}
							forecastFrom={summary.forecast?.from ?? null}
							flowUnit={flow.flowUnit}
							toolbar={flow.toolbar}
						/>
						{#if shownSettings}
							<div class="provenance">
								<FitProvenance record={shownSettings.fitRecord} settings={shownSettings} chirpsSource={chirpsSourceOfInput(shownRun.inputSeries)} apanDaily={apanDailyOfInput(shownRun.inputSeries)} chirpsFactors={runChirpsFactors(shownRun.summary)} observedOrigin={originOfFit(shownRun.inputSeries, shownSettings.fitRecord)} />
							</div>
						{/if}
						{#if summary.dataQuality?.observedAgreement?.flaggedYears.length}
							<div class="agree"><AgreementTable agreement={summary.dataQuality.observedAgreement} headingLevel={3} /></div>
						{/if}
					</div>
					<!-- The water balance per water year (issue #137): the table a hydrologist hands a client first. -->
					<div class="panel" id="res-water-balance">
						<WaterBalanceTable {summary} accountHref={riverHref(shownRunId, 'res-water-account')} />
					</div>
					{#if summary.runoff}
						<div class="panel" id="res-runoff">
							<RunoffPanel balance={summary.runoff} {projectId} runId={shownRunId} refs={runSeries} forecastFrom={summary.forecast?.from ?? null} />
						</div>
					{/if}
					{#if unitRainOf(summary)}
						{@const unitRain = unitRainOf(summary)!}
						<div class="panel" id="res-unit-rain">
							<Lazy load={loadUnitRainPanel}>
								{#snippet children(UnitRainPanel)}
									<UnitRainPanel result={unitRain} order={summary.farms.map((f) => f.nodeId)} />
								{/snippet}
							</Lazy>
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
						<!-- The same test at each gauge EWR site with a record of its own (engine ≥ 1.41.0). -->
						{#each summary.catchment?.ewrAgreementSites ?? [] as site (site.nodeId)}
							<EwrAgreementTable {summary} {site} title="EWR test at {site.name}: model against its observed flow" />
						{/each}
					</div>
					{#if summary.plausibility}
						<div class="panel" id="res-plausibility">
							<PlausibilityPanel checks={summary.plausibility} {projectId} runId={shownRunId} runoffModel={shownRun.runoffModel} {runs} />
						</div>
					{/if}
				{/snippet}
				{#snippet record()}
					<section class="panel" id="res-notes">
						{#key shownRunId}
							<RunNotes {projectId} run={shownRun} canEdit={canRun} flagLevel={summary.wr2012?.flag.level ?? null} onSaved={notesSaved} />
						{/key}
						<!-- Comments on the run from anyone on the team (WP-2.7), beside its one written explanation above. -->
						<p class="run-comments"><NotesDrawer {projectId} target={{ kind: 'run', runId: shownRun.id, label: shownRun.label || fmtDate(shownRun.createdAt, true) }} /></p>
						<!-- One menu entry with the notes (sections.ts); the run header links straight here. -->
						<div class="evidence" id="res-evidence">
							{#key shownRunId}
								<EvidencePanel {projectId} run={shownRun} history={nominations} canEdit={canRun} onNominated={nominated} />
							{/key}
							{#key shownRunId}
								<ReproducePanel {projectId} run={shownRun} nodeName={(id: string) => nodeNames.get(id)} />
							{/key}
						</div>
						{#key shownRunId}
							<RunInputsPanel {projectId} run={shownRun} canEdit={canRun} {modelDirty} onRestored={onInputsRestored} />
						{/key}
					</section>
					<!-- The report's validation statement (WP-3.13), folded shut; its body loads when opened. -->
					<div class="panel" id="res-validation">
						<ValidationPanel
							{summary}
							engineVersion={shownRun.engineVersion}
							legacy={shownRun.legacy}
							fitEngineVersion={shownRun.settings?.fitRecord?.engineVersion ?? null}
							bind:open={validationOpen}
						/>
					</div>
					<section class="panel" id="res-publication">
						{#if publicationError}
							<div class="alert alert-error" role="alert">
								Couldn’t load the publication: {publicationError}
								<button type="button" class="btn btn-sm" onclick={loadPublication}>Try again</button>
							</div>
						{:else if publication}
							{#key shownRunId}
								<PublicationPanel {projectId} run={shownRun} current={publication!.current} history={publication!.history} canEdit={canRun} actsForAuthority={project.actsForAuthority ?? false} onChange={published} />
							{/key}
						{:else}
							<p class="muted" role="status">Loading the publication…</p>
						{/if}
					</section>
				{/snippet}
				{#snippet deeperLead()}
					<section class="panel" id="res-checks">
						<SelfChecksPanel
							{summary}
							{projectId}
							runId={shownRunId}
							startDate={shownRun.startDate}
							endDate={shownRun.endDate}
							engineVersion={shownRun.engineVersion}
							nodes={traceNodes}
							balanceHref="#res-water-balance"
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
				hydrological unit's supply and dam storage.
			</div>
		{/if}
		</SectionNav>
	</div>
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
	/* The site badge capitalises each word; this one is a sentence (issue #103). */
	.errata-badge {
		text-transform: none;
	}
	.runs-page {
		container: runs-page / inline-size;
	}
	/* The river and unit pages for the shown run: one line in the run header. */
	.outcomes {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.9rem;
		margin-top: 0.2rem;
	}
	.outcomes a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
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
	.provenance {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	/* In the section header's actions: label, field and buttons on one row, wrapping on a phone. */
	.run-form {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		flex: 1 1 auto;
		justify-content: flex-end;
	}
	.run-label {
		font-size: 0.85rem;
		color: var(--text-2);
		margin: 0;
	}
	.run-form input {
		width: 15rem;
		min-width: 0;
		flex: 0 1 15rem;
		min-height: 38px;
	}
	@media (max-width: 640px) {
		.run-form {
			justify-content: flex-start;
		}
		.run-form input {
			flex: 1 1 10rem;
			min-height: 44px;
		}
	}
	/* The run form's status: one slim line above the page, with the progress bar under it while a run goes. */
	.run-status {
		position: relative;
		margin: -0.4rem 0 0.75rem;
		padding-bottom: 4px;
	}
	.note {
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
		border-radius: 2px;
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
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.rail {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	/* Stacked (narrow): a long runs list scrolls inside its panel past about five rows, so the
	   shown run's results start near the top instead of under twenty rows. */
	.runs {
		max-height: 20rem;
		overflow-y: auto;
	}
	/* Wide (from 50rem = 700 px of page at the 14 px root, not the viewport: the app
	   sidebar takes 240 px): the rail beside the results. It rides along, the height
	   left in the window at most (less the save bar), and a long runs list scrolls
	   inside its panel (from a 7.5rem floor), clipping rather than spilling out. */
	@container runs-page (min-width: 50rem) {
		.layout {
			grid-template-columns: 250px minmax(0, 1fr);
		}
		.rail {
			position: sticky;
			top: calc(var(--header-h) + 0.75rem);
			max-height: calc(100vh - var(--rail-top, 0.75rem) - var(--dock-h, 0px) - 0.75rem);
			display: flex;
			flex-direction: column;
		}
		.rail .list {
			flex: 0 1 auto;
			min-height: 0;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}
		.rail .runs {
			flex: 0 1 auto;
			min-height: 7.5rem;
			max-height: none;
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
