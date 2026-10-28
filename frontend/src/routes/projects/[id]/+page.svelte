<script module lang="ts">
	// Only the Overview tab (the default, first paint) ships in this page's
	// chunk. Every other tab, and the Add data dialog, is its own chunk, fetched
	// when first shown and warmed when its tab link is hovered or focused
	// (docs/architecture.md § Code splitting). Module scope keeps each loader's
	// identity stable, which is what lazy.ts memoises on.
	const LOAD = {
		network: () => import('#lib/components/network/NetworkTab.svelte'),
		map: () => import('#lib/components/map/MapTab.svelte'),
		crops: () => import('#lib/components/crops/CropsTab.svelte'),
		transfers: () => import('#lib/components/transfers/TransfersTab.svelte'),
		series: () => import('#lib/components/series/SeriesTab.svelte'),
		warnings: () => import('#lib/components/warnings/WarningsTab.svelte'),
		settings: () => import('#lib/components/settings/SettingsTab.svelte'),
		calibration: () => import('#lib/components/calibration/CalibrationTab.svelte'),
		runs: () => import('#lib/components/runs/RunsTab.svelte'),
		river: () => import('#lib/components/river/RiverTab.svelte'),
		supply: () => import('#lib/components/supply/SupplyTab.svelte'),
		dams: () => import('#lib/components/dams/DamsTab.svelte'),
		compare: () => import('#lib/components/compare/CompareView.svelte'),
		scenarios: () => import('#lib/components/scenarios/ScenariosTab.svelte'),
		allocations: () => import('#lib/components/allocations/AllocationsTab.svelte'),
		project: () => import('#lib/components/project/ProjectTab.svelte'),
		applications: () => import('#lib/components/scenarios/ApplicationsTab.svelte'),
		history: () => import('#lib/components/history/HistoryTab.svelte')
	};
	const loadAddData = () => import('#lib/components/series/AddDataDialog.svelte');
	// The Data row's count of open warnings (issue #611): the Warnings page's own loader and helper, its chunk
	// fetched once the page is idle, so the badge and the page count alike.
	const loadWarningCount = () => import('#lib/components/warnings/sources.js');
	// The save bar's Preview of the unsaved model edits against the last run (issue #284).
	const loadUnsavedPreview = () => import('#lib/components/preview/UnsavedPreviewDialog.svelte');
	// One farm's planted areas over any tab (`farm=<nodeId>`, issue #17 step 4).
	const loadFarmDrawer = () => import('#lib/components/crops/FarmCropsDrawer.svelte');
	// An existing grid, unchanged, in a full-screen modal over any tab (`grid=<id>`, issue #17).
	const loadGridModal = () => import('#lib/components/model/GridModal.svelte');
	// An applicant's whole view of the project (WP-3.3): the workspace's tabs all refuse them.
	const loadApplicantView = () => import('#lib/components/scenarios/ApplicantView.svelte');
	// The assistant's side sheet (issue #610), from the header's Assistant button.
	const loadAssistant = () => import('#lib/components/assistant/AssistantPanel.svelte');
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { SeriesMeta } from '@water-management/engine';
	import { chirpsSourceOf, observedOriginsOf } from '#lib/series/provenance.js';
	import { api, ApiError, hasRole, type Project, type ProjectSummary, type RunMeta } from '#lib/api/index.js';
	import { session } from '#lib/auth/session.svelte.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import { prefetch } from '#lib/components/common/lazy.js';
	import { provideUnsaved } from '#lib/components/common/chunkFailed.js';
	import { guardUnsaved, listAnd } from '#lib/nav/unsaved.js';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { provideInvalidFields } from '#lib/components/common/invalidFields.svelte.js';
	import type { PageDraft } from '#lib/components/model/pageDraft.js';
	import { issueHref } from '#lib/model/validate.js';
	import { ProjectDetailsDraft } from '#lib/components/project/detailsDraft.svelte.js';
	import { SettingsDraft } from '#lib/components/settings/settingsDraft.svelte.js';
	import { blockerHref } from '#lib/components/settings/blockers.js';
	import { rainRecordOptions } from '#lib/components/settings/recordPeriods.js';
	import { FitSession } from '#lib/calibration/fitSession.svelte.js';
	import type { UnsavedEdits } from '#lib/preview/overlay.js';
	import IssueList from '#lib/components/model/IssueList.svelte';
	import SaveBar from '#lib/components/model/SaveBar.svelte';
	import OverviewTab from '#lib/components/overview/OverviewTab.svelte';
	import { agoText } from '#lib/format/age.js';
	import { freshness, newDataSinceRun, STALE_DAYS } from '#lib/components/series/freshness.js';
	import type { UploadResult } from '#lib/components/series/upload.js';
	import { rerunQueuedText, resolveAutoRun } from '#lib/components/autorun/autoRun.js';
	import { fmtDay } from '#lib/format/number.js';
	import { projectToday } from '#lib/components/projects/freshness.js';
	import { kindLabel } from '#lib/series/kinds.js';
	import { ModelEditor } from '#lib/model/editor.svelte.js';
	import { fetchProjectPage, takeProjectPage } from '#lib/workspace/firstLoad.js';
	import { compareTabHref } from '#lib/components/compare/picker.js';
	import { carriedRun, isRunTab, pickOf, tabHref as tabLinkHref } from '#lib/workspace/tabLinks.js';
	import { defaultRunId } from '#lib/components/runs/runList.js';
	import { AssistantChat } from '#lib/components/assistant/chat.svelte.js';
	import type { SettingsProposal } from '#lib/api/types.js';
	import { badgeCount, problems, type FeedProblem } from '#lib/components/warnings/problems.js';
	import { landOnField } from '#lib/nav/fieldLanding.js';
	import { focusPageStart } from '#lib/a11y/focusPage.js';
	import { firstOutletSeries } from '#lib/series/pick.js';
	import { withoutFarm } from '#lib/components/crops/farmDrawer.js';
	import { FieldHistoryStore, setFieldHistory } from '#lib/components/history/fieldHistory.svelte.js';
	import { MediaQuery } from 'svelte/reactivity';
	import { fillPhoneTitle, fillSidebar } from '#lib/components/layout/sidebar.svelte.js';
	import SectionHeader from '#lib/components/workspace/SectionHeader.svelte';
	import SectionsMenu from '#lib/components/workspace/SectionsMenu.svelte';
	import RunButton from '#lib/components/workspace/RunButton.svelte';
	import { hasForecastRain, runBlockers } from '#lib/components/runs/runReady.js';
	import { headerSlot } from '#lib/components/workspace/headerSlot.svelte.js';
	import { sectionContext } from '#lib/components/workspace/context.js';
	import { GRID_TAB, isGridId, isTabGridId, movedGridHref, withParam, withoutParam } from '#lib/workspace/overlays.js';
	import {
		ALL_TABS,
		addsData,
		REFUSED_DROP_TEXT,
		canOpenTab,
		hasModelInputsToggle,
		hiddenChoice,
		navSections,
		stripTabs,
		TAB_GUIDE,
		TAB_LABELS,
		VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT,
		visibleTabs,
		type TabId
	} from '#lib/workspace/tabs.js';

	// Every tab the page renders; the sidebar orders them by section
	// (navSections) and names them from TAB_LABELS, which help shares.
	const TAB_IDS: TabId[] = ALL_TABS;
	const MODEL_TABS: TabId[] = ['network', 'crops', 'transfers'];
	// Friendlier ?tab= spellings that resolve to the canonical keys above.
	const TAB_ALIASES: Record<string, TabId> = {
		summary: 'overview',
		data: 'series',
		timeseries: 'series',
		demand: 'crops',
		results: 'runs',
		// The EWR page (issue #558) keeps its old id, so a saved choice of sections and old links still work.
		ewr: 'river',
		reserve: 'river',
		units: 'supply',
		farms: 'supply',
		changes: 'history',
		gis: 'map',
		'catchment-map': 'map',
		details: 'project',
		members: 'project',
		sharing: 'project'
	};

	const projectId = $derived(page.params.id ?? '');
	let project = $state<Project | null>(null);
	const tab = $derived.by<TabId>(() => {
		const raw = page.url.searchParams.get('tab') ?? '';
		const t = TAB_ALIASES[raw] ?? raw;
		if (!(TAB_IDS as string[]).includes(t)) return 'overview';
		// A tab the role may not open (a viewer's old Applications link) is the Summary.
		if (project && !canOpenTab(project.role, t)) return 'overview';
		return t as TabId;
	});

	/** Set when the caller is an applicant here (the contributor role): the page is the Applicant view. */
	let applicantProject = $state<ProjectSummary | null>(null);
	// Which tabs each role is shown (presentation only; a hidden tab still
	// opens from a deep link, and then shows in the strip while it's open).
	let showModelInputs = $state(VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT);
	// What the role sees, then less the sections the person hid themselves
	// (SectionsMenu, their account's preferences).
	const roleIds = $derived(visibleTabs(project?.role, { showModelInputs }, TAB_IDS));
	const shownIds = $derived(
		visibleTabs(project?.role, { showModelInputs, hidden: hiddenChoice(session.user?.preferences?.hiddenTabs) }, TAB_IDS)
	);
	// "Changed 3× · last by …" under the model inputs (docs/ui.md § Field history): for those whose role sees
	// History, whether or not they keep it in their sidebar (it is hidden by default, DEFAULT_HIDDEN_TABS, and
	// the line's link still opens it); fetched once a line asks for it, and again after a save or a restore.
	const canSeeHistory = $derived(roleIds.includes('history'));
	const fieldHistory = $derived(canSeeHistory && projectId ? new FieldHistoryStore(projectId) : null);
	setFieldHistory(() => fieldHistory);
	const LABEL = TAB_LABELS;
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notFound = $state(false);
	// The project's own model: the baseline, which never keeps water for the EWR (issue #523 B4).
	const editor = new ModelEditor({ baseline: true });
	// The project details being edited on the Project page (issue #162 item 12):
	// held here, so they survive a tab change and share the model's save bar.
	const details = new ProjectDetailsDraft();
	// The settings' unsaved edits, on Model settings and on Calibration alike: held here for the same reasons, so a tab
	// change keeps them, an edit on one page and one on the other are one draft, and the one save bar saves them
	// (settings/settingsDraft.svelte.ts).
	const settings = new SettingsDraft();
	// Fit automatically's choices, running fit and result: held here too, so a fit keeps running and its
	// result waits to be applied while another tab is open (calibration/fitSession.svelte.ts).
	const fit = new FitSession();
	// Leaving the workspace ends the fit's worker.
	$effect(() => () => fit.reset(null));
	// The number fields on this page holding text they can't take (common/invalidFields): this page's
	// own registry, which a scenario's override mode (with its own) keeps out of the save bar.
	const invalidFields = provideInvalidFields();
	// A model tab with problems in unsaved edits stays in the strip though hidden, so its link and dot can be reached.
	const problemTabs = $derived(hasRole(project?.role, 'editor') && editor.dirty ? MODEL_TABS.filter((id) => editor.issues.some((x) => x.area === id)) : []);
	const stripIds = $derived(stripTabs(shownIds, tab, TAB_IDS, problemTabs));
	// Review, Build the model, Outcomes (lib/workspace/tabs.ts NAV_SECTIONS). `strip` is the same tabs
	// flattened in the order shown, for the arrow keys.
	const sections = $derived(navSections(stripIds));
	const strip = $derived(sections.flatMap((s) => s.tabs));
	// A tab or dialog whose chunk fails to download offers a reload; with
	// unsaved edits it warns first (the reload still meets the browser's
	// own prompt, lib/nav/leaveGuard.ts).
	provideUnsaved(() => editor.dirty || details.dirty || settings.dirty || invalidFields.count > 0);
	// Leaving the project (not just changing tab) with any of them unsaved asks first, in
	// the app's dialog (lib/nav/leaveGuard.ts); a tab change keeps them all, so going between Model settings and
	// Calibration, whose panels share the settings draft, never asks (issue #586 round 3), and neither does a link
	// to a panel that moved to another tab (#set-feeds), which forwards with the draft kept and the save bar still shown.
	guardUnsaved({ dirty: () => editor.dirty, what: 'model edits' });
	guardUnsaved({ dirty: () => details.dirty, what: 'project details' });
	guardUnsaved({ dirty: () => settings.dirty, what: 'settings' });
	// A running fit, or a result an editor hasn't applied to the form yet: a viewer's result can't be applied, so only a running one asks.
	guardUnsaved({
		dirty: () => (canEdit ? fit.unapplied : fit.busy),
		what: () => (fit.busy ? 'an automatic fit still running' : 'an automatic fit not yet applied to the form')
	});
	// A number field holding text it can't take (common/invalidFields) is gone with its page or its
	// tab (the field unmounts), so any change of page or of the URL's query asks; a #fragment doesn't.
	guardUnsaved({
		dirty: () => invalidFields.count > 0,
		what: 'fields that need fixing',
		leaves: (from, to) => from.pathname !== to.pathname || from.search !== to.search
	});
	// The save bar's other drafts besides the model (components/model/pageDraft.ts): the project
	// details and the settings, each an adapter here and a step in saveAll.
	const detailsDraft: PageDraft = {
		what: 'the project details',
		region: 'Unsaved project details',
		get dirty() {
			return details.dirty;
		},
		get saving() {
			return details.saving;
		},
		get saveError() {
			return details.saveError;
		},
		get problems() {
			return details.problems.map((message) => ({ message, href: '?tab=project' }));
		},
		revert: () => details.revert()
	};
	const settingsDraft: PageDraft = {
		what: 'the settings',
		region: 'Unsaved settings',
		takesReason: true,
		previewable: true,
		get dirty() {
			return settings.dirty;
		},
		get saving() {
			return settings.saving;
		},
		get saveError() {
			return settings.saveError;
		},
		// Each panel with a problem, linked to it on its page (Model settings or Calibration, issue #586 round 3): in
		// place on that page, from any other tab through it.
		get problems() {
			return settings.blockers.map((b) => ({ message: `${b.label}: ${b.message}`, href: blockerHref(b.id, tab) }));
		},
		revert: () => settings.revert()
	};
	const pageDrafts: PageDraft[] = [detailsDraft, settingsDraft];
	// Shared with the Overview checklist, the Time series tab and the Runs tab.
	let series = $state<SeriesMeta[] | null>(null);
	// What the settings panels read from the series list, on Model settings and Calibration alike.
	const seriesKinds = $derived(series?.filter((x) => !x.siteNodeId).map((x) => x.kind) ?? null);
	// A daily A-pan series: runs use it before the monthly means, which the Crops demand preview shows (issue #173).
	const apanDaily = $derived(series?.some((x) => x.kind === 'evap_apan_mm' && !x.siteNodeId) ?? false);
	let runs = $state<RunMeta[] | null>(null);
	let saveBarHeight = $state(0);
	// In-page jumps and focus scrolling keep clear of the save bar while it shows (WCAG 2.4.11).
	$effect(() => {
		const root = document.documentElement;
		root.style.scrollPaddingBottom = saveBarHeight ? `${saveBarHeight + 12}px` : '';
		return () => {
			root.style.scrollPaddingBottom = '';
		};
	});
	/** The save bar's optional "Reason for this change", kept with the change in the History tab. */
	let saveReason = $state('');

	// --- data freshness, "Add data" (button or drop a CSV on its tabs) ---------
	// The project's calendar date (its time zone), as on the project list and the portfolio (issue #137).
	const today = $derived(projectToday(project?.timeZone));
	const fresh = $derived(freshness(series ?? [], today));

	// The "Data up to" dropdown closes on Escape (focus back on its summary)
	// and on a click outside it, like the other popups.
	let freshEl: HTMLDetailsElement | undefined = $state();
	let freshOpen = $state(false);
	function freshKeydown(e: KeyboardEvent) {
		// Read the element: the toggle event that updates freshOpen is async.
		if (e.key !== 'Escape' || !freshEl?.open) return;
		e.preventDefault();
		freshEl.open = false;
		freshEl.querySelector('summary')?.focus();
	}
	$effect(() => {
		if (!freshOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (freshEl && !freshEl.contains(e.target as Node)) freshOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
	const behindRun = $derived(newDataSinceRun(series ?? [], runs?.[0] ?? null));
	// Automatic runs (WP-2.11): with a re-run queued, the banners say when instead of offering the button.
	// A unit's efficiency is its plantings' systems blended at the saved A-pan (engine ≥ 1.72.0): the editor's return-flow check needs it.
	$effect(() => {
		editor.apanMm = project?.settings?.apanMm ?? [];
	});
	const rerunQueued = $derived(resolveAutoRun(project?.settings).enabled && !!project?.rerunQueuedFor);
	const queuedSentence = $derived.by(() => {
		const t = rerunQueuedText(project?.rerunQueuedFor);
		return `${t[0]!.toUpperCase()}${t.slice(1)}.`;
	});
	// The save bar's Preview of the unsaved model and settings edits (issue #284): fetched the first time
	// it's wanted, then kept, with its worker. Edits with problems are left out, and the dialog says so.
	let previewOpen = $state(false);
	let previewMounted = $state(false);
	const previewModel = $derived(editor.dirty && editor.issues.length === 0);
	const previewSettings = $derived(settings.dirty && settings.blockers.length === 0);
	const previewWhat = $derived(listAnd([...(previewSettings ? ['settings'] : []), ...(previewModel ? ['model edits'] : [])]) || 'edits');
	const previewLeft = $derived([
		...(editor.dirty && !previewModel ? ['your unsaved model edits, which have problems to fix first'] : []),
		...(settings.dirty && !previewSettings ? ['your unsaved settings, which have problems to fix first'] : [])
	]);
	function previewEdits(): UnsavedEdits {
		return {
			...(previewSettings ? { settings: { saved: settings.saved, draft: settings.snapshot() } as unknown as NonNullable<UnsavedEdits['settings']> } : {}),
			...(previewModel ? { model: { saved: editor.savedModel(), draft: editor.snapshot() } } : {})
		};
	}
	function openPreview() {
		previewMounted = true;
		previewOpen = true;
	}
	let addOpen = $state(false);
	// The dialog's chunk is fetched the first time it's wanted; then it stays mounted.
	let addMounted = $state(false);
	let droppedFile = $state.raw<File | null>(null);
	let dragDepth = $state(0);
	let banner = $state<{ text: string; added: number } | null>(null);
	let rerunning = $state(false);
	let rerunError = $state<string | null>(null);


	function openAddData(file: File | null = null) {
		droppedFile = file;
		addMounted = true;
		addOpen = true;
	}
	// `?field=<id>` (the Warnings page's fixes, issue #611): land on that one field once its tab draws it, then drop
	// the parameter (a replace, so Back and a reload don't land again). A new field or leaving the project stops it.
	let stopField = () => {};
	$effect(() => {
		const f = page.url.searchParams.get('field');
		if (!f || !project) return;
		untrack(() => {
			stopField();
			stopField = landOnField(f);
			void goto(withoutParam(page.url, 'field'), { replace: true, reset: false });
		});
	});
	$effect(() => () => stopField());

	// `?add=data` (the project list's Add data link, the Warnings page's fixes): the dialog opens once the
	// role is known, for an editor, and the param goes so Back or a reload doesn't reopen it. On a tab
	// without Add data (issue #601) it opens over Data instead, so closing it leaves you where the button is.
	$effect(() => {
		if (page.url.searchParams.get('add') !== 'data' || !project) return;
		untrack(() => {
			if (canEdit) openAddData();
			const to = new URL(withoutParam(page.url, 'add'), page.url.href);
			if (canEdit && !addsData(tab)) to.searchParams.set('tab', 'series');
			void goto(`${to.pathname}${to.search}${to.hash}`, { replace: true, reset: false });
		});
	});
	const carriesFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	// A file dropped on a tab without Add data (issue #601), or by a viewer, is refused: never opened in place of the page.
	const hasFiles = (e: DragEvent) => showsAddData && carriesFiles(e);
	function onDragEnter(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (dragDepth === 0) prefetch(loadAddData);
		dragDepth++;
	}
	function onDragOver(e: DragEvent) {
		// A viewer's file, or one on a tab without Add data, is refused here too, so the browser doesn't open it in place of the page.
		if (!showsAddData && carriesFiles(e)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
			return;
		}
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}
	function onDragLeave(e: DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}
	function onDrop(e: DragEvent) {
		if (!canEdit && carriesFiles(e)) {
			e.preventDefault();
			banner = { text: 'View only: ask an editor to add data.', added: 0 };
			return;
		}
		if (!showsAddData && carriesFiles(e)) {
			e.preventDefault();
			banner = { text: REFUSED_DROP_TEXT, added: 0 };
			return;
		}
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		const f = e.dataTransfer?.files?.[0];
		if (f) openAddData(f);
	}

	async function onUploaded(r: UploadResult) {
		// The merge or replace says when the automatic re-run it queued is due (absent from an older API).
		if (project && r.meta.rerunQueuedFor !== undefined) project = { ...project, rerunQueuedFor: r.meta.rerunQueuedFor };
		await loadLists();
		// On the Data tab the upload is charted, as picking its row would (`series=`).
		if (tab === 'series') void goto(withParam(page.url, 'series', r.meta.id), { replace: true, reset: false });
		const what = r.meta.name || kindLabel(r.meta.kind);
		banner = {
			text: r.added || r.changed ? `${r.message.replace(/\.$/, '')}.` : `No new days for “${what}”: the file matched what is stored.`,
			added: r.added + r.changed
		};
	}

	// The new-data line's Re-run model starts a run here and opens it in Runs (on Calibration, on the page: startRun).
	/** The new-data re-run, labelled with the data's end. */
	const rerun = () => runModel(`Data to ${fresh?.latest ?? today}`);
	async function startRun(label?: string, forecast = false) {
		rerunning = true;
		rerunError = null;
		// Started on Calibration, the run opens there, on How the shown run fits, so the calibration loop (fit, run,
		// read the fit) stays on one page (issue #586 round 3); from anywhere else, in Runs & results.
		const here = runOpensHere;
		// Started on Warnings (its Run now, issue #611), the run opens back there, on the new run's warnings.
		const onWarnings = tab === 'warnings';
		try {
			const { run: r, removedRunIds } = await api.runs.create(projectId, label, { forecast });
			const { summary: _s, ...meta } = r;
			setRuns([meta, ...(runs ?? []).filter((x) => x.id !== r.id && !removedRunIds.includes(x.id))]);
			banner = null;
			await goto(here ? `?tab=calibration&run=${r.id}#cal-fit` : onWarnings ? `?tab=warnings&run=${r.id}#warn-run` : `?tab=runs&run=${r.id}`, { reset: false });
			if (onWarnings) landOnAnchor('warn-run');
			// A goto the page makes itself lands nowhere (nav/anchorLandingEnv.svelte.ts), so land on the part, focused.
			if (here && tab === 'calibration') landOnAnchor('cal-fit');
		} catch (e) {
			rerunError = e instanceof Error ? e.message : String(e);
		} finally {
			rerunning = false;
		}
	}

	const canEdit = $derived(hasRole(project?.role, 'editor'));
	// Add data (the header's button and a dropped file) only on the tabs it adds data to (TAB_ADDS_DATA, issue #601).
	const showsAddData = $derived(canEdit && addsData(tab));
	/** A run started on this tab opens on it (startRun): Calibration shows the new run's fit itself. */
	const runOpensHere = $derived(tab === 'calibration');
	const isOwner = $derived(hasRole(project?.role, 'owner'));

	// --- the section header (SectionHeader, issue #17) -------------------------
	// For an editor every section ends on Run model (after Add data, on the tabs that have it, TAB_ADDS_DATA): the header's RunButton, which
	// opens a small form so the run can be named, or on Runs & results the tab's own run form
	// (headerSlot.main: Run label, Run forecast, Run model), never both.
	// The Data badge in the sections: series a run is driven by that are behind today (freshness.ts).
	const behindCount = $derived(fresh?.behind.length ?? 0);
	// The Warnings row's count (issue #611): the page's Open chip with no filter, by the same helpers, so the two
	// never disagree. The data checks' open periods (warnings/items.ts openCount) and the open run warnings (not kept,
	// not fixed since) of the run the page shows by default, and the failing or stale feeds, are read when the page is
	// idle, from the Data tab's cached values (read once if not cached yet); the
	// model's and the unsaved settings' problems, the series behind and the runs an erratum may affect are the
	// page's own (warnings/problems.ts), less those kept. Null, no badge, until the checks are counted or a read failed.
	let warningsOpen = $state<number | null>(null);
	let feedProblems = $state.raw<FeedProblem[]>([]);
	const otherProblems = $derived(
		problems({ issues: editor.issues, blockers: settings.blockers, feeds: feedProblems, behind: fresh?.behind, runs, role: project?.role })
	);
	const warningsBadge = $derived(badgeCount(warningsOpen, otherProblems, new Set((project?.settings?.warningsKept ?? []).map((k) => k.id))));
	$effect(() => {
		const p = project;
		const list = series;
		const r = runs;
		if (!p || !list || !r || !['owner', 'editor', 'viewer'].includes(p.role ?? '')) {
			warningsOpen = null;
			return;
		}
		const id = projectId;
		const runId = defaultRunId(r, p.role);
		const nodeName = (n: string) => untrack(() => editor.model.nodes.find((x) => x.id === n)?.name ?? null);
		let gone = false;
		const go = () =>
			loadWarningCount().then((m) => {
				m.openWarningCount(id, list, p.settings, runId, nodeName).then(
					(n) => {
						if (!gone) warningsOpen = n;
					},
					() => {}
				);
				m.loadFeedProblems(id).then(
					(f) => {
						if (!gone) feedProblems = f;
					},
					() => {}
				);
			});
		const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(go, { timeout: 4000 }) : null;
		const timer = idle === null ? setTimeout(go, 1500) : null;
		return () => {
			gone = true;
			if (idle !== null) cancelIdleCallback(idle);
			if (timer !== null) clearTimeout(timer);
		};
	});
	const contextText = $derived(
		sectionContext(tab, { runs, seriesCount: series?.length ?? null, behind: behindCount, transfers: editor.model.transfers })
	);

	async function load() {
		loading = true;
		error = null;
		notFound = false;
		applicantProject = null;
		// Another project's fit doesn't carry over (its worker stops now, before the load); a reload of this one keeps it.
		if (fit.projectId !== projectId) fit.reset(projectId);
		try {
			// Everything a tab's first render needs, behind one loading gate, so no
			// tab (or the Overview checklist) flashes an empty state. On a full page
			// load the root layout already started them beside /auth/me (firstLoad.ts).
			const [p, m, sl, rl] = await (takeProjectPage(projectId) ?? fetchProjectPage(projectId));
			project = p;
			editor.load(m);
			details.load(p);
			settings.load(p.settings);
			// Fit automatically's Search choices start from the last fit's (issue #554), once per project.
			fit.searchFrom(p.settings.fitRecord);
			series = sl;
			setRuns(rl);
		} catch (e) {
			// A farmer gets 403 from the workspace's routes: their view of this
			// project is the farm page (WP-2.6). An applicant's is the Applicant
			// view (WP-3.3).
			if (e instanceof ApiError && e.status === 403) {
				const here = await summaryHere();
				if (here?.role === 'farmer') {
					await goto(resolve(`farm/${encodeURIComponent(projectId)}`), { replace: true });
					return;
				}
				if (here?.role === 'contributor') {
					applicantProject = here;
					return;
				}
			}
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	/** This project as the project list shows it to the caller (their role), or null. */
	async function summaryHere(): Promise<ProjectSummary | null> {
		try {
			return (await api.projects.list()).find((p) => p.id === projectId) ?? null;
		} catch {
			return null;
		}
	}
	/** Refresh the shared lists in place (keeps the current values on failure). */
	async function loadLists() {
		await Promise.all([
			api.series.list(projectId).then(
				(l) => (series = l),
				() => {}
			),
			loadRuns()
		]);
	}
	async function loadRuns() {
		for (;;) {
			const at = runsEdits;
			const list = await api.runs.list(projectId).catch(() => null);
			if (!list) return;
			// A run made or removed meanwhile (here or in a tab): this list predates it, so ask again rather than drop the run.
			if (runsEdits !== at) continue;
			runs = list;
			return;
		}
	}
	/**
	 * Bumped by every change to the runs list (setRuns: the first load, a run made here, and every change a tab
	 * reports), so a list fetched before it is asked for again (loadRuns) rather than bring back a run just
	 * deleted (issue #77) or drop one just made.
	 */
	let runsEdits = 0;
	function setRuns(next: RunMeta[] | null) {
		runs = next;
		runsEdits++;
	}

	// Reload when the route param changes (e.g. navigating between projects).
	$effect(() => {
		void projectId;
		untrack(load);
	});

	async function saveModel() {
		if (editor.issues.length || editor.saving) return;
		editor.saving = true;
		editor.saveError = null;
		try {
			editor.load(await api.model.save(projectId, editor.snapshot(), saveReason.trim() || undefined));
			saveReason = '';
			fieldHistory?.refresh();
		} catch (e) {
			editor.saveError = e instanceof Error ? e.message : String(e);
		} finally {
			editor.saving = false;
		}
	}

	/** The project details (the Project page's form), through the same bar as the model; true once saved. */
	async function saveDetails(): Promise<boolean> {
		if (details.problems.length || details.saving) return false;
		details.saving = true;
		details.saveError = null;
		try {
			const sent = details.typed();
			const p = await api.projects.update(projectId, details.patch());
			project = p;
			// Not a load: a field edited while the save was in flight stays unsaved.
			details.afterSave(sent, p);
			settings.rebase(p.settings);
			fieldHistory?.refresh();
			return true;
		} catch (e) {
			details.saveError = e instanceof Error ? e.message : String(e);
			return false;
		} finally {
			details.saving = false;
		}
	}
	/**
	 * The settings (Model settings' and Calibration's panels, one draft), through the same bar, with the bar's reason (which the
	 * model's save then takes too, and clears); true once saved.
	 */
	async function saveSettings(): Promise<boolean> {
		if (settings.blockers.length || settings.saving) return false;
		settings.saving = true;
		settings.saveError = null;
		try {
			const why = saveReason.trim();
			const sent = settings.snapshot();
			const p = await api.projects.update(projectId, { settings: sent, ...(why ? { reason: why } : {}) });
			project = p;
			details.rebase(p);
			// Not a load: edits typed while the save was in flight stay unsaved (settingsDraft afterSave).
			settings.afterSave(sent, p.settings);
			fieldHistory?.refresh();
			return true;
		} catch (e) {
			settings.saveError = e instanceof Error ? e.message : String(e);
			return false;
		} finally {
			settings.saving = false;
		}
	}
	/** The save bar's Save changes: the project details, the settings, then the model, whichever are unsaved; true once all are saved. */
	async function saveAll(): Promise<boolean> {
		if (details.dirty && !(await saveDetails())) return false;
		if (settings.dirty && !(await saveSettings())) return false;
		if (editor.dirty) await saveModel();
		else saveReason = '';
		return !editor.dirty && !editor.saveError;
	}

	// --- Re-run model with unsaved edits (a run uses the saved model) -------------
	const unsavedWhat = $derived(
		listAnd([
			...(editor.dirty ? ['model edits'] : []),
			...(details.dirty ? ['project details'] : []),
			...(settings.dirty ? ['settings'] : []),
			...(invalidFields.count ? ['fields that need fixing'] : [])
		])
	);
	const unsaved = $derived(editor.dirty || details.dirty || settings.dirty || invalidFields.count > 0);
	/** What blocks saving the unsaved edits, each with where it is fixed. */
	const saveProblems = $derived([
		...(editor.dirty ? editor.issues.map((i) => ({ message: i.message, href: issueHref(i) })) : []),
		...pageDrafts.filter((d) => d.dirty).flatMap((d) => d.problems),
		...invalidFields.fields.map((f) => ({ message: f.label ? `${f.label}: ${f.message}` : f.message, href: `#${f.id}` }))
	]);
	/**
	 * Before any run (Runs & results' Run model and Run forecast, the new-data line's Re-run model).
	 * A run uses the saved model, so with unsaved edits it asks to save them first and goes on once
	 * they are saved; while problems block that save it says so and offers the first problem instead
	 * of running the saved model behind the person's back. True when the run may start.
	 */
	async function saveBeforeRun(): Promise<boolean> {
		if (unsaved) {
			const n = saveProblems.length;
			if (n) {
				const show = await confirmDialog({
					title: 'Fix the problems before running',
					message: `A run uses the saved model, and your unsaved ${unsavedWhat} can’t be saved yet: ${n === 1 ? 'one problem needs' : `${n} problems need`} fixing first (${saveProblems[0]!.message}${n > 1 ? ' …' : ''}).`,
					confirmLabel: 'Show the problem',
					cancelLabel: 'Close'
				});
				const href = saveProblems[0]!.href;
				// A number field on this page: focus it; anything else is another page or sheet.
				if (show && href.startsWith('#')) document.getElementById(href.slice(1))?.focus();
				else if (show) await goto(href, { reset: false });
				return false;
			}
			const ok = await confirmDialog({
				title: 'Save your changes and run?',
				message: `A run uses the saved model. Your unsaved ${unsavedWhat} aren’t in it yet: save them, then run.`,
				confirmLabel: 'Save and run'
			});
			if (!ok || !(await saveAll())) return false;
		}
		return true;
	}
	async function runModel(label?: string, forecast = false) {
		if (rerunning) return;
		if (await saveBeforeRun()) await startRun(label, forecast);
	}
	// What the header's Run model needs before a run can start (runs/runReady.ts, as Runs & results' form).
	const runReady = $derived(runBlockers(editor.model, series));

	// --- the farm drawer: open while the URL names a farm ---------------------
	// Closing it (Done, Esc, the ✕) drops `farm` from the URL in place, so Back
	// goes to where the drawer was opened from rather than reopening it.
	// Never over the Scenarios tab, even when the URL names one: the drawer
	// and the grid modal edit and save the catchment's model, and override
	// mode there (scenarios/OverrideEditor.svelte) edits the scenario's.
	const modelOverlays = $derived(tab !== 'scenarios');
	const drawerFarm = $derived(modelOverlays ? page.url.searchParams.get('farm') : null);
	let drawerOpen = $state(false);
	$effect(() => {
		drawerOpen = !!drawerFarm;
	});
	$effect(() => {
		if (!drawerOpen && untrack(() => drawerFarm)) goto(withoutFarm(page.url), { replace: true, reset: false });
	});

	// --- the grid modal: open while the URL names a grid, closed the same way --
	// A tab's own grid (TAB_GRIDS: the Map's `grid=map-features`) is the tab's to open and close.
	// Not over the grid's own tab, where the grid is already on the page.
	const gridParam = $derived(modelOverlays ? page.url.searchParams.get('grid') : null);
	const openGrid = $derived(isGridId(gridParam) && GRID_TAB[gridParam] !== tab ? gridParam : null);
	let gridOpen = $state(false);
	$effect(() => {
		gridOpen = !!openGrid;
	});
	$effect(() => {
		if (!gridOpen && untrack(() => gridParam) && !isTabGridId(untrack(() => gridParam)) && !untrack(() => movedGridHref(page.url))) goto(withoutParam(page.url, 'grid'), { replace: true, reset: false });
	});
	// A grid that left the modal: its old link goes where the grid is now (grid=demand → Crops & demand's table, issue #174).
	$effect(() => {
		const moved = movedGridHref(page.url);
		if (moved) void goto(moved, { replace: true, reset: false });
	});

	// Selecting a tab keeps the scroll and adds a history entry so Back works. The tabs that show
	// a run keep the one the reader picked on any of them (issue #586, workspace/tabLinks.ts).
	let pickedRun = $state<{ projectId: string; id: string } | null>(null);
	// Read once each time the run in the URL changes (not on a #hash or another param), against the runs as
	// they are then: the default a tab writes in place on opening is no pick (tabLinks.ts pickOf).
	let seenRun: string | null = null;
	const runsLoaded = $derived(runs !== null);
	$effect(() => {
		const id = isRunTab(tab) ? page.url.searchParams.get('run') : null;
		if (!id || !runsLoaded || id === seenRun) return;
		seenRun = id;
		untrack(() => {
			const pick = pickOf(id, runs ?? [], project?.role);
			pickedRun = pick ? { projectId, id: pick } : null;
		});
	});
	const carried = $derived(carriedRun(pickedRun?.projectId === projectId ? pickedRun.id : null, runs, project?.role));
	function tabHref(id: TabId) {
		return tabLinkHref(id, page.url.pathname, carried);
	}

	// --- the assistant (issue #610, docs/ui.md § Assistant) ---------------------
	// One conversation per project, held here so closing the sheet or changing tab keeps it (nothing is
	// stored on the server). Its button shows only when the server has the assistant on for this caller
	// (GET …/assistant answers `available`); a farmer or an applicant never reaches the workspace.
	let assistant = $state.raw<{ id: string; chat: AssistantChat } | null>(null);
	let assistantOpen = $state(false);
	let assistantMounted = $state(false);
	const assistantReady = $derived(!!project && !applicantProject);
	$effect(() => {
		const id = projectId;
		if (!assistantReady) {
			assistant = null;
			return;
		}
		const chat = new AssistantChat({ status: () => api.assistant.status(id), send: (body, signal) => api.assistant.send(id, body, signal) });
		assistant = { id, chat };
		assistantOpen = false;
		void chat.load();
		// Leaving the project stops an answer still streaming.
		return () => chat.stop();
	});
	const assistantOn = $derived(assistant?.chat.available ?? false);
	// The run the conversation is about: the one a run tab shows, else the one carried between tabs, else the default.
	const assistantRun = $derived(
		(isRunTab(tab) ? page.url.searchParams.get('run') : null) ?? carried ?? (runs ? defaultRunId(runs, project?.role) : null)
	);
	function openAssistant() {
		assistantMounted = true;
		assistantOpen = true;
	}
	/** The save reason Apply filled in, cleared again if the change is discarded rather than saved. */
	let appliedReason = '';
	/**
	 * Apply on a recommended change: it goes into the settings form, unsaved, as any edit there would, and Model
	 * settings opens with the save bar's reason filled in. The person checks it and saves with the normal Save
	 * (the server validates it as any save), or discards it; the assistant saves nothing.
	 */
	async function applyProposal(p: SettingsProposal) {
		settings.applyPatch(p.patch);
		appliedReason = `Assistant suggestion: ${p.summary}`;
		saveReason = appliedReason;
		assistantOpen = false;
		if (tab !== 'settings') await goto('?tab=settings', { reset: false });
	}
	$effect(() => {
		if (!unsaved && appliedReason && saveReason === appliedReason) {
			saveReason = '';
			appliedReason = '';
		}
	});

	// Following a sidebar link puts the focus on the new page's title (its h1, focusPageStart), so Tab
	// carries on in the page, not from the top of the sidebar (issue #586; ui-playbook.md § 4). The arrow
	// keys between the links keep it on the link instead (tabKeydown).
	// The flag names the URL the link goes to: only the navigation to it focuses the title, and any
	// navigation clears it. A click on the page already shown navigates nowhere, so it sets none (else a
	// later Back or in-page link would take the focus to the title).
	let focusTitleFor: string | null = null;
	function followTab(e: MouseEvent & { currentTarget: HTMLAnchorElement }) {
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const to = e.currentTarget.href;
		focusTitleFor = to === location.href ? null : to;
	}
	afterNavigate((nav) => {
		const wanted = focusTitleFor;
		focusTitleFor = null;
		if (wanted && nav.to?.url.href === wanted) void focusPageStart();
	});

	function onProjectChange(p: Project) {
		project = p;
		details.rebase(p);
		settings.rebase(p.settings);
		fieldHistory?.refresh();
	}

	/** A restore (History tab, or a run's "Restore these inputs") changed the saved settings and model. */
	async function reloadInputs() {
		const [p, m] = await Promise.all([api.projects.get(projectId), api.model.get(projectId)]);
		project = p;
		details.rebase(p);
		settings.rebase(p.settings);
		editor.load(m);
		fieldHistory?.refresh();
	}

	async function onLeftProject() {
		await goto(resolve(''));
	}

	// Start the open tab's chunk alongside the project fetch; warm the others
	// when their tab link is hovered or focused.
	function warmTab(id: TabId) {
		if (id !== 'overview') prefetch(LOAD[id]);
	}
	$effect(() => warmTab(tab));

	// Wide screens: the sections go in the app sidebar (AppShell, issue #17's shell).
	const wide = new MediaQuery('min-width: 900px');
	$effect(() => fillSidebar(projectSidebar, wide.current && !!project && !applicantProject));
	// On a phone the catchment's name and your role go in the app's bar (AppShell), not a line of their own here.
	$effect(() => fillPhoneTitle(phoneProject, !wide.current && !!project && !applicantProject));

	// Phones (< 900 px): the sections sit behind a "Sections" button, closed
	// again by choosing a tab or Escape.
	let navOpen = $state(false);
	let navToggle: HTMLButtonElement | undefined = $state();
	$effect(() => {
		void tab;
		navOpen = false;
	});
	function navKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !navOpen) return;
		e.preventDefault();
		navOpen = false;
		navToggle?.focus();
	}
	const modelIssues = $derived(editor.issues.some((x) => (MODEL_TABS as readonly string[]).includes(x.area)));

	// Keep the active tab in view in the scrolling strip (narrow screens).
	let tabStrip: HTMLElement | undefined = $state();
	$effect(() => {
		void tab;
		tabStrip?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	// Arrows move through the tabs as shown: down/right to the next (across
	// sections), up/left to the previous, wrapping at the ends.
	function tabKeydown(e: KeyboardEvent, id: TabId) {
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
		if (!step) return;
		e.preventDefault();
		const next = strip[(strip.indexOf(id) + step + strip.length) % strip.length]!;
		goto(tabHref(next), { reset: false }).then(() => document.getElementById(`tab-${next}`)?.focus());
	}
</script>

{#snippet sectionsNav()}
	<nav class="tabs" aria-label="Project sections" bind:this={tabStrip}>
		{#each sections as sec (sec.id)}
			<div class="section" role="group" aria-labelledby="nav-{sec.id}">
				<span class="section-label" id="nav-{sec.id}">{sec.label}</span>
				{#each sec.tabs as id (id)}
					<a
						id="tab-{id}"
						href={tabHref(id)}
						data-sveltekit-noscroll
						aria-current={tab === id ? 'page' : undefined}
						onkeydown={(e) => tabKeydown(e, id)}
						onclick={followTab}
						onpointerenter={() => warmTab(id)}
						onfocus={() => warmTab(id)}
					>
						{LABEL[id]}
						{#if id === 'series' && behindCount}
							<span class="count-badge" title="{behindCount} series behind (older than {STALE_DAYS} days)"
								><span aria-hidden="true">{behindCount}</span><span class="visually-hidden">({behindCount} series behind)</span></span
							>
						{/if}
						{#if id === 'warnings' && warningsBadge}
							<!-- Every open item the Warnings page lists (issue #611), with a triangle so it never reads as Data's "behind" count. -->
							<span class="count-badge warn-badge" title="{warningsBadge} open {warningsBadge === 1 ? 'item' : 'items'}: flagged periods, problems elsewhere and run warnings, as the page’s Open chip counts them"
								><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M6 1.2 11 10.5H1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg><span aria-hidden="true"
									>{warningsBadge}</span
								><span class="visually-hidden">({warningsBadge} open)</span></span
							>
						{/if}
						{#if MODEL_TABS.includes(id) && editor.issues.some((x) => x.area === id)}
							<span class="issue-dot" title="Has problems to fix"><span class="visually-hidden">(has problems)</span></span>
						{/if}
					</a>
				{/each}
			</div>
		{/each}
	</nav>
	{#if hasModelInputsToggle(project?.role)}
		<label class="inputs-toggle">
			<input type="checkbox" bind:checked={showModelInputs} />
			Show model inputs
		</label>
	{/if}
{/snippet}
<!-- Wide screens: the sections are in the app sidebar (AppShell), under the
     catchment's name. Phones: behind a "Sections" button here. One copy only. -->
{#snippet projectSidebar()}
	<div class="project-side">
		<div class="side-head"><span class="side-kicker">Catchment</span>{@render roleBadge()}<SectionsMenu roleTabs={roleIds} /></div>
		<a class="side-project" href={tabHref('overview')} onclick={followTab} title={project?.name} data-testid="project-name">{project?.name}</a>
		{@render sectionsNav()}
	</div>
{/snippet}

<!-- The phone bar's title (AppShell): the name in at most two lines (whole in its title), then your role. -->
{#snippet phoneProject()}
	<p class="phone-project"><span class="phone-name" data-testid="project-name" title={project?.name}>{project?.name}</span>{@render roleBadge()}</p>
{/snippet}

{#snippet roleBadge()}
	<span class="badge" class:badge-owner={isOwner} data-testid="project-role">{project?.role}</span>
{/snippet}

<!-- The section header's parts (SectionHeader): the page's own around the tab's (headerSlot). -->
{#snippet unsavedBadge()}
	{#if unsaved && canEdit}<span class="badge badge-warn">Unsaved changes</span>{/if}
{/snippet}
{#snippet pageContext()}{contextText}{/snippet}
{#snippet headerStatus()}
	<!-- The tab's own status first (the Summary's "Setup complete" pill), then the rain pill. -->
	{@render headerSlot.status?.()}
	{#if fresh}
		<!-- Escape closes it (freshKeydown), as the other disclosures. -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<details class="fresh" class:stale={fresh.stale} bind:this={freshEl} bind:open={freshOpen} onkeydown={freshKeydown}>
			<summary>
				<span class="dot" aria-hidden="true"></span>
				<!-- One box for the words, so on a phone they wrap as a line of text inside the pill (SectionHeader). -->
				<span class="fresh-text">
					{#if fresh.latest !== null && fresh.age !== null}
						Rain up to <strong class="nw">{fmtDay(fresh.latest)}</strong> <span class="nw">({agoText(fresh.age)})</span>{#if fresh.stale}<span class="visually-hidden">{`, older than ${STALE_DAYS} days`}</span>{/if}
					{:else}
						No recorded rain yet
					{/if}
				</span>
			</summary>
			<div class="fresh-pop">
				<table class="data compact">
					<thead><tr><th scope="col">Series</th><th scope="col" class="num">Up to</th><th scope="col" class="num">Age</th></tr></thead>
					<tbody>
						{#each fresh.perSeries as p (p.id)}
							<tr><th scope="row">{kindLabel(p.kind)}{p.name ? ` · ${p.name}` : ''}</th><td class="num">{fmtDay(p.end)}</td><td class="num">{agoText(p.age)}</td></tr>
						{/each}
					</tbody>
				</table>
				<p class="muted">
					Flagged when the newest recorded rain (catchment or CHIRPS) is more than {STALE_DAYS} days old. A forecast
					and flow series don't count: runs are driven by the recorded rain.
				</p>
			</div>
		</details>
	{:else if series}
		<span class="fresh-none muted">No data yet</span>
	{/if}
{/snippet}
<!-- The Assistant (issue #610), on the title's line after How this page works: the same place on every section,
     for anyone the server lets use it here (docs/ui.md § Assistant). A sparkle in a chat bubble, then its name. -->
{#snippet assistButton()}
	<button
		type="button"
		class="btn btn-sm assist-btn"
		aria-haspopup="dialog"
		aria-expanded={assistantOpen}
		data-testid="assistant-open"
		onclick={openAssistant}
		onpointerenter={() => prefetch(loadAssistant)}
		onfocus={() => prefetch(loadAssistant)}
	>
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
			><path d="M2.5 2.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H8.2l-3.4 2.6v-2.6H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /><path
				d="M8 4.2l.75 1.85L10.6 6.8l-1.85.75L8 9.4l-.75-1.85L5.4 6.8l1.85-.75z"
				fill="currentColor"
			/></svg
		><span class="assist-text">Assistant</span>
	</button>
{/snippet}
<!-- Add data (on the tabs it adds data to, TAB_ADDS_DATA), then Run model (the tab's main action on Runs & results,
     its run form): what every section ends on. -->
{#snippet headerMain()}
	{#if showsAddData}
		<button
			type="button"
			class="btn add"
			onclick={() => openAddData()}
			onpointerenter={() => prefetch(loadAddData)}
			onfocus={() => prefetch(loadAddData)}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 11V2M4.5 5.5 8 2l3.5 3.5M2 11v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Add data
		</button>
	{/if}
	{#if headerSlot.main}
		{@render headerSlot.main()}
	{:else if canEdit && tab !== 'runs'}
		<!-- Not on Runs & results, even while its chunk loads: its run form is the one Run model there. -->
		<RunButton
			missing={runReady.missing}
			hasForecast={hasForecastRain(series)}
			modelDirty={unsaved}
			problems={unsaved ? saveProblems.length : 0}
			running={rerunning}
			error={rerunError}
			behind={!banner && behindRun.length > 0}
			opensHere={runOpensHere}
			onrun={runModel}
		/>
	{/if}
{/snippet}
<!-- The notices: one slim line under the header, not full-width banners. -->
{#snippet headerNotices()}
	{@const behind = !banner && behindRun.length > 0 && tab !== 'runs'}
	{#if !canEdit || banner || behind || rerunError}
		<div class="notice-line" data-testid="notice-line">
			{#if !canEdit}
				<span class="note readonly-note" role="note">
					<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" stroke-width="1.6" />
						<circle cx="10" cy="10" r="2.6" fill="currentColor" />
					</svg>
					<span>
						<strong>View only.</strong>
						<span class="ro-long">You have view-only access to this project. You can explore every input and
						result; ask the project owner for editor access to change anything or run the model.</span>
						<!-- A phone's one line (the role badge in the bar says it too); a screen reader reads the sentence above. -->
						<span class="ro-short" aria-hidden="true">Ask the owner to edit.</span>
					</span>
				</span>
			{/if}
			{#if banner}
				<span class="note note-done" role="status">
					<span class="note-text">{banner.text}</span>
					{#if banner.added > 0 && rerunQueued}
						<span data-testid="rerun-queued">{queuedSentence}</span>
					{:else if canEdit && banner.added > 0}
						<button type="button" class="btn btn-primary btn-sm" disabled={rerunning} onclick={rerun}>{rerunning ? 'Running model…' : 'Re-run model'}</button>
					{/if}
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => (banner = null)}>Dismiss</button>
				</span>
			{:else if behind}
				<span class="note note-info behind" role="status">
					<span class="note-text">New data since the last run ({behindRun.map((s) => s.name || kindLabel(s.kind)).join(', ')}).</span>
					{#if rerunQueued}<span data-testid="rerun-queued">{queuedSentence}</span>{:else if canEdit}<button type="button" class="btn btn-sm rerun" disabled={rerunning} onclick={rerun}>{rerunning ? 'Running model…' : 'Re-run model'}</button>{/if}
				</span>
			{/if}
			{#if rerunError}<span class="note err" role="alert">The run didn’t start: {rerunError}</span>{/if}
		</div>
	{/if}
{/snippet}
<svelte:head><title>{project ? `${project.name} · ` : ''}IC-WBT</title></svelte:head>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
	class="page"
	style:--dock-h="{saveBarHeight}px"
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<LoadState {loading} error={notFound ? null : error} retry={load}>
		{#if applicantProject}
			<Lazy load={loadApplicantView}>
				{#snippet children(ApplicantView)}<ApplicantView project={applicantProject!} />{/snippet}
			</Lazy>
		{:else if notFound || !project}
			<!-- The same frame as every section: one title, then what happened (issue #17). -->
			<SectionHeader title="Project not found" />
			<div class="alert alert-error" role="alert">
				This project doesn't exist or you don't have access to it. <a href={resolve('')}>Back to projects</a>
			</div>
		{:else}
			<div class="workspace">
			{#if !wide.current}
			<div class="tab-row">
				<button type="button" class="nav-toggle" aria-expanded={navOpen} aria-controls="project-nav" bind:this={navToggle} onclick={() => (navOpen = !navOpen)}>
					<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
					<span class="nav-toggle-label"><span class="visually-hidden">Project sections: </span>{LABEL[tab]}</span>
					{#if modelIssues}<span class="issue-dot" title="Has problems to fix"><span class="visually-hidden">(has problems)</span></span>{/if}
					<svg class="chev" class:up={navOpen} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</button>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="nav-panel" class:open={navOpen} id="project-nav" onkeydown={navKeydown}>
					{@render sectionsNav()}
					<div class="phone-sections-menu"><SectionsMenu roleTabs={roleIds} showLabel /></div>
				</div>
			</div>
			{/if}

			<div class="main-col">
			<SectionHeader
				title={LABEL[tab]}
				guide={resolve(`help/guides/${TAB_GUIDE[tab]}`)}
				badge={unsavedBadge}
				context={headerSlot.context ?? (contextText ? pageContext : null)}
				status={fresh || series || headerSlot.status ? headerStatus : null}
				assist={assistantOn ? assistButton : null}
				actions={headerSlot.actions}
				main={canEdit || headerSlot.main ? headerMain : null}
				notices={headerNotices}
			/>

			<section class="tab-body" class:readonly={!canEdit} aria-labelledby="tab-{tab}">
				{#if tab === 'overview'}
					<OverviewTab {project} {editor} {series} {runs} {canEdit} visibleTabs={roleIds} />
				{:else if tab === 'network'}
					<IssueList issues={editor.issues} area="network" links />
					<Lazy load={LOAD.network}>
						{#snippet children(NetworkTab)}<NetworkTab {editor} settings={project!.settings} readonly={!canEdit} {projectId} {runs} onsave={saveModel} bind:reason={saveReason} />{/snippet}
					</Lazy>
				{:else if tab === 'map'}
					<Lazy load={LOAD.map}>
						{#snippet children(MapTab)}<MapTab {projectId} {editor} {canEdit} {runs} role={project!.role} projectName={project!.name} onModelChanged={reloadInputs} />{/snippet}
					</Lazy>
				{:else if tab === 'crops'}
					<IssueList issues={editor.issues} area="crops" links />
					<Lazy load={LOAD.crops}>
						{#snippet children(CropsTab)}<CropsTab {editor} settings={project!.settings} readonly={!canEdit} onsave={saveModel} bind:reason={saveReason} {apanDaily} />{/snippet}
					</Lazy>
				{:else if tab === 'transfers'}
					<IssueList issues={editor.issues} area="transfers" links />
					<Lazy load={LOAD.transfers}>
						{#snippet children(TransfersTab)}<TransfersTab {editor} readonly={!canEdit} page />{/snippet}
					</Lazy>
				{:else if tab === 'settings'}
					<Lazy load={LOAD.settings}>
						{#snippet children(SettingsTab)}
							<SettingsTab
								project={project!}
								{editor}
								draft={settings}
								{seriesKinds}
								catchmentRain={series ? (firstOutletSeries(series, 'rain_catchment_mm') ?? null) : undefined}
								rainSeries={series?.filter((x) => x.kind === 'rain_catchment_mm' && !x.siteNodeId)}
								rainRecords={series ? rainRecordOptions(series, (id) => editor.model.nodes.find((n) => n.id === id)?.name) : null}
								readonly={!canEdit}
								onModelChanged={reloadInputs}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'calibration'}
					<Lazy load={LOAD.calibration}>
						{#snippet children(CalibrationTab)}
							<CalibrationTab
								{runs}
								role={project!.role}
								project={project!}
								{editor}
								draft={settings}
								{fit}
								{seriesKinds}
								gaugeRecords={series?.flatMap((x) => (x.siteNodeId ? [{ kind: x.kind, siteNodeId: x.siteNodeId }] : [])) ?? null}
								chirpsSource={chirpsSourceOf(series)}
								observedOrigins={observedOriginsOf(series)}
								apanSeries={series ? (firstOutletSeries(series, 'evap_apan_mm') ?? null) : undefined}
								et0Series={series ? (firstOutletSeries(series, 'evap_et0_mm') ?? null) : undefined}
								flowRecordId={series ? ((firstOutletSeries(series, 'flow_observed_m3s') ?? firstOutletSeries(series, 'flow_logger_m3s'))?.id ?? null) : null}
								readonly={!canEdit}
								{onProjectChange}
								{projectId}
								nodes={editor.model.nodes}
								{series}
								projectSettings={project!.settings}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'series'}
					<Lazy load={LOAD.series}>
						{#snippet children(SeriesTab)}
							<SeriesTab
								{projectId}
								readonly={!canEdit}
								initial={series}
								settings={project!.settings}
								timeZone={project!.timeZone}
								gauges={editor.model.nodes.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null)}
								nodes={editor.model.nodes}
								warningsOpen={warningsBadge}
								onSeriesChange={(l) => (series = l)}
								onadddata={() => openAddData()}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'warnings'}
					<Lazy load={LOAD.warnings}>
						{#snippet children(WarningsTab)}
							<WarningsTab {projectId} project={project!} {series} {runs} {canEdit} nodes={editor.model.nodes} issues={editor.issues} blockers={settings.blockers} behind={fresh?.behind ?? []} running={rerunning} onRun={() => void runModel('After fixing warnings')} {onProjectChange} />
						{/snippet}
					</Lazy>
				{:else if tab === 'runs'}
					<Lazy load={LOAD.runs}>
						{#snippet children(RunsTab)}
							<RunsTab
								{projectId}
								project={project!}
								{editor}
								{series}
								{runs}
								canRun={canEdit}
								modelDirty={editor.dirty}
								busy={rerunning}
								beforeRun={saveBeforeRun}
								onRunsChange={setRuns}
								onInputsRestored={reloadInputs}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'river'}
					<Lazy load={LOAD.river}>
						{#snippet children(RiverTab)}<RiverTab {projectId} project={project!} {editor} {runs} {canEdit} {onProjectChange} />{/snippet}
					</Lazy>
				{:else if tab === 'supply'}
					<Lazy load={LOAD.supply}>
						{#snippet children(SupplyTab)}<SupplyTab {projectId} {editor} {runs} readonly={!canEdit} showAllocations={roleIds.includes('allocations')} />{/snippet}
					</Lazy>
				{:else if tab === 'dams'}
					<Lazy load={LOAD.dams}>
						{#snippet children(DamsTab)}<DamsTab {projectId} {editor} {runs} readonly={!canEdit} onModelChanged={reloadInputs} />{/snippet}
					</Lazy>
				{:else if tab === 'compare'}
					<Lazy load={LOAD.compare}>
						{#snippet children(CompareView)}
							<CompareView
								a={page.url.searchParams.get('a')}
								b={page.url.searchParams.get('b')}
								c={page.url.searchParams.get('c')}
								project={projectId}
								hrefFor={(a, b, c) => `${page.url.pathname}${compareTabHref(a, b, c)}`}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'scenarios'}
					<Lazy load={LOAD.scenarios}>
						{#snippet children(ScenariosTab)}<ScenariosTab {projectId} {runs} {canEdit} actsForAuthority={project?.actsForAuthority ?? false} onRunsChange={setRuns} reloadRuns={loadRuns} />{/snippet}
					</Lazy>
				{:else if tab === 'allocations'}
					<Lazy load={LOAD.allocations}>
						{#snippet children(AllocationsTab)}<AllocationsTab {projectId} {runs} {canEdit} {isOwner} settings={project?.settings ?? null} {onProjectChange} />{/snippet}
					</Lazy>
				{:else if tab === 'project'}
					<Lazy load={LOAD.project}>
						{#snippet children(ProjectTab)}
							<ProjectTab
								project={project!}
								{editor}
								{details}
								{series}
								{runs}
								{canEdit}
								{isOwner}
								currentUserId={session.user?.id ?? ''}
								{onProjectChange}
								{onLeftProject}
							/>
						{/snippet}
					</Lazy>
				{:else if tab === 'applications'}
					<Lazy load={LOAD.applications}>
						{#snippet children(ApplicationsTab)}<ApplicationsTab {projectId} />{/snippet}
					</Lazy>
				{:else if tab === 'history'}
					<Lazy load={LOAD.history}>
						{#snippet children(HistoryTab)}<HistoryTab {projectId} {editor} {canEdit} onRestored={reloadInputs} onSeriesRestored={loadLists} />{/snippet}
					</Lazy>
				{/if}
			</section>
			</div>
			</div>

			{#if drawerFarm}
				<Lazy load={loadFarmDrawer}>
					{#snippet children(FarmCropsDrawer)}
						<FarmCropsDrawer
							bind:open={drawerOpen}
							{editor}
							settings={project!.settings}
							nodeId={drawerFarm}
							readonly={!canEdit}
							onsave={saveModel}
							bind:reason={saveReason}
							{projectId}
							onModelChanged={reloadInputs}
						/>
					{/snippet}
				</Lazy>
			{/if}
			{#if openGrid}
				<Lazy load={loadGridModal}>
					{#snippet children(GridModal)}
						<GridModal
							bind:open={gridOpen}
							grid={openGrid}
							{editor}
							settings={project!.settings}
							readonly={!canEdit}
							onsave={saveModel}
							bind:reason={saveReason}
							{projectId}
							{runs}
							{apanDaily}
						/>
					{/snippet}
				</Lazy>
			{/if}
			<SaveBar {editor} drafts={pageDrafts} onsave={saveAll} readonly={!canEdit} bind:height={saveBarHeight} bind:reason={saveReason} onpreview={openPreview} />
			{#if previewMounted}
				<Lazy load={loadUnsavedPreview}>
					{#snippet children(UnsavedPreviewDialog)}
						<UnsavedPreviewDialog bind:open={previewOpen} {projectId} {runs} what={previewWhat} edits={previewEdits} left={previewLeft} />
					{/snippet}
				</Lazy>
			{/if}
			{#if assistantMounted && assistant}
				<Lazy load={loadAssistant}>
					{#snippet children(AssistantPanel)}
						<AssistantPanel bind:open={assistantOpen} chat={assistant!.chat} runId={assistantRun} onapply={applyProposal} />
					{/snippet}
				</Lazy>
			{/if}
			{#if canEdit}
				{#if addMounted}
					<Lazy load={loadAddData}>
						{#snippet children(AddDataDialog)}
							<AddDataDialog bind:open={addOpen} {projectId} list={series ?? []} file={droppedFile} onuploaded={onUploaded} />
						{/snippet}
					</Lazy>
				{/if}
				{#if dragDepth > 0}
					<div class="drop" aria-hidden="true"><div>Drop the CSV to add daily data to {project.name}</div></div>
				{/if}
				<p class="visually-hidden" aria-live="polite">{dragDepth > 0 ? 'Drop the file to add data.' : ''}</p>
			{/if}
		{/if}
	</LoadState>
</main>

<style>
	/* The page's 1rem gutter, plus room for the fixed model save bar only while
	   it shows (--dock-h is 0 otherwise), so it never hides the last row or a
	   tab's own sticky actions (Settings). No more than that: a fixed 4rem made
	   every tab whose content came within 56 px of the window's foot scroll for
	   nothing, and the window-fitted tabs size themselves to exactly this gutter
	   (`calc(100vh - top - var(--dock-h) - 1rem)`). */
	.page {
		padding-bottom: calc(var(--dock-h, 0px) + 1rem);
	}
	.add,
	.fresh {
		position: relative;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.fresh summary {
		cursor: pointer;
		list-style: none;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		min-height: 38px;
	}
	.fresh summary::-webkit-details-marker {
		display: none;
	}
	.fresh .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--success);
	}
	.fresh.stale summary {
		border-color: color-mix(in srgb, var(--warning) 50%, var(--border));
		background: var(--warning-soft);
		color: var(--warning);
	}
	.fresh.stale .dot {
		background: var(--warning);
	}
	.fresh-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 35;
		width: min(440px, calc(100vw - 2 * var(--gutter)));
		padding: 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--popover-shadow);
	}
	/* In a narrow header the pills share a row that starts at the left (SectionHeader), the rain pill
	   after the Summary's Setup complete: its words wrap inside it, and its list opens rightwards from
	   the row's left edge (the row is positioned), so it stays on the screen whichever pill comes first. */
	@container section-header (max-width: 640px) {
		.fresh {
			position: static;
		}
		.fresh summary {
			display: flex;
			height: 100%;
			min-height: 44px;
		}
		.fresh .dot {
			flex: none;
		}
		/* The date and the age each stay whole: the words break between them, not inside "(4 years ago)". */
		.fresh-text .nw {
			white-space: nowrap;
		}
		.fresh-pop {
			left: 0;
			right: auto;
		}
	}
	.fresh-pop p {
		margin: 0.4rem 0 0;
		font-size: var(--font-sm);
	}
	.fresh-none {
		font-size: 0.85rem;
	}
	/* The header's notices (view only, new data, a run that didn't start):
	   one slim line of compact items, wrapping only when they must. */
	.notice-line {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		font-size: 0.85rem;
	}
	.note {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		padding: 0.2rem 0.4rem 0.2rem 0.6rem;
		border-left: 3px solid var(--accent);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text-2);
	}
	.note svg {
		flex: none;
		color: var(--accent);
	}
	/* The eye stays beside its text when the note wraps (phones). */
	.readonly-note {
		flex-wrap: nowrap;
		align-items: flex-start;
	}
	.readonly-note svg {
		margin-top: 0.15rem;
	}
	.note strong {
		color: var(--text);
	}
	.note-done {
		border-left-color: var(--success);
		background: var(--success-soft);
		color: var(--text);
	}
	.note-info {
		background: var(--accent-soft);
		color: var(--text);
	}
	.note .btn-sm {
		min-height: 30px;
	}
	.ro-short {
		display: none;
	}
	/* A phone (the header's container, SectionHeader): View only is one line, and the new-data line is words only,
	   since the header's own button says Re-run model (RunButton's behind). */
	@container section-header (max-width: 640px) {
		.ro-long {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		.ro-short {
			display: inline;
		}
		.behind .rerun {
			display: none;
		}
	}
	.err {
		border-left-color: var(--danger);
		color: var(--danger);
	}
	.drop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		background: color-mix(in srgb, var(--bg) 75%, transparent);
		pointer-events: none;
	}
	.drop div {
		padding: 2.5rem 3rem;
		border: 3px dashed var(--accent);
		border-radius: 12px;
		background: var(--surface);
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--accent);
		text-align: center;
	}
@media (max-width: 640px) {
		.fresh summary {
			min-height: 44px;
		}
		.note .btn-sm {
			min-height: 44px;
		}
	}
	/* The sections, one vertical list: in the app sidebar (wide) or in the
	   phone's Sections menu. Each section is labelled; the open one is marked.
	   In the sidebar the rows are tighter than in the phone menu, so every
	   section an owner sees fits a 960 px-high window (AppShell). */
	.project-side {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	/* "Catchment", the role and the Choose sections icon on one line, with a
	   wide system font too (DejaVu Sans, Linux's usual one, where the bold
	   "Catchment", "Viewer" and the icon take ~172 px of the line's 174): a
	   wrapped icon costs the sidebar a row and the sections no longer fit
	   1440×960 (app-sidebar.spec.ts). So the gaps are tight (0.4rem wrapped
	   the icon once "Catchment" took Help's bold heading style), and on the
	   right the icon's own 24 px box is the inset. */
	.side-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		padding: 0 0.25rem 0 0.75rem;
	}
	/* The group titles ("Catchment" and each section's label) read as Help's
	   side panel's group headings do (help/HelpNav.svelte .group): the text
	   colour, bold, uppercase, so each group reads as a block. */
	.side-kicker,
	.section-label {
		color: var(--text);
		font-size: var(--font-xs);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	/* A long name wraps to two lines at most; the full name is its tooltip,
	   and still its accessible name (the clamp is visual only). */
	.side-project {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		/* 0.3rem: the head line above is 24 px tall with the "Choose sections"
		   button (SectionsMenu), and the sidebar's rows are budgeted to fit
		   1440×960 (app-sidebar.spec.ts). */
		margin-bottom: 0.3rem;
		padding: 0 0.75rem;
		color: var(--text);
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	/* Budgeted to fit every section an owner can show (17 with the Map's row, #326 D3) and the account
	   block in 1440×960 with a row to spare: 32 px rows (still past the 24 px target size) and 0.5rem
	   between the groups (app-sidebar.spec.ts). */
	.project-side .tabs {
		gap: 0.5rem;
	}
	.project-side .section-label {
		padding-bottom: 0.1rem;
	}
	.project-side .tabs a {
		min-height: 32px;
	}
	/* A viewer's toggle takes one 32 px row in the sidebar, as a link does: Calibration took the sidebar's last
	   spare row (issue #586), and a viewer, who has no Applications row, has the toggle in its place, so with the
	   inputs shown they fit 1440×960 exactly as an owner's sections do (app-sidebar.spec.ts). Its taller 40 px
	   row and gap above had cost 16 px more. */
	.project-side .inputs-toggle {
		min-height: 32px;
		margin-top: 0;
		padding-top: 0;
	}
	/* Phones: the catchment's name and your role, in the app's bar (fillPhoneTitle): at most two lines of name
	   (whole in its title), the role badge beside it. */
	.phone-project {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-weight: 600;
		min-width: 0;
	}
	.phone-name {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		min-width: 0;
		overflow: hidden;
		overflow-wrap: anywhere;
		line-height: 1.2;
	}
	.phone-project .badge {
		flex: none;
	}
	.tabs {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.section {
		display: flex;
		flex-direction: column;
	}
	.section-label {
		padding: 0 0.75rem 0.25rem;
	}
	.tabs a {
		display: flex;
		align-items: center;
		min-height: 36px;
		padding: 0 0.75rem;
		border-radius: var(--radius);
		color: var(--text-2);
		font-weight: 500;
	}
	.tabs a:focus-visible {
		outline-offset: -2px;
	}
	.tabs a:hover {
		color: var(--text);
		text-decoration: none;
		background: var(--surface-2);
	}
	.tabs a[aria-current='page'] {
		color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	/* A viewer's "Show model inputs" (lib/workspace/tabs.ts), after the sections. */
	.inputs-toggle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 40px;
		margin-top: 0.5rem;
		padding: 0.25rem 0.75rem 0;
		border-top: 1px solid var(--border);
		color: var(--text-2);
		font-size: 0.875rem;
		cursor: pointer;
	}
	/* Phones: a full-width "Sections" button naming the open tab opens the list in the page. */
	.tab-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	/* Under the phone bar the Sections button starts close to it: the page's 1.25rem top was room the first
	   screen needs (issue #521 round 5: the header's foot within the first half of a 360 × 740 screen). */
	@media (max-width: 899px) {
		.page {
			padding-top: 0.75rem;
		}
	}
	.nav-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 44px;
		padding: 0 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.nav-toggle-label {
		flex: 1;
		min-width: 0;
	}
	.chev {
		transition: transform 0.15s;
	}
	.chev.up {
		transform: rotate(180deg);
	}
	.nav-panel {
		display: none;
	}
	.nav-panel.open {
		display: block;
		padding: 0.5rem 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.nav-panel .tabs a {
		min-height: 44px;
	}
	/* Phones: "Choose sections" after the list, on its own row. */
	.phone-sections-menu {
		display: flex;
		flex-wrap: wrap;
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem 0;
		border-top: 1px solid var(--border);
	}
	@media (prefers-reduced-motion: reduce) {
		.chev {
			transition: none;
		}
	}
	.issue-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--warning);
		margin-left: 0.3rem;
	}
	/* Data's "series behind" count (freshness.ts), as the boards' sidebar badge. */
	.count-badge {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.15rem;
		min-width: 1.4rem;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
		border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
		font-size: var(--font-xs);
		font-weight: 600;
		line-height: 1.35;
		text-align: center;
	}
	/* Read-only inputs read as plain values, not as a broken, greyed-out form. */
	/* Not a radio: it is always :read-only, and without its circle a viewer couldn't tell which option is chosen (issue #586). */
	.readonly :global(input:not([type='checkbox']):not([type='radio']):read-only),
	.readonly :global(select:disabled),
	.readonly :global(textarea:read-only) {
		background: transparent;
		border-color: transparent;
		color: var(--text);
		appearance: none;
		opacity: 1;
		cursor: default;
	}
</style>
