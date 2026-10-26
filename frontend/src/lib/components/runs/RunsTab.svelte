<script lang="ts">
	import { SearchStep } from '#lib/nav/searchStep.js';
	import { isScenarioRun } from '#lib/components/runs/scenarioRun.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { compareTabHref } from '#lib/components/compare/picker.js';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { rebuildingNote } from '#lib/series/provenance.js';
	import { kindLabel } from '#lib/series/kinds.js';
	import { api, PINNED_RUNS_MAX, type Nomination, type Project, type Publication, type PublicationMeta, type Run, type RunMeta, type RunSeriesRef } from '#lib/api/index.js';
	import DownloadMenu from '#lib/components/export/DownloadMenu.svelte';
	import { downloads, runDownloadItems, type FarmTableItem } from '#lib/export/index.js';
	import { fmtDay, fmtNum, fmtStamp, fmtWhen } from '#lib/format/number.js';
	import type { ModelEditor } from '#lib/model/editor.svelte.js';
	import { dataEnd, newDataSinceRun } from '#lib/components/series/freshness.js';
	import { detailCache, forgetRun, runDetail } from './cache';
	import { notesPreview } from './notes';
	import RunCharts from './RunCharts.svelte';
	import RunSummaryView from './RunSummaryView.svelte';
	import SelfChecksPanel from './SelfChecksPanel.svelte';
	import WaterBalanceTable from './WaterBalanceTable.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import RunNotes from './RunNotes.svelte';
	import ValidationPanel from '#lib/components/liability/ValidationPanel.svelte';
	import NotesDrawer from '#lib/components/notes/NotesDrawer.svelte';
	import { currentNomination, evidenceLine, modelDriftWarning } from './evidence';
	import { otherPageGroups, resultGroups } from './sections';
	import { anchorMoved } from '#lib/nav/anchorMoves.js';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { supplyHref } from '#lib/components/supply/links.js';
	import { calibrationHref } from '#lib/components/calibration/links.js';
	import { warningPlaceHref } from './warningText';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { historyDays, ranAgo } from '#lib/components/overview/latestRun.js';
	import { focusAnchor, hashId, holdAnchor, landOnAnchor } from '#lib/help/anchor.js';
	import { missingPanel, type MissingPanel } from './missingPanel';
	import SectionNav from '#lib/components/common/SectionNav.svelte';
	import { focusAfterRemove } from '#lib/a11y/focusAfterRemove.js';
	import { defaultRunId, filterRuns, isRunGone, RUN_FILTER_FROM, rowLabels, runErrorText, runYears } from './runList';
	import { runTags, tagKey } from './runTags';
	import { publishedRunIds } from './publication';
	import { riverHref } from '#lib/components/river/links.js';
	import { hasForecastRain, runBlockers } from './runReady';
	// Panels every shown run renders (evidence, "Check reproduction", "Changes since this run",
	// publication) are in the Runs chunk: as chunks of their own they loaded on every visit anyway
	// and cost ~7 KB gzip of split overhead (issue #9). Assurance of supply moved to Hydrological units
	// with the other unit panels (issue #17).
	// Model quality (ModelQuality.svelte) moved to the Calibration page's chunk (issue #586 Round 3); tab chunks
	// have their own ceiling (scripts/guards/check_web_bundle_budget.mjs).
	import EvidencePanel from './EvidencePanel.svelte';
	import ReproducePanel from './ReproducePanel.svelte';
	import PublicationPanel from './PublicationPanel.svelte';
	import RunInputsPanel from '#lib/components/history/RunInputsPanel.svelte';
	import { FORMER_MEMBER } from '#lib/format/maker.js';
	// Reserve compliance, EWR vs outflow, EWR by month, the uncertainty bands, the outcome matrix, the
	// seasonal outlook and the water account moved to EWR (issue #17, river/RiverTab.svelte);
	// this page links there.
	// A forecast run's forecast days (WP-2.12): their own chunk, only forecast runs load it.
	const loadForecastPanel = () => import('#lib/components/forecast/ForecastPanel.svelte');
	// A run judged by a DRM table: its tables × s, as it read them (issue #90 B1); its own chunk.
	const loadRunScaledEwr = () => import('./RunScaledEwrTables.svelte');
	// The preview of an all-farms download (Download menu → Preview): its own chunk, fetched on first use.
	const loadTableDialog = () => import('#lib/components/export/DailyTableDialog.svelte');

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
	/** The list has loaded and holds no run: the page shows one empty state (the Runs card) and no results column. */
	const noRuns = $derived(!loading && !loadError && runs.length === 0);
	/** The list failed to load and holds no run: the rail's alert is the page's one message, with no results column (#586 D3). */
	const listFailed = $derived(!loading && !!loadError && runs.length === 0);
	const RESULTS_SHOW =
		"A run's results: its summary and water balance, with the fit to observed flow on Calibration, EWR compliance on EWR and each hydrological unit's supply and dam storage on Hydrological units.";
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
	/** The run the URL names is no longer stored (404): Try again can't bring it back. */
	let detailGone = $state(false);

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
	let stopAnchors = () => {};
	/** An old link is being sent on to the panel's new page (nav/anchorMoves.ts): this page writes nothing more into the URL. */
	let forwarding = false;
	onMount(() => {
		// A link to a panel that moved to EWR (#res-reserve, #res-ewr, …) or Hydrological units
		// (#res-curtailment from a bookmarked "units short this week", …), or to the link rows those
		// groups left here for a while (#res-river, #res-units), issue #17: there instead, for the same
		// run (and reporting window), replacing this entry so Back skips it (nav/anchorMoves.ts). On
		// load, and for a #fragment typed or followed while the page is open, which lands on its panel
		// too (finding R2-D); the load's own landing waits for the run (below).
		stopAnchors = followAnchors({
			page: 'runs',
			onLoad: false,
			land: (id) => (fragmentShown ? landOnceShown(id) : undefined),
			forward: (to) => {
				forwarding = true;
				void goto(to, { replace: true, reset: false });
			}
		});
		if (forwarding) return;
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

	/**
	 * Show a run. A pick the user makes is a new history entry, so Back returns to the run before, as a
	 * unit, dam or run pick does on every page (ui-playbook § 4, "A pick is a step in history"); the
	 * default pick and the fallback after a delete replace the entry, so Back never stops on them.
	 */
	function select(id: string | null, how: 'pick' | 'default' = 'default'): Promise<void> {
		const url = new URL(page.url.href);
		if (id) url.searchParams.set('run', id);
		else url.searchParams.delete('run');
		if (url.search === page.url.search) return Promise.resolve();
		return goto(url, { replace: how === 'default', reset: false });
	}
	/**
	 * Go to latest: the button hides once the latest run shows, and it had the focus, so the focus goes to that run's
	 * row in the list (the results heading when a filter hides the row), not to <body> (#586 E9).
	 */
	async function goLatest() {
		if (!latest) return;
		await select(latest.id, 'pick');
		await tick();
		const row = document.querySelector<HTMLElement>('ul.runs li.active button.pick');
		const target = row ?? document.getElementById('res-h');
		if (!target) return;
		if (!row && !target.hasAttribute('tabindex')) target.tabIndex = -1;
		target.focus();
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
		detailGone = false;
		try {
			// Shared with the Calibration page (cache.ts runDetail): one request for a run either page asks for.
			const d = await runDetail(id, () => api.runs.get(projectId, id));
			if (detailFor === id) detail = d;
		} catch (e) {
			if (detailFor === id) {
				detail = null;
				detailError = runErrorText(e);
				detailGone = isRunGone(e);
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
	// after the browser's own jump, and some (Forecast, Unit rain, WR2012, everything after the
	// flow-duration curve) are lazy chunks drawn later still. So wait for the panel and then its
	// heading (landOnAnchor), scroll there and hold it while the panels above load, with focus
	// on the heading so Tab carries on from there. A panel this run doesn't have (#res-wr2012 on
	// a run without a WR2012 reference, issue #586) shows a line saying what it needs instead,
	// focused. Later jumps (the section menu, a #fragment typed) land through followAnchors above.
	let fragmentShown = false;
	/** The validation statement is open: the known-bug badge opens it (issue #103). */
	let validationOpen = $state(false);
	/** The line for a linked panel this run doesn't draw (missingPanel.ts), for the run it was linked on. */
	let missingLink = $state<{ runId: string; hash: string; panel: MissingPanel } | null>(null);
	let releaseFragment = () => {};
	let destroyed = false;
	$effect(() => {
		if (!detail || fragmentShown) return;
		fragmentShown = true;
		const hash = untrack(() => hashId(page.url.hash));
		if (hash) releaseFragment = landResult(hash);
	});
	// A link that also picks another run (`?run=r2#res-notes`, nav/anchorLandingEnv.svelte.ts) arrives while the
	// run shown is still the old one: landing then would focus the old run's panel, which the new run's replace.
	// So hold the landing until the picked run's details are in.
	let pendingHash = $state<string | null>(null);
	const shownIsPicked = $derived(!!detail && (!selectedId || detail.run.id === selectedId));
	function landOnceShown(hash: string): (() => void) | void {
		if (untrack(() => shownIsPicked)) return landResult(hash);
		pendingHash = hash;
		return () => {
			if (pendingHash === hash) pendingHash = null;
		};
	}
	$effect(() => {
		if (!shownIsPicked || !pendingHash) return;
		const hash = pendingHash;
		pendingHash = null;
		untrack(() => landResult(hash));
	});
	/** Land on the results panel `hash` names, or on the line saying this run lacks it; the release function. */
	function landResult(hash: string): () => void {
		releaseFragment();
		releaseFragment = () => {};
		if (!detail || !hash.startsWith('res-') || anchorMoved('runs', hash)) return () => {};
		// The known-bug badge's link (issue #103): the statement opens on load too, not only on a click.
		if (hash === 'res-validation') validationOpen = true;
		const lacking = missingPanel(hash, detail.run.summary);
		missingLink = lacking ? { runId: detail.run.id, hash, panel: lacking } : null;
		let release = () => {};
		let gone = false;
		tick().then(() => {
			if (destroyed || gone) return;
			const line = lacking ? document.getElementById('res-missing') : null;
			if (line) {
				release = holdAnchor(line);
				focusAnchor(line);
			} else release = landOnAnchor(hash);
		});
		releaseFragment = () => {
			gone = true;
			release();
		};
		return releaseFragment;
	}
	onDestroy(() => {
		destroyed = true;
		stopAnchors();
		releaseFragment();
	});

	// Once the list is known and the URL names no run: the newest run, or for a
	// viewer the published baseline (runList.ts defaultRunId). ?run= always wins. Not while an old link is sent on:
	// writing the default replaced the forward's address, so `?tab=runs#res-calibration` stayed here (issue #586 round 3).
	$effect(() => {
		if (!forwarding && !loading && !selectedId && runs.length) select(defaultRunId(runs, project.role));
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
			select(r.id, 'pick');
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
	const evidenceFmt = fmtStamp;
	/** The run header's evidence line for the shown run, or null when it was never nominated. */
	const shownEvidence = $derived(detail ? evidenceLine(detail.run.id, nominations, evidenceFmt) : null);

	/** A run was nominated: the history and every run's status follow. */
	function nominated(history: Nomination[]) {
		nominations = history;
		const status = (id: string) => evidenceById.get(id) ?? null;
		commit(runs.map((r) => ({ ...r, evidence: status(r.id) })));
	}


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
		if (!(await confirmDialog({ title: `Delete run “${r.label || fmtStamp(r.createdAt)}”?`, confirmLabel: 'Delete run', danger: true }))) return;
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
		const at = shownRuns.findIndex((x) => x.id === r.id);
		forgetRun(r.id);
		commit(runs.filter((x) => x.id !== r.id));
		if (selectedId === r.id) {
			detail = null;
			detailFor = '';
			select(runs[0]?.id ?? null);
		}
		// Its row, and the ✕ that had the focus, have gone: the run now in its place takes it.
		await focusAfterRemove(at, 'ul.runs button.pick', 'runs-h');
	}

	// Inputs changed since the newest run? Settings/model saves bump the
	// project's updatedAt; new data shows as a driver series reaching past the
	// run's end (when no fixed simulation end is set).
	const latest = $derived(runs[0] ?? null);
	// The rail's filter over run labels (shown from RUN_FILTER_FROM runs up).
	// In the URL (`q=`), so a reload and Back keep it (issue #521): the first change after the box takes the focus
	// is a step in history, the rest of that search replaces it (as the project list's search does).
	let runQuery = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	// Only while the box shows: an old link's q= never hides runs behind a filter that isn't on screen.
	const shownRuns = $derived(runs.length >= RUN_FILTER_FROM ? filterRuns(runs, runQuery) : runs);
	/** Each row's label: null shows it whole (clamped to two lines), else the form that keeps it apart from a look-alike (#586 D7). */
	const shortLabels = $derived(rowLabels(shownRuns.map((r) => r.label || 'Untitled run')));
	const rowTags = $derived(shownRuns.map((r) => runTags(r, { latestId: latest?.id ?? null, publishedId: currentPublishedRunId, evidence: evidenceById.get(r.id) })));
	const tagLines = $derived(tagKey(rowTags));
	/**
	 * Stacked (a phone), a long list folds to its newest run and the shown run's, with its filter, so the results start
	 * on the first screen (#586 D8: three rows still ran the results' heading past a 390×844 screen, each row 96 px with
	 * its tap-size pin and delete); the fold is CSS (.runs.folded), so the wide rail, which scrolls inside itself, shows
	 * every row and the filter. Not while a filter narrows the list: the filter is the reader's own fold.
	 */
	const FOLD_ROWS = 1;
	let runsAll = $state(false);
	const foldable = $derived(!runQuery.trim() && shownRuns.length > FOLD_ROWS + 1);
	const foldHidden = $derived(foldable ? shownRuns.filter((r, i) => i >= FOLD_ROWS && r.id !== selectedId).length : 0);
	/** The run on screen isn't in the filtered list (a filter that matches nothing, or not it): say so (#586 D20). */
	const shownOutsideFilter = $derived(!!runQuery.trim() && !!detail && !shownRuns.some((r) => r.id === detail!.run.id));
	const queryStep = new SearchStep();
	let queryTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The last words this box wrote to the URL: the URL catching up with them isn't a new filter. Without it, a
	 * write that landed after more typing put the older words back in the box (as History's filter keeps them).
	 */
	let written = untrack(() => page.url.searchParams.get('q') ?? '');
	$effect(() => {
		const q = page.url.searchParams.get('q') ?? '';
		if (q !== untrack(() => written)) runQuery = written = q;
	});
	function writeQuery() {
		clearTimeout(queryTimer);
		queryTimer = setTimeout(() => {
			const url = new URL(page.url.href);
			const words = runQuery.trim();
			if (words) url.searchParams.set('q', words);
			else url.searchParams.delete('q');
			if (url.search === page.url.search) return;
			written = words;
			void queryStep.write(url.href, (replace) => goto(url, { replace, reset: false }));
		}, 300);
	}
	$effect(() => () => clearTimeout(queryTimer));
	const stale = $derived.by(() => {
		if (!latest) return null;
		const reasons: string[] = [];
		if (project.updatedAt > latest.createdAt) reasons.push('the model or settings were saved');
		const newer = project.settings.simulationEnd ? [] : newDataSinceRun(series ?? [], latest);
		if (newer.length) reasons.push(`new data in ${newer.map((x) => x.name || x.kind.replace(/_/g, ' ')).join(', ')}, now to ${fmtDay(newer.map(dataEnd).sort().pop() ?? '')}`);
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
		detail ? [...resultGroups(detail.run.summary, navLayout === 'rail'), ...(navLayout === 'rail' ? otherPageGroups(detail.run.id) : [])] : []
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
	{#if loading && !runs.length}Loading runs…{:else if listFailed}Couldn’t load the runs{:else if !runs.length}No runs yet{:else}{runCount(runs.length)}{latest ? ` · newest ran ${ranAgo(latest.createdAt)}` : ''}{/if}
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
				Simulating every day of the record for every hydrological unit{elapsed >= 1 ? ` · ${elapsed} s` : ''}. Large catchments take a few seconds.
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
				Runs use the saved network, crops, transfers, settings and time series.{#if hasForecast}
					Run forecast runs the record as an ordinary run, then the days after the last recorded rain on forecast rain, shown apart; one forecast run is kept.{/if}
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

<!-- No runs: one empty state, the Runs card across the page, saying what a run will show (a second
     "Results appear here" card beside or under it was mostly empty space, a screen of it on a phone). -->
<div class="layout" class:no-runs={noRuns || listFailed} bind:this={layoutEl} style:--rail-top="{railTop}px">
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
					Couldn’t load the runs: {loadError} <button type="button" class="btn btn-sm" onclick={load}>Try again</button>
				</div>
			{:else if runs.length === 0}
				<!-- "Run the model" only while it can start: otherwise the status line under the header says what a run needs. -->
				<div class="empty">
					<p>{!canRun ? 'No runs yet.' : missing.length || overAllocated ? 'No runs yet. A run can start once the note above is dealt with.' : 'No runs yet. Run the model to see results.'}</p>
					<p class="muted small">{RESULTS_SHOW}</p>
				</div>
			{:else}
				{#if runs.length >= RUN_FILTER_FROM}
					<input class="filter" class:folded={foldable && !runsAll} type="search" aria-label="Filter runs by label" placeholder="Filter {runs.length} runs" bind:value={runQuery} onfocus={queryStep.focus} oninput={writeQuery} />
					{#if runQuery.trim()}<p class="muted small filter-count" role="status">{shownRuns.length ? `${shownRuns.length} of ${runs.length} runs` : 'No run label matches.'}</p>{/if}
					{#if shownOutsideFilter && detail}<p class="muted small filter-count" data-testid="shown-outside-filter">Showing “{detail.run.label || 'Untitled run'}”, which isn’t in the filter.</p>{/if}
				{/if}
				<!-- Compact rows: the label (two lines at most, the full label on
				     hover), when it ran and the years it covers, then small status
				     tags. The full dates, author and engine are in the results header. -->
				<ul class="runs" class:folded={foldable && !runsAll} id="runs-list">
					{#each shownRuns as r, i (r.id)}
						{@const short = shortLabels[i]}
						<li class:active={r.id === selectedId} class:beyond={i >= FOLD_ROWS && r.id !== selectedId}>
							<button type="button" class="pick" title={r.label || 'Untitled run'} aria-current={r.id === selectedId || undefined} onclick={() => select(r.id, 'pick')}>
								{#if short}
									<!-- Shortened to keep it apart from a look-alike: the full label is read out, and is the results heading once picked. -->
									<span class="lbl" aria-hidden="true">{short}</span><span class="visually-hidden">{r.label}</span>
								{:else}
									<span class="lbl">{r.label || 'Untitled run'}</span>
								{/if}
								<!-- Each part on one line: "2021–2022" broke after its dash, a third line on every row. -->
								<span class="meta"><span class="nw">{fmtWhen(r.createdAt)}</span> · <span class="nw">{runYears(r.startDate, r.endDate)}</span></span>
								{#if rowTags[i]?.length}
									<span class="tags">
										{#each rowTags[i]! as t (t.id)}<span class="tag" class:tag-owner={t.tone === 'owner'} class:tag-warn={t.tone === 'warn'} title={t.detail ?? undefined}>{t.label}</span>{/each}
									</span>
								{/if}
							</button>
							{#if canRun}
								<div class="acts">
									<button
										type="button"
										class="btn btn-icon pin"
										aria-pressed={!!r.pinned}
										aria-label="Pin run {r.label || fmtStamp(r.createdAt)}"
										title={r.pinned ? 'Unpin: newer runs can push it out again' : `Pin: newer runs never push it out (at most ${PINNED_RUNS_MAX} per project)`}
										onclick={() => togglePin(r)}
										><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 2h4l-.5 4 2.5 2.5v1H4v-1L6.5 6zM8 9.5V14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg></button
									>
									{#if !evidenceById.has(r.id) && !r.pinned && !heldByPublication.has(r.id) && !r.citedBy?.length}
										<button type="button" class="btn btn-icon" aria-label="Delete run {r.label || fmtStamp(r.createdAt)}" title="Delete run" onclick={() => remove(r)}>✕</button>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
				<!-- Show all and the tags' key share a line under the list, so a folded phone list stays short. -->
				<div class="list-foot">
					{#if foldable}
						<!-- Stacked only (CSS): the wide rail lists every row and scrolls inside itself. -->
						<button type="button" class="btn btn-sm fold-btn" aria-expanded={runsAll} aria-controls="runs-list" onclick={() => (runsAll = !runsAll)}
							>{runsAll ? 'Show fewer runs' : `Show all ${shownRuns.length} runs`}{#if !runsAll}<span class="visually-hidden">, {foldHidden} more</span>{/if}</button
						>
					{/if}
					{#if tagLines.length}
						<!-- The tags in words, for touch and keyboard: their hover titles reach only a mouse (#586 D18). -->
						<details class="tag-key small">
							<summary>What the tags mean</summary>
							<dl>
								{#each tagLines as t (t.label)}<div><dt>{t.label}</dt><dd>{t.meaning}</dd></div>{/each}
							</dl>
						</details>
					{/if}
				</div>
			{/if}
		</section>
	</aside>

	{#if !noRuns && !listFailed}
	<div class="detail">
		<!-- In-page menu, grouped by the question each panel answers: from 62rem of results a side index on the
		     right (the runs list is the left column), with the main panels of EWR and Hydrological
		     units under their pages; narrower a bar sticking under the app header above the results (issue #462). -->
		<SectionNav groups={navGroups} label="Result sections" railFrom={RESULTS_RAIL_FROM_REM} railSide="right" bind:layout={navLayout}>
		{#if detailError && !detail}
			<div class="alert alert-error" role="alert">
				{detailError}
				{#if !detailGone}
					<button type="button" class="btn btn-sm" onclick={() => selectedId && loadDetail(selectedId)}>Try again</button>
				{:else if latest && latest.id !== selectedId}
					<button type="button" class="btn btn-sm" onclick={() => select(latest.id, 'pick')}>Show the newest run</button>
				{/if}
			</div>
		{:else if detail}
			{@const summary = detail.run.summary}
			<!-- The run's own settings: older cached details lack them. -->
			{@const shownSettings = detail.run.settings}
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
								title="Legacy runoff model (the original workbook’s, removed in engine 1.0.0): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence; it can’t be re-run."
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
						{#if summary.forecast}<a class="badge badge-warn" href="#res-forecast">Forecast from {fmtDay(summary.forecast.from)}</a>{/if}
						{#if shownEvidence}<a class="muted small evidence-line" href="#res-evidence">{shownEvidence}</a>{/if}
						<!-- The note leads the reader to the Record group, below the results (sections.ts). -->
						{#if notesPreview(detail.run.notes)}<a class="muted small evidence-line" href="#res-notes" data-testid="notes-preview">Notes: {notesPreview(detail.run.notes)}</a>{/if}
						<span class="muted small">
							{fmtDay(detail.run.startDate)} – {fmtDay(detail.run.endDate)} ({fmtNum(runDays(detail.run))} days) · ran {fmtWhen(detail.run.createdAt)} by {detail.run.createdBy ?? FORMER_MEMBER} · engine {detail.run.engineVersion}
							{#if !viewingLatest && latest}· <button type="button" class="linkish" onclick={goLatest}>go to latest</button>{/if}
						</span>
						<!-- The river and unit panels have their own pages (issue #17): one link each, keeping the run. -->
						<nav class="outcomes small" aria-label="Outcomes for this run">
							<span class="muted">For this run:</span>
							<!-- What each page holds, in words beside its link rather than a hover title (#586 D18). -->
							<span class="outcome"
								><a href={riverHref(shownRunId)} aria-label="EWR for this run" aria-describedby="outcome-ewr">EWR <span aria-hidden="true">→</span></a>
								<span class="muted" id="outcome-ewr">reserve compliance, EWR by month, outlook and water account</span></span
							>
							<span class="outcome"
								><a href={supplyHref(shownRunId)} aria-label="Hydrological units for this run" aria-describedby="outcome-units">Hydrological units <span aria-hidden="true">→</span></a>
								<span class="muted" id="outcome-units">supply against demand, curtailment and assurance of supply</span></span
							>
						</nav>
					</div>
					<div class="head-acts">
						<!-- This run against the published baseline (docs/run-comparison.md): A = published, B = this run. -->
						{#if currentPublishedRunId && currentPublishedRunId !== shownRunId}
							<a class="btn btn-sm" href={compareTabHref({ projectId, runId: currentPublishedRunId }, { projectId, runId: shownRunId })}>Compare with published</a>
						{/if}
						<!-- The printable report of this run (routes/projects/[id]/report, docs/ui.md § Report). -->
						<a class="btn btn-sm" href={resolve(`projects/${encodeURIComponent(projectId)}/report?run=${encodeURIComponent(shownRunId)}`)}>Report</a>
						<!-- The licensing evidence report (issue #71, docs/ui.md § Evidence report): for the nominated run, or an application run on it. -->
						{#if shownRun.evidence === 'current' || isScenarioRun(shownRun)}
							<a class="btn btn-sm" href={resolve(`projects/${encodeURIComponent(projectId)}/report?run=${encodeURIComponent(shownRunId)}&evidence`)} data-testid="evidence-report-link">Evidence report</a>
						{/if}
						<DownloadMenu items={downloadItems} />
					</div>
				</div>
				<section id="res-summary" aria-labelledby="summary-h">
					<!-- Named as the side index and the bar name it (#586 D4). -->
					<h3 id="summary-h" class="summary-h">Summary</h3>
					<RunSummaryView foldChecks summary={detail.run.summary} days={historyDays(detail.run)} headline={project.settings.ewrHeadline ?? null} reserveHref={riverHref(detail.run.id, 'res-reserve')} otherUsesHref={(hash) => supplyHref(shownRunId, { hash })} calibrationHref={(hash) => calibrationHref(shownRunId, hash)} placeHref={(place) => warningPlaceHref(place, shownRunId)} />
					{#if summary.catchment.outletEwr && shownSettings?.ewrDailySource}
						<Lazy load={loadRunScaledEwr}>
							{#snippet children(RunScaledEwrTables)}
								<RunScaledEwrTables source={shownSettings.ewrDailySource!} info={summary.catchment.outletEwr!} />
							{/snippet}
						</Lazy>
					{/if}
				</section>
			</section>
			{#if missingLink && missingLink.runId === detail.run.id}
				<!-- A link to a panel this run doesn't have (missingPanel.ts): what it needs, focused on landing. -->
				<p class="panel missing-panel" id="res-missing" tabindex="-1" data-testid="missing-panel" data-for={missingLink.hash}>
					{missingLink.panel.text}{#if missingLink.panel.link}{' '}<a href={missingLink.panel.link.href}>{missingLink.panel.link.label}</a>{/if}
				</p>
			{/if}
			{#if summary.forecast}
				<Lazy load={loadForecastPanel}>
					{#snippet children(ForecastPanel)}
						<ForecastPanel forecast={summary.forecast!} {nodeNames} />
					{/snippet}
				</Lazy>
			{/if}
			<RunCharts {projectId} run={shownRun} refs={runSeries} {nodeNames} {nodeOrder}>
				{#snippet waterBalance()}
					<!-- The water balance per water year (issue #137): the table a hydrologist hands a client first. -->
					<div class="panel" id="res-water-balance">
						<WaterBalanceTable {summary} accountHref={riverHref(shownRunId, 'res-water-account')} />
					</div>
				{/snippet}
				{#snippet record()}
					<!-- The Record group (issue #521): Run notes, Evidence and Reproduction are panels of their own, each with its action where it is seen. -->
					<section class="panel" id="res-notes">
						{#key shownRunId}
							<RunNotes {projectId} run={shownRun} canEdit={canRun} flagLevel={summary.wr2012?.flag.level ?? null} onSaved={notesSaved}>
								{#snippet aside()}
									<!-- The team's notes on the run (WP-2.7), at the heading's right as on every Settings panel; RunNotes' intro says how they differ. -->
									<NotesDrawer {projectId} target={{ kind: 'run', runId: shownRun.id, label: shownRun.label || fmtStamp(shownRun.createdAt) }} />
								{/snippet}
							</RunNotes>
						{/key}
					</section>
					<!-- The run header's evidence line links straight here. -->
					<div class="panel" id="res-evidence">
						{#key shownRunId}
							<EvidencePanel {projectId} run={shownRun} history={nominations} canEdit={canRun} onNominated={nominated} />
						{/key}
					</div>
					<!-- Re-running the run from its stored inputs, then what changed in the inputs since: both about the run's inputs. -->
					<div class="panel" id="res-reproduce">
						{#key shownRunId}
							<ReproducePanel {projectId} run={shownRun} nodeName={(id: string) => nodeNames.get(id)} />
						{/key}
						{#key shownRunId}
							<RunInputsPanel {projectId} run={shownRun} canEdit={canRun} {modelDirty} onRestored={onInputsRestored} />
						{/key}
					</div>
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
			<div class="panel placeholder muted">Pick a run to see its results. {RESULTS_SHOW}</div>
		{/if}
		</SectionNav>
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
	/* Each link with what its page holds beside it (#586 D18), wrapping as one piece on a phone. */
	.outcome {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.4rem;
	}
	/* A flex item drops the space before the arrow ("EWR→"), so the gap puts it back. */
	.outcomes a {
		display: inline-flex;
		align-items: center;
		gap: 0.25em;
		min-height: 24px;
	}
	/* Report, Evidence report and Download wrap on a 320 px phone rather than push the page sideways. */
	.head-acts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.evidence-line {
		display: block;
		margin: 0.15rem 0;
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
	/* A phone: the label and its field fill the first row, then Run forecast and Run model share the next in equal
	   halves (Run model alone fills it), so no row ends in a gap (issue #521 round 5). The field asks for the row's
	   full width less the label's, so the buttons can't join that row. */
	@media (max-width: 640px) {
		.run-form {
			justify-content: flex-start;
		}
		.run-form input {
			flex: 1 1 calc(100% - 6rem);
			min-height: 44px;
		}
		.run-form .btn {
			flex: 1 1 0;
			justify-content: center;
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
	/* Positioned, so a row's visually hidden full label (a shortened row, #586 D7) sits in its row: placed against the
	   sticky rail instead, the hidden labels of rows scrolled out of the list ran the rail 480 px past its box. */
	.pick {
		position: relative;
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
	/* Proportional figures: Inter's tabular ones set each hyphen a digit wide, and "2026-10-11 01:01 ·
	   2021–2022" then missed the rail's line by a few px, a third line on every row. */
	.meta {
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.meta .nw {
		white-space: nowrap;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.15rem;
	}
	.tag {
		font-size: var(--font-xs);
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
	/* A field standing alone on a phone gets the tap size (issue #521 round 5: 32 px). */
	@media (pointer: coarse), (max-width: 640px) {
		.filter {
			min-height: var(--tap);
		}
	}
	.filter-count {
		margin: 0 0 0.4rem;
	}
	/* Stacked (a phone), a long list shows its first rows and the shown run's under "Show all N runs" (#586 D8),
	   so the results start on the first screen; the wide rail (below) lists every row and scrolls inside itself. */
	.runs.folded li.beyond,
	.filter.folded {
		display: none;
	}
	.list-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin-top: 0.4rem;
	}
	.list-foot:empty {
		display: none;
	}
	@container runs-page (min-width: 50rem) {
		.runs.folded li.beyond {
			display: flex;
		}
		.filter.folded {
			display: block;
		}
		.fold-btn {
			display: none;
		}
		/* The rail is clipped to the window: an opened key scrolls inside itself rather than run past it. */
		.tag-key dl {
			max-height: 40vh;
			overflow-y: auto;
		}
	}
	/* The tags in words (#586 D18): one line under the list that opens. */
	.tag-key {
		color: var(--text-2);
	}
	.tag-key[open] {
		flex-basis: 100%;
	}
	.tag-key summary {
		cursor: pointer;
		min-height: 24px;
		color: var(--text-muted);
	}
	.tag-key dl {
		margin: 0.35rem 0 0;
		display: grid;
		gap: 0.35rem;
	}
	.tag-key dt {
		font-weight: 600;
	}
	.tag-key dd {
		margin: 0;
	}
	/* The Summary's heading: the first in its panel, under the run header (#586 D4). */
	.summary-h {
		margin: 1rem 0 0.5rem;
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
		padding: 1.25rem 0.75rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty p {
		margin: 0;
	}
	.empty p + p {
		margin-top: 0.4rem;
	}
	/* No runs: the Runs card is the page's one empty state, across its width (wide too: no empty results column). */
	.layout.no-runs {
		grid-template-columns: minmax(0, 1fr);
	}
	.no-runs .rail {
		position: static;
		max-height: none;
	}
	.no-runs .empty {
		text-align: left;
	}
	.placeholder {
		text-align: center;
		padding: 3rem 1rem;
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
