<script module lang="ts">
	// Only the Overview tab (the default, first paint) ships in this page's
	// chunk. Every other tab, and the Add data dialog, is its own chunk, fetched
	// when first shown and warmed when its tab link is hovered or focused
	// (docs/architecture.md § Code splitting). Module scope keeps each loader's
	// identity stable, which is what lazy.ts memoises on.
	const LOAD = {
		network: () => import('$lib/components/network/NetworkTab.svelte'),
		map: () => import('$lib/components/map/MapTab.svelte'),
		crops: () => import('$lib/components/crops/CropsTab.svelte'),
		transfers: () => import('$lib/components/transfers/TransfersTab.svelte'),
		series: () => import('$lib/components/series/SeriesTab.svelte'),
		settings: () => import('$lib/components/settings/SettingsTab.svelte'),
		runs: () => import('$lib/components/runs/RunsTab.svelte'),
		river: () => import('$lib/components/river/RiverTab.svelte'),
		supply: () => import('$lib/components/supply/SupplyTab.svelte'),
		dams: () => import('$lib/components/dams/DamsTab.svelte'),
		compare: () => import('$lib/components/compare/CompareView.svelte'),
		scenarios: () => import('$lib/components/scenarios/ScenariosTab.svelte'),
		allocations: () => import('$lib/components/allocations/AllocationsTab.svelte'),
		project: () => import('$lib/components/project/ProjectTab.svelte'),
		applications: () => import('$lib/components/scenarios/ApplicationsTab.svelte'),
		history: () => import('$lib/components/history/HistoryTab.svelte')
	};
	const loadAddData = () => import('$lib/components/series/AddDataDialog.svelte');
	// The save bar's Preview of the unsaved model edits against the last run (issue #284).
	const loadUnsavedPreview = () => import('$lib/components/preview/UnsavedPreviewDialog.svelte');
	// One farm's planted areas over any tab (`farm=<nodeId>`, issue #17 step 4).
	const loadFarmDrawer = () => import('$lib/components/crops/FarmCropsDrawer.svelte');
	// An existing grid, unchanged, in a full-screen modal over any tab (`grid=<id>`, issue #17).
	const loadGridModal = () => import('$lib/components/model/GridModal.svelte');
	// An applicant's whole view of the project (WP-3.3): the workspace's tabs all refuse them.
	const loadApplicantView = () => import('$lib/components/scenarios/ApplicantView.svelte');
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import type { SeriesMeta } from '@water-management/engine';
	import { chirpsSourceOf, observedOriginsOf } from '$lib/series/provenance';
	import { api, ApiError, hasRole, type Project, type ProjectSummary, type RunMeta } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { prefetch } from '$lib/components/common/lazy';
	import { provideUnsaved } from '$lib/components/common/chunkFailed';
	import { guardUnsaved } from '$lib/nav/unsaved';
	import { ProjectDetailsDraft } from '$lib/components/project/detailsDraft.svelte';
	import IssueList from '$lib/components/model/IssueList.svelte';
	import SaveBar from '$lib/components/model/SaveBar.svelte';
	import OverviewTab from '$lib/components/overview/OverviewTab.svelte';
	import { agoText } from '$lib/format/age';
	import { freshness, newDataSinceRun, STALE_DAYS } from '$lib/components/series/freshness';
	import type { UploadResult } from '$lib/components/series/upload';
	import { rerunQueuedText, resolveAutoRun } from '$lib/components/autorun/autoRun';
	import { fmtDay } from '$lib/format/number';
	import { projectToday } from '$lib/components/projects/freshness';
	import { kindLabel } from '$lib/series/kinds';
	import { ModelEditor } from '$lib/model/editor.svelte';
	import { fetchProjectPage, takeProjectPage } from '$lib/workspace/firstLoad';
	import { compareTabHref } from '$lib/components/compare/picker';
	import { withoutFarm } from '$lib/components/crops/farmDrawer';
	import { FieldHistoryStore, setFieldHistory } from '$lib/components/history/fieldHistory.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { fillSidebar } from '$lib/components/layout/sidebar.svelte';
	import SectionHeader from '$lib/components/workspace/SectionHeader.svelte';
	import SectionsMenu from '$lib/components/workspace/SectionsMenu.svelte';
	import { headerSlot } from '$lib/components/workspace/headerSlot.svelte';
	import { sectionContext } from '$lib/components/workspace/context';
	import { GRID_TAB, isGridId, movedGridHref, withParam, withoutParam } from '$lib/workspace/overlays';
	import {
		ALL_TABS,
		canOpenTab,
		hasModelInputsToggle,
		hiddenChoice,
		navSections,
		stripTabs,
		TAB_LABELS,
		VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT,
		visibleTabs,
		type TabId
	} from '$lib/workspace/tabs';

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
		calibration: 'settings',
		results: 'runs',
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
	const stripIds = $derived(stripTabs(shownIds, tab, TAB_IDS));
	// "Changed 3× · last by …" under the model inputs (docs/ui.md § Field history): for those whose role sees
	// History, whether or not they keep it in their sidebar (it is hidden by default, DEFAULT_HIDDEN_TABS, and
	// the line's link still opens it); fetched once a line asks for it, and again after a save or a restore.
	const canSeeHistory = $derived(roleIds.includes('history'));
	const fieldHistory = $derived(canSeeHistory && projectId ? new FieldHistoryStore(projectId) : null);
	setFieldHistory(() => fieldHistory);
	const LABEL = TAB_LABELS;
	// Outcomes, Build the model, Review (issue #17). `strip` is the same tabs
	// flattened in the order shown, for the arrow keys.
	const sections = $derived(navSections(stripIds));
	const strip = $derived(sections.flatMap((s) => s.tabs));
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notFound = $state(false);
	const editor = new ModelEditor();
	// The project details being edited on the Project page (issue #162 item 12):
	// held here, so they survive a tab change and share the model's save bar.
	const details = new ProjectDetailsDraft();
	// A tab or dialog whose chunk fails to download offers a reload; with
	// unsaved edits it warns first (the reload still meets the browser's
	// own prompt, lib/nav/leaveGuard.ts).
	provideUnsaved(() => editor.dirty || details.dirty);
	// Leaving the project (not just changing tab) with either unsaved asks first, in
	// the app's dialog (lib/nav/leaveGuard.ts); a tab change keeps both.
	guardUnsaved({ dirty: () => editor.dirty, what: 'model edits' });
	guardUnsaved({ dirty: () => details.dirty, what: 'project details' });
	// Shared with the Overview checklist, the Time series tab and the Runs tab.
	let series = $state<SeriesMeta[] | null>(null);
	// A daily A-pan series: runs use it before the monthly means, which the Crops demand preview shows (issue #173).
	const apanDaily = $derived(series?.some((x) => x.kind === 'evap_apan_mm' && !x.siteNodeId) ?? false);
	let runs = $state<RunMeta[] | null>(null);
	let saveBarHeight = $state(0);
	/** The save bar's optional "Reason for this change", kept with the change in the History tab. */
	let saveReason = $state('');

	// --- data freshness, "Add data" (button or drop a CSV anywhere) ------------
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
	const rerunQueued = $derived(resolveAutoRun(project?.settings).enabled && !!project?.rerunQueuedFor);
	const queuedSentence = $derived.by(() => {
		const t = rerunQueuedText(project?.rerunQueuedFor);
		return `${t[0]!.toUpperCase()}${t.slice(1)}.`;
	});
	// The model edits' Preview (issue #284): fetched the first time it's wanted, then kept, with its worker.
	// Not on Settings, whose own Preview takes the model's edits with the form's.
	let previewOpen = $state(false);
	let previewMounted = $state(false);
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
	// `?add=data` (the project list's Add data link): the dialog opens once the role is known, for an
	// editor, and the param goes so Back or a reload doesn't reopen it.
	$effect(() => {
		if (page.url.searchParams.get('add') !== 'data' || !project) return;
		untrack(() => {
			if (canEdit) openAddData();
			void goto(withoutParam(page.url, 'add'), { replaceState: true, noScroll: true, keepFocus: true });
		});
	});
	const hasFiles = (e: DragEvent) => canEdit && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	function onDragEnter(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (dragDepth === 0) prefetch(loadAddData);
		dragDepth++;
	}
	function onDragOver(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}
	function onDragLeave(e: DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}
	function onDrop(e: DragEvent) {
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
		if (tab === 'series') void goto(withParam(page.url, 'series', r.meta.id), { replaceState: true, noScroll: true, keepFocus: true });
		const what = r.meta.name || kindLabel(r.meta.kind);
		banner = {
			text: r.added || r.changed ? `${r.message.replace(/\.$/, '')}.` : `No new days for “${what}”: the file matched what is stored.`,
			added: r.added + r.changed
		};
	}

	// The header's Run model and the new-data line's Re-run model both start a
	// run here and open it in Runs.
	/** The new-data re-run (labelled with the data's end), or the header's Run model (no label). */
	const rerun = () => startRun(`Data to ${fresh?.latest ?? today}`);
	async function startRun(label?: string) {
		rerunning = true;
		rerunError = null;
		try {
			const { run: r, removedRunIds } = await api.runs.create(projectId, label);
			const { summary: _s, ...meta } = r;
			setRuns([meta, ...(runs ?? []).filter((x) => x.id !== r.id && !removedRunIds.includes(x.id))]);
			banner = null;
			await goto(`?tab=runs&run=${r.id}`, { noScroll: true });
		} catch (e) {
			rerunError = e instanceof Error ? e.message : String(e);
		} finally {
			rerunning = false;
		}
	}

	const canEdit = $derived(hasRole(project?.role, 'editor'));
	const isOwner = $derived(hasRole(project?.role, 'owner'));

	// --- the section header (SectionHeader, issue #17) -------------------------
	// Run model on the Summary and the Build-the-model pages; the Runs tab puts
	// its own form (with a label) in the same place (headerSlot.main), and
	// Data's main action is Add data.
	const RUN_TABS: TabId[] = ['overview', 'network', 'crops', 'transfers', 'settings'];
	const showRun = $derived(canEdit && RUN_TABS.includes(tab));
	// What a run still needs (the Runs tab's check: the engine refuses without these).
	const runNeeds = $derived.by(() => {
		const out: string[] = [];
		if (!editor.model.nodes.length) out.push('a network');
		if (series && !series.some((x) => x.kind.startsWith('rain_'))) out.push('a rainfall series');
		return out;
	});
	// The Data badge in the sections: series a run is driven by that are behind today (freshness.ts).
	const behindCount = $derived(fresh?.behind.length ?? 0);
	const contextText = $derived(
		sectionContext(tab, { runs, seriesCount: series?.length ?? null, behind: behindCount, transfers: editor.model.transfers })
	);

	async function load() {
		loading = true;
		error = null;
		notFound = false;
		applicantProject = null;
		try {
			// Everything a tab's first render needs, behind one loading gate, so no
			// tab (or the Overview checklist) flashes an empty state. On a full page
			// load the root layout already started them beside /auth/me (firstLoad.ts).
			const [p, m, sl, rl] = await (takeProjectPage(projectId) ?? fetchProjectPage(projectId));
			project = p;
			editor.load(m);
			details.load(p);
			series = sl;
			setRuns(rl);
		} catch (e) {
			// A farmer gets 403 from the workspace's routes: their view of this
			// project is the farm page (WP-2.6). An applicant's is the Applicant
			// view (WP-3.3).
			if (e instanceof ApiError && e.status === 403) {
				const here = await summaryHere();
				if (here?.role === 'farmer') {
					await goto(`${base}/farm/${encodeURIComponent(projectId)}`, { replaceState: true });
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
			const p = await api.projects.update(projectId, details.patch());
			project = p;
			details.load(p);
			fieldHistory?.refresh();
			return true;
		} catch (e) {
			details.saveError = e instanceof Error ? e.message : String(e);
			return false;
		} finally {
			details.saving = false;
		}
	}
	/** The save bar's Save changes: the project details, then the model, whichever are unsaved. */
	async function saveAll() {
		if (details.dirty && !(await saveDetails())) return;
		if (editor.dirty) await saveModel();
	}

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
		if (!drawerOpen && untrack(() => drawerFarm)) goto(withoutFarm(page.url), { replaceState: true, noScroll: true, keepFocus: true });
	});

	// --- the grid modal: open while the URL names a grid, closed the same way --
	// Not over the grid's own tab, where the grid is already on the page.
	const gridParam = $derived(modelOverlays ? page.url.searchParams.get('grid') : null);
	const openGrid = $derived(isGridId(gridParam) && GRID_TAB[gridParam] !== tab ? gridParam : null);
	let gridOpen = $state(false);
	$effect(() => {
		gridOpen = !!openGrid;
	});
	$effect(() => {
		if (!gridOpen && untrack(() => gridParam) && !untrack(() => movedGridHref(page.url))) goto(withoutParam(page.url, 'grid'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	// A grid that left the modal: its old link goes where the grid is now (grid=demand → Crops & demand's table, issue #174).
	$effect(() => {
		const moved = movedGridHref(page.url);
		if (moved) void goto(moved, { replaceState: true, noScroll: true });
	});

	// Selecting a tab keeps focus/scroll and adds a history entry so Back works.
	function tabHref(id: TabId) {
		return id === 'overview' ? page.url.pathname : `?tab=${id}`;
	}

	function onProjectChange(p: Project) {
		project = p;
		details.rebase(p);
		fieldHistory?.refresh();
	}

	/** A restore (History tab, or a run's "Restore these inputs") changed the saved settings and model. */
	async function reloadInputs() {
		const [p, m] = await Promise.all([api.projects.get(projectId), api.model.get(projectId)]);
		project = p;
		details.rebase(p);
		editor.load(m);
		fieldHistory?.refresh();
	}

	async function onLeftProject() {
		await goto(`${base}/`);
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
		goto(tabHref(next), { keepFocus: false, noScroll: true }).then(() => document.getElementById(`tab-${next}`)?.focus());
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
						onpointerenter={() => warmTab(id)}
						onfocus={() => warmTab(id)}
					>
						{LABEL[id]}
						{#if id === 'series' && behindCount}
							<span class="count-badge" title="{behindCount} series behind (older than {STALE_DAYS} days)"
								><span aria-hidden="true">{behindCount}</span><span class="visually-hidden">({behindCount} series behind)</span></span
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
		<a class="side-project" href={tabHref('overview')} title={project?.name} data-testid="project-name">{project?.name}</a>
		{@render sectionsNav()}
	</div>
{/snippet}

{#snippet roleBadge()}
	<span class="badge" class:badge-owner={isOwner} data-testid="project-role">{project?.role}</span>
{/snippet}

<!-- The section header's parts (SectionHeader): the page's own around the tab's (headerSlot). -->
{#snippet unsavedBadge()}
	{#if (editor.dirty || details.dirty) && canEdit}<span class="badge badge-warn">Unsaved changes</span>{/if}
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
				{#if fresh.latest !== null && fresh.age !== null}
					Rain up to <strong>{fmtDay(fresh.latest)}</strong> ({agoText(fresh.age)}){#if fresh.stale}<span class="visually-hidden">{`, older than ${STALE_DAYS} days`}</span>{/if}
				{:else}
					No recorded rain yet
				{/if}
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
<!-- Add data, then Run model or the tab's main action in its place: the pair every section ends on. -->
{#snippet headerMain()}
	{#if canEdit}
		<button
			type="button"
			class="btn add"
			class:btn-primary={!showRun && !headerSlot.main}
			onclick={() => openAddData()}
			onpointerenter={() => prefetch(loadAddData)}
			onfocus={() => prefetch(loadAddData)}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 11V2M4.5 5.5 8 2l3.5 3.5M2 11v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
			Add data
		</button>
	{/if}
	{@render headerSlot.main?.()}
	{#if showRun}
		<button
			type="button"
			class="btn btn-primary"
			disabled={rerunning || runNeeds.length > 0}
			aria-describedby={runNeeds.length ? 'run-needs' : undefined}
			onclick={() => startRun()}>{rerunning ? 'Running model…' : 'Run model'}</button
		>
		{#if runNeeds.length}<span class="visually-hidden" id="run-needs">A run needs {runNeeds.join(' and ')} first.</span>{/if}
	{/if}
{/snippet}
<!-- The notices: one slim line under the header, not full-width banners. -->
{#snippet headerNotices()}
	{@const behind = !banner && behindRun.length > 0 && tab !== 'runs' && tab !== 'series'}
	{#if !canEdit || banner || behind || rerunError}
		<div class="notice-line" data-testid="notice-line">
			{#if !canEdit}
				<span class="note readonly-note" role="note">
					<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" stroke-width="1.6" />
						<circle cx="10" cy="10" r="2.6" fill="currentColor" />
					</svg>
					<span>
						<strong>View only.</strong> You have view-only access to this project. You can explore every input and
						result; ask the project owner for editor access to change anything or run the model.
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
					{#if rerunQueued}<span data-testid="rerun-queued">{queuedSentence}</span>{:else if canEdit}<button type="button" class="btn btn-sm" disabled={rerunning} onclick={rerun}>{rerunning ? 'Running model…' : 'Re-run model'}</button>{/if}
				</span>
			{/if}
			{#if rerunError}<span class="note err" role="alert">The run didn’t start: {rerunError}</span>{/if}
		</div>
	{/if}
{/snippet}
<svelte:head><title>{project ? `${project.name} · ` : ''}Water Management</title></svelte:head>

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
				This project doesn't exist or you don't have access to it. <a href="{base}/">Back to projects</a>
			</div>
		{:else}
			<div class="workspace">
			{#if !wide.current}
			<div class="tab-row">
				<p class="phone-project"><span class="phone-name" data-testid="project-name">{project.name}</span>{@render roleBadge()}</p>
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
				badge={unsavedBadge}
				context={headerSlot.context ?? (contextText ? pageContext : null)}
				status={fresh || series || headerSlot.status ? headerStatus : null}
				actions={headerSlot.actions}
				main={canEdit || headerSlot.main ? headerMain : null}
				notices={headerNotices}
			/>

			<section class="tab-body" class:readonly={!canEdit} aria-labelledby="tab-{tab}">
				{#if tab === 'overview'}
					<OverviewTab {project} {editor} {series} {runs} {canEdit} visibleTabs={roleIds} />
				{:else if tab === 'network'}
					<IssueList issues={editor.issues} area="network" />
					<Lazy load={LOAD.network}>
						{#snippet children(NetworkTab)}<NetworkTab {editor} settings={project!.settings} readonly={!canEdit} {projectId} {runs} onsave={saveModel} bind:reason={saveReason} />{/snippet}
					</Lazy>
				{:else if tab === 'map'}
					<Lazy load={LOAD.map}>
						{#snippet children(MapTab)}<MapTab {projectId} {editor} {canEdit} onModelChanged={reloadInputs} />{/snippet}
					</Lazy>
				{:else if tab === 'crops'}
					<IssueList issues={editor.issues} area="crops" />
					<Lazy load={LOAD.crops}>
						{#snippet children(CropsTab)}<CropsTab {editor} settings={project!.settings} readonly={!canEdit} onsave={saveModel} bind:reason={saveReason} {apanDaily} />{/snippet}
					</Lazy>
				{:else if tab === 'transfers'}
					<IssueList issues={editor.issues} area="transfers" />
					<Lazy load={LOAD.transfers}>
						{#snippet children(TransfersTab)}<TransfersTab {editor} readonly={!canEdit} page />{/snippet}
					</Lazy>
				{:else if tab === 'settings'}
					<Lazy load={LOAD.settings}>
						{#snippet children(SettingsTab)}
							<SettingsTab
								project={project!}
								{editor}
								seriesKinds={series?.filter((x) => !x.siteNodeId).map((x) => x.kind) ?? null}
								gaugeRecords={series?.flatMap((x) => (x.siteNodeId ? [{ kind: x.kind, siteNodeId: x.siteNodeId }] : [])) ?? null}
								chirpsSource={chirpsSourceOf(series)}
								observedOrigins={observedOriginsOf(series)}
								apanSeries={series ? (series.find((x) => x.kind === 'evap_apan_mm') ?? null) : undefined}
								readonly={!canEdit}
								{onProjectChange}
								{runs}
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
								{runs}
								settings={project!.settings}
								timeZone={project!.timeZone}
								gauges={editor.model.nodes.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null)}
								onSeriesChange={(l) => (series = l)}
								onadddata={() => openAddData()}
							/>
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
						{#snippet children(SupplyTab)}<SupplyTab {projectId} {editor} {runs} readonly={!canEdit} />{/snippet}
					</Lazy>
				{:else if tab === 'dams'}
					<Lazy load={LOAD.dams}>
						{#snippet children(DamsTab)}<DamsTab {projectId} {editor} {runs} readonly={!canEdit} />{/snippet}
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
						{#snippet children(ScenariosTab)}<ScenariosTab {projectId} {runs} {canEdit} onRunsChange={setRuns} reloadRuns={loadRuns} />{/snippet}
					</Lazy>
				{:else if tab === 'allocations'}
					<Lazy load={LOAD.allocations}>
						{#snippet children(AllocationsTab)}<AllocationsTab {projectId} {runs} {canEdit} />{/snippet}
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
			<SaveBar {editor} {details} onsave={saveAll} readonly={!canEdit} bind:height={saveBarHeight} bind:reason={saveReason} onpreview={tab === 'settings' ? null : openPreview} />
			{#if previewMounted}
				<Lazy load={loadUnsavedPreview}>
					{#snippet children(UnsavedPreviewDialog)}
						<UnsavedPreviewDialog bind:open={previewOpen} {projectId} {runs} what="model edits" edits={() => ({ model: { saved: editor.savedModel(), draft: editor.snapshot() } })} />
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
	.add {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
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
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	/* In a narrow header the pill starts its own row at the left (SectionHeader), so the list opens rightwards. */
	@container section-header (max-width: 640px) {
		.fresh-pop {
			left: 0;
			right: auto;
		}
	}
	.fresh-pop p {
		margin: 0.4rem 0 0;
		font-size: 0.78rem;
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
		font-size: 0.75rem;
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
	.project-side .tabs {
		gap: 0.75rem;
	}
	.project-side .section-label {
		padding-bottom: 0.1rem;
	}
	.project-side .tabs a {
		min-height: 34px;
	}
	/* Phones: the catchment's name and your role, above the Sections button. */
	.phone-project {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
		margin: 0;
		font-weight: 600;
	}
	.phone-name {
		min-width: 0;
		overflow-wrap: anywhere;
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
		margin-bottom: 1rem;
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
		min-width: 1.4rem;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--warning-soft);
		color: var(--warning);
		border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.35;
		text-align: center;
	}
	/* Read-only inputs read as plain values, not as a broken, greyed-out form. */
	.readonly :global(input:not([type='checkbox']):read-only),
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
