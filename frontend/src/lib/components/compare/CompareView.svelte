<script lang="ts">
	// Compare runs (issue #17, board A4): a baseline and up to two what-ifs,
	// same project or projects you can see. Shown by the /compare page and by
	// the workspace's Compare runs tab, each owning its URL: the runs arrive as
	// `a` (baseline), `b` (what-if 1) and the optional `c` (what-if 2) refs
	// ("<projectId>:<runId>"), and `hrefFor` builds the URL for a new choice.
	// With `project` and no pair, it opens on that project's latest run
	// against its published baseline (or, with none, the previous run).
	//
	// The backend compares two runs, so each what-if is its own
	// GET /compare/runs against the baseline (in parallel). The summary (run
	// cards, outcomes table, takeaways, days below the reserve each year) sits
	// on top; the full two-run comparison, for the baseline against the
	// what-if picked, stays below it with nothing left out.
	//
	// Inside the workspace the section header is the page title: the view puts
	// its context line and its actions (Export impact report, + New what-if)
	// there with fillHeader and draws no title of its own. The standalone page
	// has no section header, so it keeps the view's own h1 with the same
	// actions beside it.
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api, ApiError, hasRole, type ProjectSummary, type RunCompareResponse, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import { attributionSummary, historyHref, lineAuthors } from '$lib/components/compare/attribution';
	import Delta from '$lib/components/compare/Delta.svelte';
	import EwrAgreementCompare from '$lib/components/compare/EwrAgreementCompare.svelte';
	import EwrAssuranceCompare from '$lib/components/compare/EwrAssuranceCompare.svelte';
	import FarmDeltaTable from '$lib/components/compare/FarmDeltaTable.svelte';
	import HeadlineDeltas from '$lib/components/compare/HeadlineDeltas.svelte';
	import FitValidationCompare from '$lib/components/compare/FitValidationCompare.svelte';
	import PlausibilityCompare from '$lib/components/compare/PlausibilityCompare.svelte';
	import { chirpsFitNote } from '$lib/components/compare/chirpsFit';
	import { fmtMetric } from '$lib/components/compare/delta';
	import { rainSourceNote } from '$lib/components/compare/rainSource';
	import { asFitRecord } from '$lib/components/compare/fit';
	import { compareDamStorage, leadChange, outcomeRows, takeaways } from '$lib/components/compare/summary';
	import { apanDailyOfInput, chirpsSourceOfInput } from '$lib/series/provenance';
	import RunPicker from '$lib/components/compare/RunPicker.svelte';
	import { defaultPair, defaultRunFor, defaultWhatIf, formatRef, parseRef, publishedBaseline, type RunRef } from '$lib/components/compare/picker';
	import { compareEvidenceNote } from '$lib/components/runs/evidence';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { runYears } from '$lib/components/runs/runList';
	import { fmtDate } from '$lib/format/number';

	// Every comparison renders the paired uncertainty band (issue #4 phase 9), the daily series
	// overlay (issue #8) and the days below the reserve each year (issue #17 A4), so they are static
	// imports: the band sits in this chunk (tab chunks have their own ceiling,
	// scripts/guards/check_web_bundle_budget.mjs), and the overlay and the reserve years, which the
	// Scenarios and River & reserve tabs load lazily, stay shared chunks this one preloads.
	import PairedUncertaintyPanel from '$lib/components/uncertainty/PairedUncertaintyPanel.svelte';
	import CompareOverlay from '$lib/components/compare/CompareOverlay.svelte';
	import ReserveYearsChart from '$lib/components/compare/ReserveYearsChart.svelte';
	// A scenario run's overrides (issue #18): their own chunk, fetched only when a side is a scenario run.
	const loadOverrides = () => import('$lib/components/scenarios/ScenarioOverrides.svelte');
	const runoffModelOf = (s: RunCompareResponse['a']) => (s.run.inputs.settings?.runoffModel as string | undefined) ?? 'legacy';

	type Side = 'a' | 'b' | 'c';
	type WhatIf = 'b' | 'c';
	const WHAT_IFS: readonly WhatIf[] = ['b', 'c'];
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	/** Names and colours of the runs, the same in the cards, the table and the chart. */
	const NAME: Record<Side, string> = { a: 'Baseline', b: 'What-if 1', c: 'What-if 2' };
	const COLOUR: Record<Side, string> = { a: 'var(--text-muted)', b: 'var(--series-2)', c: 'var(--series-1)' };

	let {
		a: aParam,
		b: bParam,
		c: cParam = null,
		project: projectParam,
		hrefFor,
		level = 2,
		actions,
		projectA: shownProjectA = $bindable(null)
	}: {
		/** The baseline's ref from the URL (null when not chosen). */
		a: string | null;
		/** What-if 1's ref from the URL. */
		b: string | null;
		/** What-if 2's ref from the URL (optional). */
		c?: string | null;
		/** The project to open on when no pair is given (null: none). */
		project: string | null;
		/** The URL for a choice of runs (any may be null). */
		hrefFor: (a: RunRef | null, b: RunRef | null, c: RunRef | null) => string;
		/** 1: the standalone page, with its own title. 2: inside the workspace, where its context line goes to the section header and it draws no title. */
		level?: 1 | 2;
		/** Links beside the title (the standalone page's Back to runs). */
		actions?: Snippet;
		/** Out: the project on side A, for the page's own links. */
		projectA?: string | null;
	} = $props();

	const refA = $derived(parseRef(aParam));
	const refB = $derived(parseRef(bParam));
	const refC = $derived(parseRef(cParam));
	const refOf = (side: Side) => (side === 'a' ? refA : side === 'b' ? refB : refC);

	// --- projects -------------------------------------------------------------
	let projects = $state<ProjectSummary[]>([]);
	let projectsLoading = $state(true);
	let projectsError = $state<string | null>(null);
	async function loadProjects() {
		projectsLoading = true;
		projectsError = null;
		try {
			projects = await api.projects.list();
		} catch (e) {
			projectsError = msg(e);
		} finally {
			projectsLoading = false;
		}
	}
	onMount(loadProjects);

	// --- runs per project (cached) ---------------------------------------------
	let runs = $state<Record<string, RunMeta[]>>({});
	let runsLoading = $state<Record<string, boolean>>({});
	let runsError = $state<Record<string, string>>({});
	const inflight = new Map<string, Promise<RunMeta[] | null>>();
	function ensureRuns(projectId: string): Promise<RunMeta[] | null> {
		if (runs[projectId]) return Promise.resolve(runs[projectId]!);
		let p = inflight.get(projectId);
		if (!p) {
			p = fetchRuns(projectId).finally(() => inflight.delete(projectId));
			inflight.set(projectId, p);
		}
		return p;
	}
	async function fetchRuns(projectId: string): Promise<RunMeta[] | null> {
		runsLoading[projectId] = true;
		delete runsError[projectId];
		try {
			const list = await api.runs.list(projectId);
			runs[projectId] = list;
			return list;
		} catch (e) {
			runsError[projectId] = e instanceof ApiError && e.status === 404 ? 'Project not found or not shared with you' : msg(e);
			return null;
		} finally {
			runsLoading[projectId] = false;
		}
	}

	// A project picked for a run before a run is chosen for it.
	let picked = $state<Record<Side, string | null>>({ a: null, b: null, c: null });
	const projectFor = (side: Side) => picked[side] ?? refOf(side)?.projectId ?? (side === 'c' ? refA?.projectId : null) ?? projectParam ?? null;
	const projectA = $derived(projectFor('a'));
	const projectB = $derived(projectFor('b'));
	const projectC = $derived(projectFor('c'));
	// What-if 2's card shows once it is in the URL, or while its run is being picked.
	const showC = $derived(!!refC || picked.c !== null);

	$effect(() => {
		for (const p of [projectA, projectB, showC ? projectC : null]) if (p) untrack(() => ensureRuns(p));
	});
	$effect(() => {
		shownProjectA = projectA;
	});

	function navigate(a: RunRef | null, b: RunRef | null, c: RunRef | null, replace = false) {
		return goto(hrefFor(a, b, c), { replaceState: replace, keepFocus: true, noScroll: true });
	}
	/** The current runs with one replaced. */
	function withRun(side: Side, ref: RunRef | null): [RunRef | null, RunRef | null, RunRef | null] {
		return [side === 'a' ? ref : refA, side === 'b' ? ref : refB, side === 'c' ? ref : refC];
	}

	// Opened with ?project= only: latest run vs the published baseline, or the previous run (picker.ts defaultPair).
	let resolving = $state(false);
	$effect(() => {
		const p = projectParam;
		if (!p || refA || refB) return;
		untrack(async () => {
			resolving = true;
			const list = await ensureRuns(p);
			resolving = false;
			const pair = list && defaultPair(p, list);
			if (pair && projectParam === p && !aParam) navigate(pair.a, pair.b, refC, true);
		});
	});

	function defaultFor(side: Side, list: RunMeta[], projectId: string): string | null {
		if (side === 'c') return defaultWhatIf(list, [refA, refB], projectId) ?? list[0]?.id ?? null;
		return defaultRunFor(list, side === 'a' ? refB : refA, projectId);
	}

	async function onProject(side: Side, projectId: string) {
		picked[side] = projectId;
		const list = await ensureRuns(projectId);
		if (!list || picked[side] !== projectId) return;
		const runId = defaultFor(side, list, projectId);
		if (!runId) return; // no runs: the picker says so
		picked[side] = null;
		navigate(...withRun(side, { projectId, runId }));
	}

	function onRun(side: Side, runId: string) {
		const projectId = projectFor(side);
		if (!projectId || !runId) return;
		picked[side] = null;
		navigate(...withRun(side, { projectId, runId }));
	}

	// Add a second what-if: the newest run that is neither the baseline nor what-if 1; the card waits for a choice when there is none.
	async function addWhatIf() {
		const projectId = projectA ?? projectParam;
		if (!projectId) return;
		picked.c = projectId;
		const list = await ensureRuns(projectId);
		const runId = list && picked.c === projectId ? defaultWhatIf(list, [refA, refB], projectId) : null;
		if (runId) {
			await navigate(...withRun('c', { projectId, runId }));
			picked.c = null;
		}
		await tick();
		document.getElementById('c-run')?.focus();
	}
	async function removeWhatIf() {
		picked.c = null;
		if (fullSide === 'c') fullSide = 'b';
		if (refC) await navigate(refA, refB, null);
		await tick();
		document.getElementById('add-what-if')?.focus();
	}

	// "Compare with published": the baseline becomes what-if 1's project's published run, offered only when that changes the pair.
	const withPublished = $derived(publishedBaseline(refB ? runs[refB.projectId] : undefined, refA, refB));

	// --- the comparisons: baseline against each what-if ----------------------------
	interface Cmp {
		data: RunCompareResponse | null;
		loading: boolean;
		error: string | null;
	}
	let cmp = $state<Record<WhatIf, Cmp>>({ b: { data: null, loading: false, error: null }, c: { data: null, loading: false, error: null } });
	const wantKey: Record<WhatIf, string> = { b: '', c: '' };
	async function loadCompare(slot: WhatIf, a: RunRef, x: RunRef) {
		const key = `${formatRef(a)}|${formatRef(x)}`;
		wantKey[slot] = key;
		cmp[slot].loading = true;
		cmp[slot].error = null;
		try {
			const d = await api.compare.runs(formatRef(a), formatRef(x));
			if (wantKey[slot] === key) cmp[slot].data = d;
		} catch (e) {
			if (wantKey[slot] !== key) return;
			cmp[slot].data = null;
			cmp[slot].error =
				e instanceof ApiError && e.status === 404 ? "One of these runs doesn't exist any more, or its project isn't shared with you." : msg(e);
		} finally {
			if (wantKey[slot] === key) cmp[slot].loading = false;
		}
	}
	function clear(slot: WhatIf) {
		wantKey[slot] = '';
		cmp[slot] = { data: null, loading: false, error: null };
	}
	$effect(() => {
		const a = refA;
		const b = refB;
		untrack(() => (a && b ? loadCompare('b', a, b) : clear('b')));
	});
	$effect(() => {
		const a = refA;
		const c = refC;
		untrack(() => (a && c ? loadCompare('c', a, c) : clear('c')));
	});

	// The what-ifs in the summary: what-if 1, and what-if 2 once its comparison is in.
	const whatIfs = $derived(WHAT_IFS.filter((s) => cmp[s].data && refOf(s)));
	const loaded = $derived(whatIfs.map((s) => cmp[s].data!));
	const rows = $derived(
		outcomeRows(
			loaded.map((d) => d.comparison),
			loaded.map((d) => compareDamStorage(d))
		)
	);
	const notes = $derived(
		takeaways(
			rows,
			whatIfs.map((s) => NAME[s]),
			{ samePeriod: loaded.map((d) => d.comparison.samePeriod), engineChanged: loaded.map((d) => d.comparison.engineVersionChanged) }
		)
	);
	const lead = $derived(notes.find((t) => t.tone === 'worse') ?? notes.find((t) => t.tone === 'better') ?? notes[0] ?? null);

	// The full comparison: the baseline against the what-if picked (what-if 1 unless what-if 2 is picked and loaded).
	let fullSide = $state<WhatIf>('b');
	const shownSide = $derived<WhatIf>(fullSide === 'c' && refC ? 'c' : 'b');
	const data = $derived(cmp[shownSide].data);
	const loading = $derived(cmp[shownSide].loading);
	const error = $derived(cmp[shownSide].error);
	const refX = $derived(shownSide === 'c' ? refC : refB);

	function showAllChanges(side: WhatIf) {
		fullSide = side;
		tick().then(() => document.getElementById('changes-h')?.scrollIntoView({ block: 'start' }));
	}

	// Only-one-run / no-runs empty state for the project the page was opened on.
	const soloProject = $derived(!refA && !refB && projectParam ? projectParam : null);
	const soloRuns = $derived(soloProject ? runs[soloProject] : undefined);
	const soloName = $derived(projects.find((p) => p.id === soloProject)?.name ?? 'This project');

	const sameRun = $derived(!!refA && !!refX && formatRef(refA) === formatRef(refX));
	const describe = (s: RunCompareResponse['a']) =>
		`${s.run.label || 'Untitled run'} · ${s.project.name} · ${s.run.startDate} → ${s.run.endDate} · run ${fmtDate(s.run.createdAt, true)}`;

	// --- the header's context line and the cards ---------------------------------
	const runMeta = (side: Side) => {
		const r = refOf(side);
		return r ? (runs[r.projectId]?.find((x) => x.id === r.runId) ?? null) : null;
	};
	const baseSide = $derived(cmp.b.data?.a ?? cmp.c.data?.a ?? null);
	const context = $derived.by(() => {
		if (!baseSide || !loaded.length) return 'Pick a baseline and up to two what-ifs, from this project or a copy of it. Every change is shown against the baseline.';
		const sides = [baseSide, ...loaded.map((d) => d.b)];
		const same = loaded.every((d) => d.comparison.samePeriod);
		const engines = [...new Set(sides.map((s) => s.run.engineVersion))];
		const n = loaded.length;
		return [
			`Baseline “${baseSide.run.label || 'Untitled run'}” against ${n === 1 ? 'one what-if' : `${n} what-ifs`}`,
			same ? `same period, ${runYears(baseSide.run.startDate, baseSide.run.endDate)}` : 'the periods differ',
			engines.length === 1 ? `engine ${engines[0]}` : `engines ${engines.join(', ')}`
		].join(' · ');
	});
	const baseLine = $derived.by(() => {
		const m = runMeta('a');
		if (!m) return '';
		const tags = [runYears(m.startDate, m.endDate), `ran ${fmtDate(m.createdAt, true)}`];
		if (m.published) tags.push('published');
		if (m.evidence === 'current') tags.push('evidence');
		if (refA && projectA && refA.projectId !== (refB?.projectId ?? refA.projectId)) tags.push(projects.find((p) => p.id === refA.projectId)?.name ?? '');
		return tags.filter(Boolean).join(' · ');
	});
	const chartRuns = $derived(
		refA
			? [
					{ name: NAME.a, projectId: refA.projectId, runId: refA.runId, colour: COLOUR.a },
					...whatIfs.map((s) => ({ name: NAME[s], projectId: refOf(s)!.projectId, runId: refOf(s)!.runId, colour: COLOUR[s] }))
				]
			: []
	);
	const H = $derived(`h${level}`);

	// --- the actions: Export impact report and + New what-if ------------------------
	/**
	 * A what-if's impact report: the printable report of its run
	 * (routes/projects/[id]/report) with an "Impact against the baseline"
	 * section first (`against`), so it can be saved as a PDF or handed round.
	 */
	function reportHref(side: WhatIf): string | null {
		const r = refOf(side);
		if (!r || !refA) return null;
		return `${base}/projects/${r.projectId}/report?${new URLSearchParams({ run: r.runId, against: formatRef(refA) })}`;
	}
	const reports = $derived(
		whatIfs.flatMap((s) => {
			const href = reportHref(s);
			return href ? [{ side: s, href, label: cmp[s].data?.b.run.label || 'Untitled run' }] : [];
		})
	);
	/**
	 * + New what-if: the Scenarios tab's create dialog (`new=1`) in the
	 * baseline's project, on the baseline (`base`) when it is a run of the
	 * model (a scenario run can't be a scenario's base). For whoever can edit
	 * that project; its run then compares here like any other.
	 */
	const newWhatIfProject = $derived(refA?.projectId ?? projectA);
	const canNewWhatIf = $derived(!!newWhatIfProject && hasRole(projects.find((p) => p.id === newWhatIfProject)?.role, 'editor'));
	const newWhatIfHref = $derived.by(() => {
		const q = new URLSearchParams({ tab: 'scenarios', new: '1' });
		const m = runMeta('a');
		if (refA && m && !m.scenarioId) q.set('base', refA.runId);
		return `${base}/projects/${newWhatIfProject}?${q}`;
	});

	// Export impact report with two what-ifs is a menu (Escape and a click outside close it, as the Network's Grids).
	let exportEl: HTMLDetailsElement | undefined = $state();
	let exportOpen = $state(false);
	function closeExport() {
		if (exportEl) exportEl.open = false;
	}
	function exportKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !exportEl?.open) return;
		e.preventDefault();
		closeExport();
		exportEl.querySelector('summary')?.focus();
	}
	$effect(() => {
		if (!exportOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (exportEl && !exportEl.contains(e.target as Node)) closeExport();
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});

	// In the workspace the section header carries the context line and the actions.
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }, level === 2));
</script>

{#snippet headerContext()}<span data-testid="compare-context">{context}</span>{/snippet}
{#snippet headerActions()}
	{#if reports.length === 1}
		<a class="btn" href={reports[0]!.href}>Export impact report</a>
	{:else if reports.length > 1}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<details class="export-menu" bind:open={exportOpen} bind:this={exportEl} onkeydown={exportKeydown}>
			<summary class="btn">Export impact report <span aria-hidden="true">▾</span></summary>
			<div class="export-pop" role="group" aria-label="Impact report of">
				{#each reports as r (r.side)}
					<a href={r.href} onclick={closeExport}><span class="key" style:background={COLOUR[r.side]} aria-hidden="true"></span>{NAME[r.side]}: {r.label}</a>
				{/each}
			</div>
		</details>
	{/if}
	{#if canNewWhatIf}<a class="btn" href={newWhatIfHref}>+ New what-if</a>{/if}
{/snippet}

{#if level === 1}
	<header class="cmp-head">
		<div class="cmp-title">
			<svelte:element this={H} id="compare-title">Compare runs</svelte:element>
			<p class="muted">{@render headerContext()}</p>
		</div>
		<div class="cmp-actions">
			{#if actions}{@render actions()}{/if}
			{@render headerActions()}
		</div>
	</header>
{/if}

{#snippet card(side: Side)}
	{@const pid = side === 'a' ? projectA : side === 'b' ? projectB : projectC}
	{@const ref = refOf(side)}
	{@const meta = runMeta(side)}
	<RunPicker
		id={side}
		legend={NAME[side]}
		colour={COLOUR[side]}
		{projects}
		projectId={pid}
		runId={ref?.runId ?? null}
		runs={pid ? (runs[pid] ?? null) : null}
		runsLoading={!!(pid && runsLoading[pid])}
		runsError={pid ? (runsError[pid] ?? null) : null}
		onProject={(p) => onProject(side, p)}
		onRun={(r) => onRun(side, r)}
	>
		{#snippet actions()}
			{#if side === 'c'}<button type="button" class="btn btn-ghost btn-sm" onclick={removeWhatIf}>Remove<span class="visually-hidden"> what-if 2</span></button>{/if}
		{/snippet}
		{#snippet summary()}
			<p class="run-name">{meta ? meta.label || 'Untitled run' : ref ? '…' : 'No run chosen'}</p>
			{#if side === 'a'}
				<p class="run-line muted">{baseLine}</p>
			{:else}
				{@const d = cmp[side].data}
				{#if d && ref}
					{@const first = leadChange(d.changes)}
					<p class="run-line muted" data-testid="what-if-change">
						{#if first}{first.text}{:else if d.b.scenario}Scenario “{d.b.scenario.name}”{:else}No input changes from the baseline{/if}
						{#if d.changes.length > 1}
							· <button type="button" class="link-btn" onclick={() => showAllChanges(side)}>all {d.changes.length} changes</button>
						{/if}
					</p>
				{:else if cmp[side].error}
					<p class="run-line err" role="alert">{cmp[side].error}</p>
				{:else if cmp[side].loading}
					<p class="run-line muted">Comparing with the baseline…</p>
				{/if}
			{/if}
		{/snippet}
	</RunPicker>
{/snippet}

<LoadState loading={projectsLoading} error={projectsError} retry={loadProjects} empty={projects.length === 0} emptyText="You don't have any projects yet.">
	<section class="cards" aria-label="Runs being compared">
		{@render card('a')}
		{@render card('b')}
		{#if showC}
			{@render card('c')}
		{:else}
			<div class="add-card">
				<button type="button" class="btn" id="add-what-if" disabled={!refA || !refB} onclick={addWhatIf}>+ Add a second what-if</button>
				<p class="muted small">Compare two changes against the same baseline, side by side.</p>
			</div>
		{/if}
	</section>
	{#if withPublished}
		<p class="with-published">
			<button type="button" class="btn btn-sm" onclick={() => navigate(withPublished, refB, refC)}>Compare with published</button>
			<span class="muted small">Sets the baseline to the published run, the one stakeholders see.</span>
		</p>
	{/if}

	{#if soloProject && soloRuns && soloRuns.length < 2}
		<div class="panel empty" role="status">
			{#if soloRuns.length === 0}
				<h2>No runs to compare yet</h2>
				<p>{soloName} hasn't been run. Run the model, change something (raise a dam, change crops, add a transfer), run it again, then compare the two.</p>
			{:else}
				<h2>Only one run so far</h2>
				<p>
					{soloName} has a single run. Change something in the model and run it again to compare — or pick a run from
					another project (for example a copy of this one) as what-if 1 above.
				</p>
			{/if}
			<a class="btn" href="{base}/projects/{soloProject}?tab=runs">Go to the project's runs</a>
		</div>
	{:else if !refA || !refB}
		{#if !resolving}
			<div class="panel empty muted" role="status">Choose a baseline and a what-if to see what changed.</div>
		{/if}
	{:else}
		{#if loaded.length}
			<div class="summary-grid">
				<section class="panel outcomes" aria-labelledby="outcomes-h" aria-busy={cmp.b.loading || cmp.c.loading}>
					<h2 id="outcomes-h">What changes</h2>
					<div class="table-wrap">
						<table class="data outcomes-table">
							<caption class="visually-hidden">Headline outcomes of the baseline and each what-if, with each what-if's change from the baseline</caption>
							<thead>
								<tr>
									<th scope="col">Outcome</th>
									<th scope="col" class="num"><span class="key" style:background={COLOUR.a} aria-hidden="true"></span>{NAME.a}</th>
									{#each whatIfs as s (s)}<th scope="col" class="num"><span class="key" style:background={COLOUR[s]} aria-hidden="true"></span>{NAME[s]}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.id)}
									<tr>
										<th scope="row">{r.label}{#if r.unit}<span class="visually-hidden">,{' '}</span><span class="u">{r.unit}</span>{/if}</th>
										<td class="num val">{fmtMetric(r.base, r.spec)}</td>
										{#each r.whatIfs as m, i (i)}
											<td class="num">
												<span class="val">{fmtMetric(m.b, r.spec)}</span>
												<span class="d"><Delta {m} spec={r.spec} /></span>
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if cmp.c.error && refC}
						<div class="alert alert-error" role="alert">What-if 2 couldn't be compared: {cmp.c.error}</div>
					{/if}
					{#if lead}
						<div class="takeaways tone-{lead.tone}" data-testid="takeaways">
							<h3 class="visually-hidden">Takeaways</h3>
							<p class="lead">{lead.text}.</p>
							{#if notes.length > 1}
								<ul>
									{#each notes.filter((t) => t !== lead) as t, i (i)}<li>{t.text}.</li>{/each}
								</ul>
							{/if}
						</div>
					{/if}
				</section>
				<section class="panel years" aria-labelledby="years-h">
					<h2 id="years-h">Days below the reserve, each year</h2>
					<ReserveYearsChart runs={chartRuns} />
				</section>
			</div>
		{/if}

		<div class="full-head">
			<div>
				<h2 id="full-h">Full comparison</h2>
				<p class="muted small">
					Baseline (run A) against {NAME[shownSide]} (run B): every figure below is B − A.
				</p>
			</div>
			{#if refC}
				<div class="seg" role="radiogroup" aria-labelledby="full-h">
					{#each WHAT_IFS as s (s)}
						<label class:on={shownSide === s}>
							<input type="radio" name="full-side" value={s} checked={shownSide === s} onchange={() => (fullSide = s)} />
							Baseline vs {NAME[s]}
						</label>
					{/each}
				</div>
			{/if}
		</div>

		<LoadState loading={loading && !data} {error} retry={() => refA && refX && loadCompare(shownSide, refA, refX)}>
			{#if data}
				<section class="panel" aria-labelledby="sides-h" aria-busy={loading}>
					<h2 id="sides-h" class="visually-hidden">Runs compared</h2>
					<dl class="sides">
						<div>
							<dt>A</dt>
							<dd>
								<span class="side-name">Baseline:</span>
								{describe(data.a)}
								<!-- The modeller's written explanation of the run (007_run_notes). -->
								{#if data.a.run.notes}<span class="run-notes"><span class="lbl">Run notes:</span> {data.a.run.notes}</span>{/if}
							</dd>
						</div>
						<div>
							<dt>B</dt>
							<dd>
								<span class="side-name">{NAME[shownSide]}:</span>
								{describe(data.b)}
								<!-- The modeller's written explanation of the run (007_run_notes). -->
								{#if data.b.run.notes}<span class="run-notes"><span class="lbl">Run notes:</span> {data.b.run.notes}</span>{/if}
							</dd>
						</div>
					</dl>
					{#if sameRun}
						<div class="alert alert-info" role="status">Both sides are the same run, so nothing has changed. Pick a different run for the baseline or the what-if.</div>
					{/if}
					{#if !data.comparison.samePeriod}
						<div class="alert alert-warning" role="status">
							The runs cover different periods (A {data.a.run.startDate} → {data.a.run.endDate}, B {data.b.run.startDate} →
							{data.b.run.endDate}). Figures are averages over each run's own period, so part of each change comes from the dates.
						</div>
					{/if}
					{#if data.comparison.engineVersionChanged}
						<div class="alert alert-info" role="status">
							The runs used different model engine versions ({data.a.run.engineVersion} → {data.b.run.engineVersion}), so some
							change may come from the model itself.
						</div>
					{/if}
					{#if data.comparison.chirpsFit?.changed}
						<div class="alert alert-info" role="status" data-testid="chirps-fit-changed">
							{chirpsFitNote(data.comparison.chirpsFit)}
						</div>
					{/if}
					{#if data.comparison.rainSource?.changed}
						<div class="alert alert-info" role="status" data-testid="rain-source-changed">
							{rainSourceNote(data.comparison.rainSource)}
						</div>
					{/if}
					<!-- Either side is, or was, the project's nominated evidence run (010_run_nomination). -->
					{#each [compareEvidenceNote('A', data.a.run.evidence, (iso) => fmtDate(iso, true)), compareEvidenceNote('B', data.b.run.evidence, (iso) => fmtDate(iso, true))] as note, i (i)}
						{#if note}<div class="alert alert-info" role="status" data-testid="evidence-note">{note}</div>{/if}
					{/each}
					{#if data.a.run.legacy || data.b.run.legacy}
						<div class="alert alert-warning" role="status">
							{#if data.a.run.legacy && data.b.run.legacy}Both runs use
							{:else if data.a.run.legacy}Run A uses
							{:else}Run B uses{/if}
							the legacy runoff model (b023 workbook, removed in engine 1.0.0) — it doesn’t conserve water at the event scale (audit H1), so this
							comparison is workbook comparison only, not evidence for a licence, Reserve or compliance assessment.
						</div>
					{/if}
				</section>

				{#if data.a.scenario || data.b.scenario}
					<section class="panel" aria-labelledby="overrides-h">
						<div class="panel-head"><h2 id="overrides-h">Scenario overrides</h2></div>
						<Lazy load={loadOverrides}>
							{#snippet children(ScenarioOverrides)}<ScenarioOverrides data={data!} />{/snippet}
						</Lazy>
					</section>
				{/if}

				<section class="panel" aria-labelledby="changes-h">
					<div class="panel-head">
						<h2 id="changes-h">What changed</h2>
						<span class="muted small">{data.changes.length} difference{data.changes.length === 1 ? '' : 's'} in the inputs</span>
					</div>
					{#if data.attribution}
						<p class="muted small" data-testid="changes-attribution">
							{attributionSummary(data.attribution)}
							{#if data.attribution.revisions.length}<a href={historyHref(data.b.project.id)}>Open the history</a>{/if}
						</p>
					{/if}
					<ChangesList changes={data.changes} authors={lineAuthors(data.changes, data.attribution)} />
				</section>

				<section class="panel" aria-labelledby="headline-h">
					<div class="panel-head"><h2 id="headline-h">Headline results</h2></div>
					<HeadlineDeltas comparison={data.comparison} />
					<FitValidationCompare
						a={asFitRecord(data.a.run.inputs.settings?.fitRecord)}
						b={asFitRecord(data.b.run.inputs.settings?.fitRecord)}
						settingsA={data.a.run.inputs.settings}
						settingsB={data.b.run.inputs.settings}
						chirpsA={chirpsSourceOfInput(data.a.run.inputs.series)}
						chirpsB={chirpsSourceOfInput(data.b.run.inputs.series)}
						apanA={apanDailyOfInput(data.a.run.inputs.series)}
						apanB={apanDailyOfInput(data.b.run.inputs.series)}
					/>
				</section>

				<div class="panel">
					<PairedUncertaintyPanel
						projectA={data.a.project.id}
						runA={data.a.run.id}
						projectB={data.b.project.id}
						runB={data.b.run.id}
						modelA={runoffModelOf(data.a)}
						modelB={runoffModelOf(data.b)}
						canEdit={(projects.find((p) => p.id === data!.b.project.id)?.role ?? 'viewer') !== 'viewer'}
					/>
				</div>

				{#if data.comparison.ewrAssurance?.length}
					<section class="panel" aria-labelledby="reserve-h">
						<div class="panel-head"><h2 id="reserve-h">Reserve compliance by month</h2></div>
						<EwrAssuranceCompare sites={data.comparison.ewrAssurance} />
					</section>
				{/if}

				<section class="panel" aria-labelledby="ewr-agreement-h">
					<div class="panel-head"><h2 id="ewr-agreement-h">EWR test against observed flow</h2></div>
					<EwrAgreementCompare {data} />
				</section>

				{#if data.comparison.plausibility}
					<section class="panel" aria-labelledby="plausibility-h">
						<div class="panel-head"><h2 id="plausibility-h">Plausibility checks</h2></div>
						<PlausibilityCompare comparison={data.comparison.plausibility} />
					</section>
				{/if}

				<section class="panel" aria-labelledby="farms-h">
					<div class="panel-head"><h2 id="farms-h">Hydrological units</h2></div>
					<FarmDeltaTable comparison={data.comparison} farmsA={data.a.run.summary.farms ?? []} farmsB={data.b.run.summary.farms ?? []} />
				</section>

				<section class="panel" aria-labelledby="chart-h">
					<div class="panel-head"><h2 id="chart-h">Daily series</h2></div>
					<CompareOverlay {data} />
				</section>
			{/if}
		</LoadState>
	{/if}
</LoadState>

<style>
	.cmp-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
		margin: 0 0 1rem;
	}
	.cmp-title :global(h1),
	.cmp-title :global(h2) {
		margin: 0;
		font-size: 1.6rem;
	}
	.cmp-title p {
		margin: 0.2rem 0 0;
		overflow-wrap: anywhere;
	}
	.cmp-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.export-menu {
		position: relative;
	}
	.export-menu summary {
		list-style: none;
		cursor: pointer;
	}
	.export-menu summary::-webkit-details-marker {
		display: none;
	}
	.export-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: grid;
		width: max-content;
		max-width: min(28rem, 90vw);
		padding: 0.3rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	.export-pop a {
		display: flex;
		align-items: baseline;
		min-height: 36px;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.9rem;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.export-pop a:hover {
		background: var(--surface-2);
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}
	@media (max-width: 900px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.run-name {
		margin: 0.1rem 0 0;
		font-size: 1.02rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.run-line {
		margin: 0.1rem 0 0;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}
	.run-line.err {
		color: var(--danger);
	}
	.link-btn {
		background: none;
		border: 0;
		padding: 0;
		min-height: 24px;
		color: var(--accent);
		text-decoration: underline;
		font: inherit;
		cursor: pointer;
	}
	.add-card {
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 1rem;
		text-align: center;
	}
	.add-card p {
		margin: 0;
		max-width: 28ch;
	}
	.with-published {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: -0.25rem 0 1rem;
	}
	.summary-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: stretch;
		margin-bottom: 1rem;
	}
	.summary-grid .panel {
		margin: 0;
	}
	@media (max-width: 1100px) {
		.summary-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.outcomes {
		display: flex;
		flex-direction: column;
	}
	.outcomes-table th[scope='row'] {
		font-weight: 500;
	}
	.outcomes-table td {
		vertical-align: top;
	}
	.outcomes-table .val {
		font-family: var(--font-mono);
		font-size: 0.95rem;
	}
	.outcomes-table .d {
		display: block;
		font-size: 0.8rem;
	}
	.key {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-right: 0.35rem;
	}
	/* The unit on its own line under the outcome's name. */
	.u {
		display: block;
		color: var(--text-muted);
		font-weight: 400;
		font-size: 0.8em;
	}
	.takeaways {
		margin-top: auto;
		padding: 0.7rem 0.85rem;
		border-radius: var(--radius);
		background: var(--surface-2);
		border-left: 4px solid var(--border-strong);
	}
	.takeaways.tone-worse {
		background: var(--danger-soft);
		border-left-color: var(--danger);
	}
	.takeaways.tone-better {
		background: var(--success-soft);
		border-left-color: var(--success);
	}
	.takeaways .lead {
		margin: 0;
		font-weight: 600;
	}
	.takeaways ul {
		margin: 0.3rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.88rem;
		color: var(--text-2);
	}
	.years {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.full-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		margin: 1.5rem 0 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}
	.full-head h2 {
		margin: 0;
	}
	.full-head p {
		margin: 0.2rem 0 0;
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--border-input);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.seg label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.75rem;
		min-height: 36px;
		cursor: pointer;
		font-size: 0.88rem;
	}
	.seg label + label {
		border-left: 1px solid var(--border-input);
	}
	.seg label.on {
		background: var(--accent-soft);
		font-weight: 600;
	}
	.empty {
		text-align: center;
		padding: 2rem 1rem;
	}
	.empty p {
		max-width: 60ch;
		margin: 0 auto 1rem;
	}
	.sides {
		display: grid;
		gap: 0.3rem;
		margin: 0 0 0.5rem;
	}
	.sides div {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
	}
	.sides dt {
		font-weight: 700;
		min-width: 1.2rem;
	}
	.sides dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.side-name {
		font-weight: 600;
	}
	.run-notes {
		display: block;
		white-space: pre-wrap;
		font-size: 0.85rem;
		color: var(--text-2);
		max-width: 90ch;
	}
	.run-notes .lbl {
		font-weight: 500;
	}
	.alert:last-child {
		margin-bottom: 0;
	}
</style>
