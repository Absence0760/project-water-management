<script lang="ts">
	// Warnings (`?tab=warnings`, issue #611, docs/ui.md § Warnings): the
	// project's one list of warnings and problems, each row with what to do and
	// an action that does it, or a link to the exact field.
	//
	// Three parts, data checks first: the periods a data check flags on a
	// stored series (items.ts: Patch, Exclude from calibration, Keep, Reopen);
	// the problems other pages show (problems.ts: the model, unsaved settings,
	// data feeds, data behind, runs an erratum may affect); the shown run's
	// warnings (runWarnings.ts, each solved by fixes.ts: a one-value setting
	// saved here, the exact field, a page, or this page's data checks). A run
	// warning or problem the reader accepts is kept, with a note
	// (settings.warningsKept), and reopened from its row.
	//
	// One set of filters across every row, in the URL with each chip's count
	// (filters.ts): source, status, severity, area, record and a search; the
	// data checks keep their kind of check. Ticks and "Select all N matching"
	// feed one bulk row: Keep and Reopen across sources, Patch and Exclude for
	// data checks. A decision saves at once through the settings PATCH with a
	// reason, built on the settings read just before (so another save since
	// the page loaded stays); a row fixed by a setting reads "Fixed: rerun to
	// confirm" until a run no longer warns, and a line offers Run now. A
	// viewer reads it all, with the links but no ticks or buttons.
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { ProjectSettings, RunSummary, SeriesMeta, WarningKept } from '@water-management/engine';
	import { WARNINGS_KEPT_MAX, WARNING_KEPT_NOTE_MAX } from '@water-management/engine';
	import { api, hasRole, type Project, type RunMeta } from '#lib/api/index.js';
	import { focusAfterRemove } from '#lib/a11y/focusAfterRemove.js';
	import Dialog from '#lib/components/common/Dialog.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { shownRun } from '#lib/components/calibration/page.js';
	import { feedsApi } from '#lib/components/feeds/feeds.js';
	import { fmtNum, fmtWhen } from '#lib/format/number.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { SearchStep } from '#lib/nav/searchStep.js';
	import { withParam, withoutParam } from '#lib/workspace/overlays.js';
	import type { Daily } from '#lib/components/series/coverage.js';
	import WarningText from '#lib/components/runs/WarningText.svelte';
	import { warningPlaceHref } from '#lib/components/runs/warningText.js';
	import type { ModelIssue } from '#lib/model/validate.js';
	import type { SaveBlocker } from '#lib/components/settings/sections.js';
	import {
		CHECK_LABEL,
		CHECK_ORDER,
		DECISION_LABEL,
		STATUS_LABEL,
		daysText,
		decide,
		decisionsFor,
		itemsNoun,
		itemStatus,
		openCount,
		periodText,
		reopen,
		settingHref,
		statusDetail,
		warningItems,
		whatText,
		type Decision,
		type SettingsPatch,
		type WarningItem
	} from './items';
	import { runWarningRows, type RunWarningRow } from './runWarnings';
	import { loadFeedProblems, loadRunSummary, loadValues } from './sources';
	import {
		AREA_LABEL,
		AREAS,
		problems,
		PROBLEM_SOURCES,
		SOURCE_FILTERS,
		SOURCE_LABEL,
		type BehindSeries,
		type FeedProblem,
		type Problem,
		type SourceFilter
	} from './problems';
	import { facetCounts, parsePageFilters, passes, SEVERITY_LABEL, STATE_FILTERS, STATE_LABEL, type FacetRow, type RowState, type Severity, type StateFilter } from './filters';
	import type { FixAction } from './fixes';
	import type { Area } from './problems';

	let {
		projectId,
		project,
		series,
		runs,
		canEdit,
		nodes = [],
		issues = [],
		blockers = [],
		behind = [],
		running = false,
		onRun,
		onProjectChange
	}: {
		projectId: string;
		project: Project;
		/** The page's series list; null while it loads. */
		series: SeriesMeta[] | null;
		/** The page's runs, newest first; null while they load. */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The model's nodes: a unit's own gauge and an inner gauge's record are named with theirs. */
		nodes?: readonly { id: string; name: string }[];
		/** The model editor's problems (the sidebar's "Has problems to fix"). */
		issues?: readonly ModelIssue[];
		/** The unsaved settings' problems that block Save (the page's settings draft). */
		blockers?: readonly SaveBlocker[];
		/** The series behind today (the Data row's count). */
		behind?: readonly BehindSeries[];
		/** A run the page started is out (its Run model). */
		running?: boolean;
		/** Start a run, as the header's Run model does (it opens back here). */
		onRun?: () => void;
		onProjectChange: (p: Project) => void;
	} = $props();

	/** Data-check rows shown before "Show all N periods"; other rows per part. */
	const FOLD = 25;
	const LIST_FOLD = 8;

	// --- the data checks' series values ---
	let values = $state.raw<Record<string, Daily> | null>(null);
	let failed = $state.raw<Record<string, string>>({});
	let loadError = $state<string | null>(null);
	let loading = $state(true);
	async function load() {
		const list = series;
		if (!list) return;
		loading = true;
		loadError = null;
		try {
			const r = await loadValues(projectId, list);
			values = r.values;
			failed = r.failed;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void series;
		untrack(load);
	});

	// --- the shown run: `run=` as on Runs & results and Calibration, else the newest (a viewer's published one) ---
	const run = $derived(shownRun(runs, page.url.searchParams.get('run'), project.role));
	let summary = $state.raw<RunSummary | null>(null);
	let summaryFor = $state<string | null>(null);
	let runError = $state<string | null>(null);
	$effect(() => {
		const id = run?.id ?? null;
		untrack(() => {
			runError = null;
			if (!id) {
				summary = null;
				summaryFor = null;
				return;
			}
			loadRunSummary(projectId, id).then(
				(s) => {
					if ((run?.id ?? null) !== id) return;
					summary = s;
					summaryFor = id;
				},
				(e) => {
					if ((run?.id ?? null) === id) runError = e instanceof Error ? e.message : String(e);
				}
			);
		});
	});
	const shownSummary = $derived(summaryFor === run?.id ? summary : null);

	// --- the feeds that need attention ---
	let feeds = $state.raw<FeedProblem[] | null>(null);
	let feedsError = $state<string | null>(null);
	async function loadFeeds() {
		feedsError = null;
		try {
			feeds = await loadFeedProblems(projectId);
		} catch (e) {
			feedsError = e instanceof Error ? e.message : String(e);
		}
	}
	onMount(() => void loadFeeds());

	const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? null;
	const settings = $derived(project.settings as ProjectSettings);
	const kept = $derived(new Map((settings.warningsKept ?? []).map((k) => [k.id, k])));
	const isEditor = $derived(canEdit && hasRole(project.role, 'editor'));

	// --- every row, in one shape for the filters ---
	const items = $derived(values && series ? warningItems({ series, values, settings, run: shownSummary, nodeName }) : []);
	const open = $derived(openCount(items));
	const recordsWithItems = $derived(new Set(items.map((i) => i.seriesId)).size);
	const failedNames = $derived(
		Object.keys(failed)
			.map((id) => series?.find((s) => s.id === id))
			.filter((s): s is SeriesMeta => !!s)
			.map((s) => s.name || s.kind)
	);
	const elsewhere = $derived(problems({ issues, blockers, feeds, behind, runs, role: project.role }));
	const runRows = $derived(runWarningRows(shownSummary, resolve('help/guides/run-and-read-results')));

	/** An "other" row: a problem or a run warning, with its state. */
	interface OtherRow {
		id: string;
		source: Exclude<SourceFilter, 'all' | 'checks'>;
		severity: Severity;
		area: Area;
		record: string | null;
		title: string;
		detail: string;
		how: string;
		/** The run warning's text, drawn with its place links; null for a problem. */
		warning: string | null;
		action: FixAction | Problem['fix'];
		params: Record<string, string | number>;
		state: RowState;
		note: string;
	}
	const checkState = (i: WarningItem): RowState => (i.status === 'open' ? 'open' : i.status === 'kept' ? 'kept' : 'fixed');
	const checkArea = (i: WarningItem): Area => (i.role === 'flow' ? 'calibration' : i.role === 'other' ? 'data' : 'rain');
	const checkFacet = (i: WarningItem): FacetRow => ({
		source: 'checks',
		state: checkState(i),
		severity: i.severity === 'info' ? 'note' : 'check',
		area: checkArea(i),
		record: i.seriesId,
		text: `${CHECK_LABEL[i.check]} ${i.record} ${periodText(i)} ${whatText(i)} ${statusDetail(i)}`
	});
	const problemRows = $derived<OtherRow[]>(
		elsewhere.map((p) => ({
			id: `problem:${p.id}`,
			source: p.source,
			severity: 'check',
			area: p.area,
			record: p.record,
			title: p.title,
			detail: p.detail,
			how: p.how,
			warning: null,
			action: p.fix,
			params: {},
			state: kept.has(`problem:${p.id}`) ? 'kept' : 'open',
			note: kept.get(`problem:${p.id}`)?.note ?? ''
		}))
	);
	const runRowState = (r: RunWarningRow): RowState => {
		if (kept.has(r.id)) return 'kept';
		const a = r.fix.action;
		return a.kind === 'setting' && a.applied(settings, r.params) ? 'fixed' : 'open';
	};
	const warningRows = $derived<OtherRow[]>(
		runRows.map((r) => ({
			id: r.id,
			source: 'run',
			severity: r.group,
			area: r.area,
			record: null,
			title: r.group === 'check' ? 'To check' : 'Note',
			detail: r.text,
			how: r.fix.how,
			warning: r.text,
			action: r.fix.action,
			params: r.params,
			state: runRowState(r),
			note: kept.get(r.id)?.note ?? ''
		}))
	);
	const otherFacet = (r: OtherRow): FacetRow => ({ source: r.source, state: r.state, severity: r.severity, area: r.area, record: r.record, text: `${r.title} ${r.detail} ${r.how} ${r.note}` });

	// --- filters (filters.ts), all in the URL ---
	const filters = $derived(parsePageFilters(page.url.searchParams));
	const checkKind = $derived(page.url.searchParams.get('check'));
	const facets = $derived([...items.map(checkFacet), ...problemRows.map(otherFacet), ...warningRows.map(otherFacet)]);
	const counts = $derived(facetCounts(facets, filters));
	const checksShown = $derived(items.filter((i) => passes(checkFacet(i), filters) && (!checkKind || i.check === checkKind)));
	const checkKinds = $derived(
		CHECK_ORDER.map((c) => ({ check: c, count: items.filter((i) => i.check === c && passes(checkFacet(i), filters)).length })).filter((c) => c.count || c.check === checkKind)
	);
	const checksAll = $derived(items.filter((i) => passes(checkFacet(i), filters)).length);
	const problemsShown = $derived(problemRows.filter((r) => passes(otherFacet(r), filters)));
	const warningsShown = $derived(warningRows.filter((r) => passes(otherFacet(r), filters)));
	const records = $derived.by(() => {
		const m = new Map<string, { id: string; label: string; count: number }>();
		const add = (id: string | null, label: string, f: FacetRow) => {
			if (!id) return;
			const r = m.get(id) ?? { id, label, count: 0 };
			if (passes(f, filters, 'series')) r.count++;
			m.set(id, r);
		};
		for (const i of items) add(i.seriesId, i.record, checkFacet(i));
		for (const r of problemRows) add(r.record, r.title, otherFacet(r));
		return [...m.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
	});
	const recordAll = $derived(facets.filter((f) => passes(f, filters, 'series')).length);
	const showChecks = $derived(filters.source === 'all' || filters.source === 'checks');
	const showOther = $derived(filters.source === 'all' || (PROBLEM_SOURCES as readonly string[]).includes(filters.source));
	const showRun = $derived(filters.source === 'all' || filters.source === 'run');
	const groups = $derived(PROBLEM_SOURCES.map((s) => ({ source: s, list: problemsShown.filter((r) => r.source === s) })).filter((g) => g.list.length));

	const paramHref = (key: string, v: string | null, dflt: string | null = null) => (v === dflt || v === null ? withoutParam(page.url, key) : withParam(page.url, key, v));
	const sourceHref = (s: SourceFilter) => paramHref('source', s, 'all');
	const statusHref = (s: StateFilter) => paramHref('status', s, 'open');
	const sevHref = (s: Severity | null) => paramHref('sev', s);
	const areaHref = (a: Area | null) => paramHref('area', a);
	const checkHref = (c: string | null) => paramHref('check', c);
	const runWarningsHref = $derived(showRun ? '#warn-run' : `${sourceHref('run')}#warn-run`);
	function setRecord(id: string) {
		void goto(id ? withParam(page.url, 'series', id) : withoutParam(page.url, 'series'), { reset: false });
	}
	const everyHref = $derived.by(() => `?tab=warnings&status=all${page.url.searchParams.get('run') ? `&run=${encodeURIComponent(page.url.searchParams.get('run')!)}` : ''}`);

	// The search: a typed search is one step in history (lib/nav/searchStep.ts), written after a pause.
	let query = $state(untrack(() => filters.q));
	let written = untrack(() => filters.q);
	$effect(() => {
		const q = filters.q;
		if (q !== untrack(() => written)) query = written = q;
	});
	const queryStep = new SearchStep();
	let queryTimer: ReturnType<typeof setTimeout> | undefined;
	function onQueryInput() {
		clearTimeout(queryTimer);
		queryTimer = setTimeout(() => {
			const words = query.trim();
			if (words === filters.q) return;
			written = words;
			const href = words ? withParam(page.url, 'q', words) : withoutParam(page.url, 'q');
			void queryStep.write(href, (replace) => goto(href, { replace, reset: false }));
		}, 300);
	}
	$effect(() => () => clearTimeout(queryTimer));

	// --- folds ---
	let allShown = $state(false);
	const visible = $derived(allShown || checksShown.length <= FOLD ? checksShown : checksShown.slice(0, FOLD));
	let otherAll = $state(false);
	let runAll = $state(false);
	const warningsVisible = $derived(runAll || warningsShown.length <= LIST_FOLD ? warningsShown : warningsShown.slice(0, LIST_FOLD));

	// --- selection, across every part; a filter change starts over ---
	let selected = $state<Set<string>>(new Set());
	const filterKey = $derived(`${page.url.search}`);
	$effect(() => {
		void filterKey;
		untrack(() => {
			selected = new Set();
			allShown = false;
		});
	});
	const shownIds = $derived([...(showChecks ? checksShown.map((i) => i.id) : []), ...(showOther ? problemsShown.map((r) => r.id) : []), ...(showRun ? warningsShown.map((r) => r.id) : [])]);
	const pickedChecks = $derived(showChecks ? checksShown.filter((i) => selected.has(i.id)) : []);
	const pickedOther = $derived([...(showOther ? problemsShown : []), ...(showRun ? warningsShown : [])].filter((r) => selected.has(r.id)));
	const pickedCount = $derived(pickedChecks.length + pickedOther.length);
	const allVisiblePicked = $derived(visible.length > 0 && visible.every((i) => selected.has(i.id)));
	function toggle(id: string, on: boolean) {
		const next = new Set(selected);
		if (on) next.add(id);
		else next.delete(id);
		selected = next;
	}
	function toggleVisible(on: boolean) {
		selected = on ? new Set([...selected, ...visible.map((i) => i.id)]) : new Set([...selected].filter((id) => !visible.some((i) => i.id === id)));
	}
	const selectAllMatching = () => (selected = new Set(shownIds));
	const checkCount = (d: Decision) => pickedChecks.filter((i) => decisionsFor(i).includes(d)).length;
	const keepCount = $derived(checkCount('keep') + pickedOther.filter((r) => r.state !== 'kept').length);
	const reopenCount = $derived(pickedChecks.filter((i) => i.status === 'kept' || i.status === 'patched' || i.status === 'excluded').length + pickedOther.filter((r) => r.state === 'kept').length);
	// By what the list holds, not by what is still open, so a button never goes while it has the focus.
	const hasRain = $derived(items.some((i) => i.role === 'catchmentRain' || i.role === 'rain'));
	const hasFlow = $derived(items.some((i) => i.role === 'flow'));

	// --- saving: every decision is built on the settings as saved now ---
	let saving = $state(false);
	let notice = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	const DONE: Record<Decision, string> = { patch: 'Patched', exclude: 'Excluded from calibration', keep: 'Kept' };
	type Built = { patch: SettingsPatch; reason: string; done: string } | { error: string };
	type Judge = (list: readonly WarningItem[]) => WarningItem[];

	/**
	 * Save one decision. The lists it writes are sent whole (rainStations, flowMissing, warningsKept), so the patch
	 * is built from the settings as the server holds them now, read just before, never from this page's copy:
	 * another editor's save, or this person's in another tab, since the page loaded stays. The data-check items
	 * are judged against those settings too, so a period someone else decided meanwhile isn't added again.
	 */
	async function save(build: (settings: ProjectSettings, judge: Judge) => Built): Promise<boolean> {
		saving = true;
		notice = null;
		try {
			const current = await api.projects.get(projectId);
			const fresh = current.settings as ProjectSettings;
			const built = build(fresh, (list) => list.map((i) => ({ ...i, status: itemStatus(i, i.role, fresh) })));
			if ('error' in built) {
				onProjectChange(current);
				notice = { tone: 'error', text: built.error };
				return false;
			}
			const p = await api.projects.update(projectId, { settings: built.patch as Partial<ProjectSettings>, reason: built.reason });
			onProjectChange(p);
			notice = { tone: 'ok', text: `${built.done} Run the model to see which warnings remain.` };
			return true;
		} catch (e) {
			notice = { tone: 'error', text: `Couldn’t save: ${e instanceof Error ? e.message : String(e)}` };
			return false;
		} finally {
			saving = false;
		}
	}

	/** settings.warningsKept with `ids` kept (with `note`) or reopened; null when that leaves none. */
	function withKept(fresh: ProjectSettings, ids: readonly string[], note: string | null): WarningKept[] | null | { error: string } {
		const rest = (fresh.warningsKept ?? []).filter((k) => !ids.includes(k.id));
		const next = note === null ? rest : [...rest, ...ids.map((id) => ({ id, note: note.trim().slice(0, WARNING_KEPT_NOTE_MAX) }))];
		if (next.length > WARNINGS_KEPT_MAX) return { error: `This would keep ${next.length} warnings, past the ${WARNINGS_KEPT_MAX} the list keeps: reopen some kept warnings first.` };
		return next.length ? next : null;
	}

	/** Focus after a row's action: the row's first action if the row stays, else the one now in its place. */
	async function refocus(id: string, at: number, scope: string, fallback: string) {
		await tick();
		const still = document.querySelector<HTMLElement>(`${scope} [data-row="${CSS.escape(id)}"] [data-row-action]`);
		if (still) still.focus();
		else await focusAfterRemove(at, `${scope} [data-row-action]`, fallback);
	}

	/** One data-check row's decision (or Reopen). */
	async function decideRow(i: WarningItem, d: Decision | 'reopen', at: number) {
		if (saving) return;
		const ok = await save((fresh, judge) => {
			const [now] = judge([i]);
			if (d === 'reopen') {
				const r = reopen(now!, fresh);
				return r ? { ...r, done: `Reopened ${itemsNoun([i])}.` } : { error: 'Someone has reopened this period already.' };
			}
			const r = decide([now!], d, fresh);
			return r.ok ? { patch: r.patch, reason: r.reason, done: `${DONE[d]} ${itemsNoun([i])}.` } : { error: r.error };
		});
		if (ok) await refocus(i.id, at, '#warn-rows', 'warn-checks-h');
	}

	/** A bulk Patch or Exclude of the ticked data checks. */
	async function decideBulk(d: 'patch' | 'exclude') {
		if (saving || !checkCount(d)) return;
		const targets = pickedChecks;
		const ok = await save((fresh, judge) => {
			const now = judge(targets);
			const r = decide(now, d, fresh);
			return r.ok ? { patch: r.patch, reason: r.reason, done: `${DONE[d]} ${itemsNoun(now.filter((i) => decisionsFor(i).includes(d)))}.` } : { error: r.error };
		});
		if (ok) selected = new Set();
	}

	// Keep asks for an optional note first (a dialog); Reopen doesn't.
	let keepFor = $state<{ checks: WarningItem[]; other: OtherRow[]; at: number | null } | null>(null);
	let keepNote = $state('');
	let keepOpen = $state(false);
	function askKeep(checks: WarningItem[], other: OtherRow[], at: number | null = null) {
		if (saving) return;
		// Data checks alone keep at once, as before: their kept list holds no note.
		if (!other.length) {
			void keepNow(checks, [], '', at);
			return;
		}
		keepFor = { checks, other, at };
		keepNote = other.length === 1 ? other[0]!.note : '';
		keepOpen = true;
	}
	async function confirmKeep() {
		const k = keepFor;
		if (!k) return;
		keepOpen = false;
		await keepNow(k.checks, k.other, keepNote, k.at);
	}
	async function keepNow(checks: WarningItem[], other: OtherRow[], note: string, at: number | null) {
		const n = checks.length + other.length;
		const ok = await save((fresh, judge) => {
			let patch: SettingsPatch = {};
			if (checks.length) {
				const r = decide(judge(checks), 'keep', fresh);
				if (!r.ok) return { error: r.error };
				patch = r.patch;
			}
			if (other.length) {
				const list = withKept(fresh, other.map((r) => r.id), note);
				if (list && 'error' in list) return list;
				patch = { ...patch, warningsKept: list } as SettingsPatch;
			}
			return { patch, reason: `Warnings: kept ${n === 1 ? (other[0]?.title.toLowerCase() ?? itemsNoun(checks)) : `${n} warnings`}${note.trim() ? ` (${note.trim().slice(0, 80)})` : ''}`, done: `Kept ${n === 1 ? 'it' : `${n} warnings`}.` };
		});
		if (!ok) return;
		if (at !== null && checks.length === 1 && !other.length) await refocus(checks[0]!.id, at, '#warn-rows', 'warn-checks-h');
		else if (at !== null && other.length === 1) await refocus(other[0]!.id, at, other[0]!.source === 'run' ? '#warn-run-list' : '#warn-other', 'warn-other-h');
		else selected = new Set();
	}
	async function reopenOther(r: OtherRow, at: number) {
		if (saving) return;
		const ok = await save((fresh) => {
			const list = withKept(fresh, [r.id], null);
			if (list && 'error' in list) return list;
			return { patch: { warningsKept: list } as SettingsPatch, reason: `Warnings: reopened ${r.title.toLowerCase()}`, done: 'Reopened it.' };
		});
		if (ok) await refocus(r.id, at, r.source === 'run' ? '#warn-run-list' : '#warn-other', 'warn-other-h');
	}
	/** Bulk Reopen: kept data checks, patched or excluded periods, and kept warnings and problems. */
	async function reopenBulk() {
		if (saving || !reopenCount) return;
		const checks = pickedChecks.filter((i) => i.status === 'kept' || i.status === 'patched' || i.status === 'excluded');
		const other = pickedOther.filter((r) => r.state === 'kept');
		const ok = await save((fresh, judge) => {
			let s = fresh;
			let patch: SettingsPatch = {};
			for (const i of judge(checks)) {
				const r = reopen({ ...i, status: itemStatus(i, i.role, s) }, s);
				if (!r) continue;
				patch = { ...patch, ...r.patch };
				s = { ...s, ...r.patch } as ProjectSettings;
			}
			if (other.length) {
				const list = withKept(fresh, other.map((r) => r.id), null);
				if (list && 'error' in list) return list;
				patch = { ...patch, warningsKept: list } as SettingsPatch;
			}
			const n = checks.length + other.length;
			return { patch, reason: `Warnings: reopened ${n} ${n === 1 ? 'warning' : 'warnings'}`, done: `Reopened ${n} ${n === 1 ? 'warning' : 'warnings'}.` };
		});
		if (ok) selected = new Set();
	}

	/** A run warning's one-value fix, saved here. */
	async function applyFix(r: OtherRow, at: number) {
		const a = r.action;
		if (saving || a.kind !== 'setting') return;
		const ok = await save((fresh) => ({ patch: a.patch(fresh, r.params), reason: `Warnings: ${a.label.toLowerCase()}`, done: `Saved: ${a.label.toLowerCase()}.` }));
		if (ok) await refocus(r.id, at, '#warn-run-list', 'warn-run-h');
	}
	/** A feed's Fetch now (POST …/feeds/:id/run-now, an editor's). */
	async function fetchNow(feedId: string) {
		if (saving) return;
		saving = true;
		notice = null;
		try {
			const r = await feedsApi(api, projectId).runNow(feedId);
			notice = { tone: 'ok', text: r.created ? 'Fetching it now: its health updates on Data once the fetch has run.' : 'A fetch is already waiting for it.' };
		} catch (e) {
			notice = { tone: 'error', text: `Couldn’t start the fetch: ${e instanceof Error ? e.message : String(e)}` };
		} finally {
			saving = false;
		}
	}

	// The run shown is older than the settings: rows a fix changed are confirmed by a new run.
	const stale = $derived(!!run && !!project.updatedAt && project.updatedAt > run.createdAt);
	const fixedSinceRun = $derived(warningRows.filter((r) => r.state === 'fixed').length);

	// A link to a part (`#warn-checks`, `#warn-other`, `#warn-run`): the tab is a lazy chunk, so land once drawn.
	onMount(() =>
		followAnchors({
			page: 'warnings',
			land: (hash) => (hash === 'warn-checks' || hash === 'warn-other' || hash === 'warn-run' ? landOnAnchor(hash) : undefined),
			forward: (to) => void goto(to, { replace: true, reset: false })
		})
	);

	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}
	<span data-testid="warnings-context">
		{#if !values}Checking the series…{:else if !items.length}No flagged periods in {fmtNum(series?.length ?? 0)} series{:else}{fmtNum(open)} open of {fmtNum(items.length)} flagged
			{items.length === 1 ? 'period' : 'periods'} in {fmtNum(recordsWithItems)} {recordsWithItems === 1 ? 'record' : 'records'}{/if}{#if elsewhere.length}{' '}·
			{fmtNum(elsewhere.length)} {elsewhere.length === 1 ? 'problem' : 'problems'} elsewhere{/if}
	</span>
{/snippet}
{#snippet headerActions()}
	<!-- To the run's warnings: in place when they show, else the Run warnings source. -->
	<a class="btn" href={runWarningsHref} data-testid="to-run-warnings">Run warnings{runRows.length ? ` (${runRows.length})` : ''}</a>
	<a class="btn" href="?tab=series#data-checks">Data checks on Data</a>
{/snippet}

{#snippet chip(href: string, label: string, n: number | null, current: boolean)}
	<a class="chip" {href} aria-current={current ? 'true' : undefined} data-sveltekit-noscroll data-sveltekit-keepfocus
		>{label}{#if n !== null}{' '}<span class="n">{n}</span>{/if}</a
	>
{/snippet}

{#snippet primary(r: OtherRow, at: number)}
	{@const a = r.action}
	{#if a.kind === 'setting'}
		{#if isEditor && r.state === 'open'}
			<button type="button" class="btn btn-sm btn-primary" data-row-action aria-disabled={saving || undefined} aria-label="{a.label}: {r.detail}" onclick={() => void applyFix(r, at)}
				>{a.label}</button
			>
		{/if}
	{:else if a.kind === 'fetch'}
		<button type="button" class="btn btn-sm btn-primary" data-row-action aria-disabled={saving || undefined} aria-label="{a.label}: {r.title}" onclick={() => void fetchNow(a.feedId)}
			>{a.label}</button
		>
	{:else if a.kind === 'run'}
		<button type="button" class="btn btn-sm btn-primary" data-row-action aria-disabled={running || undefined} onclick={() => !running && onRun?.()}>{running ? 'Running…' : a.label}</button>
	{:else}
		<a class="btn btn-sm go" href={a.href} data-row-action>{a.label}</a>
	{/if}
{/snippet}

{#snippet otherRow(r: OtherRow, at: number)}
	<li data-row={r.id} data-state={r.state} data-source={r.source} class:note={r.severity === 'note'} class:ticked={selected.has(r.id)}>
		{#if isEditor}
			<label class="check pick"
				><input type="checkbox" checked={selected.has(r.id)} onchange={(e) => toggle(r.id, e.currentTarget.checked)} /><span class="visually-hidden">Tick {r.title}: {r.detail}</span></label
			>
		{/if}
		<div class="body">
			<p class="what">
				{#if r.warning !== null}
					<span class="badge" class:badge-warn={r.severity === 'check'}>{r.title}</span>
					<span class="text"><WarningText text={r.warning} placeHref={run ? (place) => warningPlaceHref(place, run.id) : null} /></span>
				{:else}
					<strong>{r.title}</strong>{' '}<span class="text">{r.detail}</span>
				{/if}
			</p>
			<p class="how small"><span class="how-l">How to fix:</span>{' '}{r.how}</p>
			{#if r.state === 'kept'}
				<p class="small kept-note"><span class="pill tone-kept">Kept</span>{#if r.note}{' '}{r.note}{/if}</p>
			{:else if r.state === 'fixed'}
				<p class="small"><span class="pill tone-fixed">Fixed: rerun to confirm</span></p>
			{/if}
		</div>
		<div class="acts">
			{#if r.state !== 'kept'}{@render primary(r, at)}{/if}
			{#if r.action.kind === 'setting' && (!isEditor || r.state !== 'open')}
				<!-- A reader who can't save the fix, or once it is saved: where the setting is. -->
				<a class="btn btn-sm go" href={r.action.href} data-row-action={!isEditor || undefined}>Go to the setting</a>
			{/if}
			{#if isEditor}
				{#if r.state === 'kept'}
					<button type="button" class="btn btn-sm" data-row-action aria-disabled={saving || undefined} aria-label="Reopen: {r.detail}" onclick={() => void reopenOther(r, at)}>Reopen</button>
				{:else}
					<button type="button" class="btn btn-sm" aria-disabled={saving || undefined} aria-label="Keep: {r.detail}" onclick={() => askKeep([], [r], at)}>Keep</button>
				{/if}
			{/if}
		</div>
	</li>
{/snippet}

<div class="warnings" data-testid="warnings">
	<!-- The filters, across every row; each chip says how many rows it would show (filters.ts). -->
	<div class="filter-bar" data-testid="warnings-filters">
		<div class="chips sources" role="group" aria-labelledby="warn-sources-l" data-testid="warnings-sources">
			<span class="group-l muted small" id="warn-sources-l">Source</span>
			{#each SOURCE_FILTERS as s (s)}
				{@const n = s === 'all' ? null : counts.source(s)}
				{#if s === 'all' || s === 'checks' || n || filters.source === s}{@render chip(sourceHref(s), SOURCE_LABEL[s], n, filters.source === s)}{/if}
			{/each}
		</div>
		<div class="chips" role="group" aria-labelledby="warn-status-l" data-testid="warnings-status">
			<span class="group-l muted small" id="warn-status-l">Status</span>
			{#each STATE_FILTERS as s (s)}{@render chip(statusHref(s), STATE_LABEL[s], counts.status(s), filters.status === s)}{/each}
		</div>
		<div class="chips" role="group" aria-labelledby="warn-sev-l" data-testid="warnings-severity">
			<span class="group-l muted small" id="warn-sev-l">Severity</span>
			{@render chip(sevHref(null), 'Both', counts.sev('all'), !filters.sev)}
			{#each ['check', 'note'] as const as s (s)}{@render chip(sevHref(s), SEVERITY_LABEL[s], counts.sev(s), filters.sev === s)}{/each}
		</div>
		<div class="chips" role="group" aria-labelledby="warn-area-l" data-testid="warnings-area">
			<span class="group-l muted small" id="warn-area-l">Area</span>
			{@render chip(areaHref(null), 'All areas', counts.area('all'), !filters.area)}
			{#each AREAS as a (a)}
				{#if counts.area(a) || filters.area === a}{@render chip(areaHref(a), AREA_LABEL[a], counts.area(a), filters.area === a)}{/if}
			{/each}
		</div>
		<div class="pickers">
			<label class="record-pick">
				<span>Record</span>
				<select value={filters.series ?? ''} onchange={(e) => setRecord(e.currentTarget.value)} data-testid="warnings-record">
					<option value="">All records ({recordAll})</option>
					{#each records as r (r.id)}<option value={r.id}>{r.label} ({r.count})</option>{/each}
				</select>
			</label>
			<label class="record-pick search">
				<span>Find</span>
				<input type="search" bind:value={query} onfocus={queryStep.focus} oninput={onQueryInput} placeholder="e.g. flat stretch, CHIRPS" autocomplete="off" data-testid="warnings-search" />
			</label>
		</div>
	</div>

	{#if stale && isEditor}
		<p class="alert alert-info small rerun" role="status" data-testid="warnings-rerun">
			{fixedSinceRun ? `${fixedSinceRun} ${fixedSinceRun === 1 ? 'warning is' : 'warnings are'} fixed in the settings since this run: run` : 'The settings changed since this run: run'} the model to see which warnings remain.
			<button type="button" class="btn btn-sm btn-primary" aria-disabled={running || undefined} onclick={() => !running && onRun?.()}>{running ? 'Running…' : 'Run now'}</button>
		</p>
	{/if}

	{#if isEditor && shownIds.length}
		<!-- One bulk row above the parts (ui-playbook.md § 4): always drawn, so ticking never moves a list; each button names its
		     count and is aria-disabled at none. Keep and Reopen across sources; Patch and Exclude for data checks. -->
		<div class="toolbar bulk" role="toolbar" aria-label="Decide the ticked rows" data-testid="warnings-bulk">
			<span class="picked" aria-live="polite">{pickedCount ? `${fmtNum(pickedCount)} ticked` : 'None ticked'}</span>
			{#if pickedCount < shownIds.length}<button type="button" class="btn btn-sm" onclick={selectAllMatching}>Select all {fmtNum(shownIds.length)} matching</button>{/if}
			{#if pickedCount}<button type="button" class="btn btn-sm" onclick={() => (selected = new Set())}>Clear</button>{/if}
			<span class="sep" aria-hidden="true"></span>
			{#if hasRain}
				<button type="button" class="btn btn-sm btn-primary" aria-disabled={!checkCount('patch') || saving || undefined} onclick={() => void decideBulk('patch')}>Patch {fmtNum(checkCount('patch'))}</button>
			{/if}
			{#if hasFlow}
				<button type="button" class="btn btn-sm btn-primary" aria-disabled={!checkCount('exclude') || saving || undefined} onclick={() => void decideBulk('exclude')}
					>Exclude<span class="visually-hidden">{' '}from calibration</span>{' '}{fmtNum(checkCount('exclude'))}</button
				>
			{/if}
			<button type="button" class="btn btn-sm" aria-disabled={!keepCount || saving || undefined} onclick={() => keepCount && askKeep(pickedChecks.filter((i) => decisionsFor(i).includes('keep')), pickedOther.filter((r) => r.state !== 'kept'))}
				>Keep {fmtNum(keepCount)}</button
			>
			<button type="button" class="btn btn-sm" aria-disabled={!reopenCount || saving || undefined} onclick={() => void reopenBulk()}>Reopen {fmtNum(reopenCount)}</button>
		</div>
	{/if}
	{#if notice}
		<p class="alert notice small" class:alert-error={notice.tone === 'error'} class:alert-info={notice.tone === 'ok'} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="warnings-notice">
			{notice.text}
		</p>
	{/if}

	{#if showChecks}
		<section class="panel" id="warn-checks" aria-labelledby="warn-checks-h" aria-busy={saving || undefined}>
			<div class="panel-head">
				<div class="head-text">
					<div class="h-row"><h2 id="warn-checks-h" tabindex="-1">Data checks</h2><HelpTip key="data-quality-limits" label="About the data checks" /></div>
					<p class="muted small intro">
						Each period a check flagged on a stored series.
						{#if isEditor}Patch rain to read it as missing and fill it, exclude flow from calibration, or keep the values as recorded. Each
							decision saves to the settings at once.{:else}An editor patches rain, excludes flow from calibration or keeps the values as recorded.{/if}
					</p>
				</div>
			</div>
			<LoadState loading={loading && !values} error={loadError} retry={load}>
				{#if failedNames.length}
					<p class="alert alert-warning small" role="status">Couldn’t read {failedNames.join(', ')}: {failedNames.length === 1 ? 'its' : 'their'} periods aren’t listed. <button type="button" class="btn btn-sm" onclick={load}>Try again</button></p>
				{/if}
				{#if runError}
					<p class="alert alert-warning small" role="status">Couldn’t read the shown run: its accumulations, flow double mass and warnings aren’t listed ({runError}).</p>
				{/if}
				{#if !items.length}
					<p class="empty" data-testid="warnings-empty">
						{#if !series?.length}No input series yet: add rain and flow on <a href="?tab=series">Data</a>, and their checks show here.{:else}No data check flags a period
							in the loaded series.{/if}
					</p>
				{:else}
					<div class="chips kinds" role="group" aria-label="Check">
						{@render chip(checkHref(null), 'All checks', checksAll, !checkKind)}
						{#each checkKinds as c (c.check)}{@render chip(checkHref(c.check), CHECK_LABEL[c.check], c.count, checkKind === c.check)}{/each}
					</div>
					{#if !checksShown.length}
						<p class="empty" data-testid="warnings-none">
							{filters.status === 'open' ? 'Nothing open' : 'Nothing'} matches these filters. <a href={everyHref} data-sveltekit-noscroll>Show every period</a>
						</p>
					{:else}
						<div class="table-wrap">
							<table class="data rows" data-testid="warnings-table">
								<caption class="visually-hidden">Flagged periods, in date order</caption>
								<thead>
									<tr>
										{#if isEditor}
											<th scope="col" class="c-pick">
												<label class="check"
													><input type="checkbox" checked={allVisiblePicked} onchange={(e) => toggleVisible(e.currentTarget.checked)} /><span class="visually-hidden"
														>Tick every period shown</span
													></label
												>
											</th>
										{/if}
										<th scope="col">Period</th>
										<th scope="col">Record</th>
										<th scope="col">What the check saw</th>
										<th scope="col">Status</th>
										{#if isEditor}<th scope="col"><span class="visually-hidden">Decision</span></th>{/if}
									</tr>
								</thead>
								<tbody id="warn-rows">
									{#each visible as i, at (i.id)}
										{@const what = `${CHECK_LABEL[i.check]}, ${i.record}, ${periodText(i)}`}
										{@const href = settingHref(i)}
										<tr data-item={i.id} data-row={i.id} data-status={i.status} class:ticked={selected.has(i.id)}>
											{#if isEditor}
												<td class="c-pick">
													<label class="check"
														><input type="checkbox" checked={selected.has(i.id)} onchange={(e) => toggle(i.id, e.currentTarget.checked)} /><span class="visually-hidden"
															>Tick {what}</span
														></label
													>
												</td>
											{/if}
											<th scope="row" class="c-period">
												<span class="when">{periodText(i)}</span>
												<span class="sub">{daysText(i.days)}</span>
											</th>
											<td class="c-record"><span class="cell-label">Record:{' '}</span>{i.record}</td>
											<td class="c-what">
												<span class="badge badge-warn">{CHECK_LABEL[i.check]}</span>
												<span class="sub">{whatText(i)}</span>
											</td>
											<td class="c-status">
												<span class="pill tone-{i.status}">{STATUS_LABEL[i.status]}</span>
												<span class="sub">{statusDetail(i)}{#if href}{' '}<a href={href}>In settings</a>{/if}</span>
											</td>
											{#if isEditor}
												<td class="c-act">
													<div class="row-actions">
														{#each decisionsFor(i) as d, k (d)}
															<button
																type="button"
																class="btn btn-sm"
																data-row-action={k === 0 ? '' : undefined}
																aria-disabled={saving || undefined}
																aria-label="{DECISION_LABEL[d]}: {what}"
																onclick={() => void (d === 'keep' ? askKeep([i], [], at) : decideRow(i, d, at))}>{d === 'exclude' ? 'Exclude' : DECISION_LABEL[d]}</button
															>
														{:else}
															<button type="button" class="btn btn-sm" data-row-action aria-disabled={saving || undefined} aria-label="Reopen: {what}" onclick={() => void decideRow(i, 'reopen', at)}
																>Reopen</button
															>
														{/each}
													</div>
												</td>
											{/if}
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if checksShown.length > FOLD}
							<button type="button" class="btn btn-sm fold" aria-expanded={allShown} aria-controls="warn-rows" onclick={() => (allShown = !allShown)}
								>{allShown ? `Show only the first ${FOLD} periods` : `Show all ${fmtNum(checksShown.length)} periods`}</button
							>
						{/if}
					{/if}
				{/if}
			</LoadState>
		</section>
	{/if}

	{#if showOther}
		<section class="panel" id="warn-other" aria-labelledby="warn-other-h" data-testid="warn-other" aria-busy={saving || undefined}>
			<div class="panel-head">
				<div class="head-text">
					<h2 id="warn-other-h" tabindex="-1">Problems elsewhere</h2>
					<p class="muted small intro">What other pages show as needing attention: each with how to fix it and the way there, or kept once you accept it.</p>
				</div>
			</div>
			{#if feedsError}
				<p class="alert alert-warning small" role="status">
					Couldn’t read the data feeds: {feedsError}
					<button type="button" class="btn btn-sm" onclick={() => void loadFeeds()}>Try again</button>
				</p>
			{:else if feeds === null}
				<p class="muted small" role="status">Reading the data feeds…</p>
			{/if}
			{#if !groups.length}
				<p class="empty" data-testid="warn-other-none">
					{problemRows.length ? 'Nothing here matches these filters.' : 'Nothing elsewhere needs attention: the model, the unsaved settings, the data feeds, the data’s dates and the runs are clear.'}
				</p>
			{:else}
				{#each groups as g, gi (g.source)}
					{@const list = otherAll || gi > 0 ? g.list : g.list.slice(0, LIST_FOLD)}
					<h3 class="group-h">{SOURCE_LABEL[g.source]} <span class="n">{g.list.length}</span></h3>
					<ul class="row-list" data-source={g.source}>
						{#each list as r, at (r.id)}{@render otherRow(r, at)}{/each}
					</ul>
					{#if gi === 0 && g.list.length > LIST_FOLD}
						<button type="button" class="btn btn-sm fold" aria-expanded={otherAll} onclick={() => (otherAll = !otherAll)}
							>{otherAll ? `Show only the first ${LIST_FOLD} problems` : `Show all ${fmtNum(g.list.length)} problems`}</button
						>
					{/if}
				{/each}
			{/if}
		</section>
	{/if}

	{#if showRun}
		<section class="panel" id="warn-run" aria-labelledby="warn-run-h" aria-busy={saving || undefined}>
			<div class="panel-head">
				<div class="head-text">
					<h2 id="warn-run-h" tabindex="-1">Run warnings</h2>
					<p class="muted small intro" data-testid="warn-run-line">
						{#if run}From {run.label || 'Untitled run'}, ran {fmtWhen(run.createdAt)}: things to check first, then notes on how the data were handled, each
							with how to fix it.{:else}No run yet.{/if}
					</p>
				</div>
			</div>
			{#if run && summaryFor !== run.id && !runError}
				<p class="muted" role="status">Loading the run’s warnings…</p>
			{:else if run && summaryFor === run.id}
				{#if !runRows.length}
					<p class="empty" data-testid="warn-run-none">This run raised no warnings.</p>
				{:else if !warningsShown.length}
					<p class="empty" data-testid="warn-run-filtered">No run warning matches these filters.</p>
				{:else}
					<ul class="row-list" id="warn-run-list" data-testid="warn-run-list">
						{#each warningsVisible as r, at (r.id)}{@render otherRow(r, at)}{/each}
					</ul>
					{#if warningsShown.length > LIST_FOLD}
						<button type="button" class="btn btn-sm fold" aria-expanded={runAll} aria-controls="warn-run-list" onclick={() => (runAll = !runAll)}
							>{runAll ? `Show only the first ${LIST_FOLD} run warnings` : `Show all ${fmtNum(warningsShown.length)} run warnings`}</button
						>
					{/if}
				{/if}
			{/if}
		</section>
	{/if}
</div>

<Dialog bind:open={keepOpen} title={keepFor && keepFor.checks.length + keepFor.other.length > 1 ? `Keep ${keepFor.checks.length + keepFor.other.length} warnings` : 'Keep this warning'}>
	<div class="field">
		<label for="warn-keep-note">Why (optional)</label>
		<textarea id="warn-keep-note" rows="3" maxlength={WARNING_KEPT_NOTE_MAX} bind:value={keepNote} placeholder="e.g. Expected: this gauge closed in 2019"></textarea>
		<span class="hint">Kept rows stay listed under Kept, with this note, and can be reopened.</span>
	</div>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (keepOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" onclick={() => void confirmKeep()}>Keep</button>
	{/snippet}
</Dialog>

<style>
	.warnings {
		container: warnings / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.warnings > .panel {
		margin: 0;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.h-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.h-row h2,
	#warn-run-h {
		margin: 0;
	}
	.intro {
		margin: 0;
		max-width: 90ch;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin: 0.5rem 0 0.6rem;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 32px;
		padding: 0.2rem 0.65rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		color: var(--text-2);
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 600;
		background: var(--surface);
		white-space: nowrap;
	}
	.chip:hover {
		border-color: var(--accent);
	}
	.chip[aria-current='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.chip .n {
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}
	.record-pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.record-pick select {
		max-width: 22rem;
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.5rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}
	.picked {
		font-weight: 600;
		min-width: 6.5rem;
	}
	.sep {
		width: 1px;
		align-self: stretch;
		background: var(--border);
		margin: 0 0.2rem;
	}
	.notice {
		margin: 0 0 0.5rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius);
	}
	/* The page flows in the window's one scroll: the rows don't scroll in a box of their own (folded instead). */
	.table-wrap {
		max-height: none;
	}
	.rows tbody th,
	.rows tbody td {
		vertical-align: top;
	}
	.rows tbody th {
		font-weight: 600;
	}
	tr.ticked > * {
		background: var(--accent-soft);
	}
	.c-pick {
		width: 2.2rem;
	}
	.c-pick .check {
		min-height: 24px;
		align-items: center;
	}
	.when {
		white-space: nowrap;
	}
	.sub {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-2);
		font-weight: 400;
	}
	.c-what .badge {
		margin-bottom: 0.15rem;
	}
	.c-status {
		min-width: 12rem;
	}
	.c-act {
		white-space: nowrap;
	}
	.row-actions {
		display: flex;
		gap: 0.3rem;
		justify-content: flex-end;
	}
	/* The status in words; the tone repeats it. */
	.pill {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-size: var(--font-sm);
		font-weight: 600;
		line-height: 1.4;
		background: var(--surface-2);
		color: var(--text-2);
		white-space: nowrap;
	}
	.tone-open {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.tone-patched,
	.tone-excluded {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}
	.tone-handled {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.fold {
		margin-top: 0.5rem;
	}
	.empty {
		margin: 0.5rem 0 0;
		color: var(--text-2);
	}
	.sources {
		margin: 0;
		align-items: center;
	}
	.sources-l {
		margin-right: 0.15rem;
		font-weight: 600;
	}
	.group-h {
		margin: 0.6rem 0 0.3rem;
		font-size: 0.95rem;
	}
	.group-h .n {
		font-weight: 400;
		color: var(--text-2);
	}
	.cell-label {
		display: none;
	}
	/* Narrow (under 640 px): each period a card; the page scrolls, not a box inside it (Applications' pattern). */
	@container warnings (max-width: 45.7rem) {
		.table-wrap {
			max-height: none;
			border: 0;
			background: none;
		}
		.rows thead {
			display: none;
		}
		.rows,
		.rows tbody {
			display: block;
		}
		.rows tbody {
			display: grid;
			gap: 0.6rem;
		}
		.rows tr {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas:
				'pick period'
				'pick record'
				'pick what'
				'pick status'
				'act act';
			gap: 0.3rem 0.6rem;
			padding: 0.65rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--surface);
		}
		.rows tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
			background: none;
		}
		tr.ticked {
			background: var(--accent-soft);
			border-color: var(--accent);
		}
		.c-pick {
			grid-area: pick;
			width: auto;
		}
		.c-period {
			grid-area: period;
		}
		.c-record {
			grid-area: record;
		}
		.c-what {
			grid-area: what;
		}
		.c-status {
			grid-area: status;
			min-width: 0;
		}
		.c-act {
			grid-area: act;
			white-space: normal;
		}
		.row-actions {
			justify-content: flex-start;
		}
		/* The bulk row: the count and Select all on one line, the decisions sharing the next. */
		.bulk .sep {
			flex-basis: 100%;
			height: 0;
			width: auto;
			margin: 0;
			background: none;
		}
		.bulk > .btn {
			min-height: 44px;
		}
		.bulk .sep ~ .btn {
			flex: 1 1 0;
		}
		.row-actions .btn {
			min-height: 44px;
			flex: 1 1 0;
		}
		.cell-label {
			display: inline;
			color: var(--text-2);
		}
		.when {
			white-space: normal;
		}
	}

	.filter-bar {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.group-l {
		font-weight: 600;
		min-width: 4.5rem;
	}
	.chips {
		align-items: center;
	}
	.pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
	}
	.search input {
		width: 16rem;
		max-width: 100%;
	}
	.kinds {
		margin: 0.5rem 0 0.6rem;
	}
	.rerun {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.75rem;
		margin: 0;
	}
	.row-list {
		list-style: none;
		margin: 0.4rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}
	.row-list li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.3rem 0.6rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--warning);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.row-list li.note {
		border-left-color: var(--border-strong);
	}
	.row-list li[data-state='kept'] {
		border-left-color: var(--border);
	}
	.row-list li[data-state='fixed'] {
		border-left-color: var(--success);
	}
	.row-list li.ticked {
		background: var(--accent-soft);
	}
	.row-list .pick {
		min-height: 24px;
	}
	.row-list .body {
		grid-column: 2;
		min-width: 0;
	}
	.row-list li:not(:has(.pick)) .body {
		grid-column: 1 / 3;
	}
	.row-list .what,
	.row-list .how,
	.row-list .kept-note {
		margin: 0;
		overflow-wrap: break-word;
	}
	.row-list .how {
		margin-top: 0.2rem;
		color: var(--text-2);
	}
	.how-l {
		font-weight: 600;
		color: var(--text);
	}
	.row-list .kept-note,
	.row-list .body > .small {
		margin-top: 0.25rem;
	}
	.acts {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.3rem;
	}
	.acts .go {
		white-space: nowrap;
	}
	.tone-kept {
		background: var(--surface-2);
	}
	.tone-fixed {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	@container warnings (max-width: 45.7rem) {
		.row-list li {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.acts {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}
		.acts .btn {
			min-height: 44px;
		}
	}
</style>
