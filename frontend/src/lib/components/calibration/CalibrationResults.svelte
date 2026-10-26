<!--
	The Calibration page's "How the shown run fits" (issue #586 Round 3): a run
	picker and Model quality (runs/ModelQuality.svelte) for the run it shows.
	The run is the one `?run=` names, as on Runs & results, so the sidebar
	carries a pick between the two pages (workspace/tabLinks.ts RUN_TABS); with
	none, Runs' default (page.ts shownRun: the newest, a viewer's published
	baseline). Picking a run writes `run=`, one step in history. The run's
	details come through Runs' own cache (runs/cache.ts runDetail), so a run
	read on one page shows at once on the other. A link to a Model quality
	panel (`#res-plausibility`), or to a sub-heading with an index line
	(`#res-fit-provenance`, page.ts CAL_SUBSECTIONS), lands once the picked run
	is shown, or on a line saying what the panel needs when this run has none
	(runs/missingPanel.ts); CalibrationTab's followAnchors hands it here
	through `landing`. The run shown is told to the page (`onshown`), for its
	side index. With no run, the part's one empty state says what to do first:
	add an observed flow record on Data when there is none, else run the
	model (the header's Run model, as on Runs & results).
-->
<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, hasRole, type Role, type RunMeta } from '#lib/api/index.js';
	import { toEpochDay } from '@water-management/engine';
	import { fmtDay, fmtNum, fmtWhen } from '#lib/format/number.js';
	import { FORMER_MEMBER } from '#lib/format/maker.js';
	import { focusAnchor, holdAnchor, landOnAnchor } from '#lib/help/anchor.js';
	import { runOptionLabel } from '#lib/components/compare/picker.js';
	import { runHref } from '#lib/components/overview/attention.js';
	import ModelQuality from '#lib/components/runs/ModelQuality.svelte';
	import { detailCache, prefetchSeries, runDetail, type RunDetail } from '#lib/components/runs/cache.js';
	import { CATCHMENT_FLOW_KEYS } from '#lib/components/runs/flowSeries.js';
	import { missingPanel, type MissingPanel } from '#lib/components/runs/missingPanel.js';
	import { isModelQualityAnchor } from '#lib/components/runs/modelQuality.js';
	import { isRunGone, runErrorText } from '#lib/components/runs/runList.js';
	import type { RunSummary } from '@water-management/engine';
	import { calShown, isCalSubsection, shownRun, type CalShown } from './page';
	import type { CalState } from './status';
	import { RetryFocus } from './retryFocus';

	type Land = (id: string) => (() => void) | void;

	let {
		projectId,
		runs,
		role,
		nodes = [],
		series = null,
		projectSettings = null,
		hasRecord = null,
		changed = [],
		landing,
		onshown,
		onstate
	}: {
		projectId: string;
		/** The page's runs list, newest first: null until it loads, or when it couldn't (this part then loads its own). */
		runs: RunMeta[] | null;
		role: Role | null | undefined;
		/** The model's nodes (the editor's): their names and network order; a node deleted since the run takes the run's name. */
		nodes?: readonly { id: string; name: string }[];
		/** The project's input series: a checks-only gauge links to its record on Data. */
		series?: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null;
		/** The project's settings, for a run that kept no snapshot of its own (its calibration window). */
		projectSettings?: { calibrationStart?: string | null; calibrationEnd?: string | null } | null;
		/** The project has an observed or logger flow record a run can be scored against: null while not known. */
		hasRecord?: boolean | null;
		/** The form's GR4J parameters that differ from the shown run's (status.ts gr4jChanges), said under the run line. */
		changed?: readonly string[];
		/** Called once with this part's landing, for the page's followAnchors to hand a Model quality anchor to. */
		landing?: (land: Land) => void;
		/** The run on screen, its summary and the sub-headings it draws (for the page's side index); null for none. */
		onshown?: (shown: { summary: RunSummary; subs: CalShown } | null) => void;
		/** What this part shows, for the page's first line (status.ts), with the shown run's GR4J parameters to compare with the form's. */
		onstate?: (state: CalState, gr4j: Record<string, number | null | undefined> | null) => void;
	} = $props();

	const canEdit = $derived(hasRole(role, 'editor'));

	// --- the runs: the page's list, or this part's own when the page has none (still loading, or it failed) ---
	let ownRuns = $state.raw<RunMeta[] | null>(null);
	let listError = $state<string | null>(null);
	let listLoading = $state(false);
	async function loadList() {
		listLoading = true;
		listError = null;
		try {
			ownRuns = await api.runs.list(projectId);
		} catch (e) {
			listError = runErrorText(e);
		} finally {
			listLoading = false;
		}
	}
	onMount(() => {
		if (untrack(() => runs) === null) void loadList();
	});
	const list = $derived(runs ?? ownRuns);

	const picked = $derived(page.url.searchParams.get('run'));
	/** The run shown: the one `?run=` names while it is still a run of the project, else the default. */
	const run = $derived(shownRun(list, picked, role));
	/** `?run=` names a run that is gone (deleted since the link was made): the default shows, and says so. */
	const pickedGone = $derived(!!picked && !!list && !list.some((r) => r.id === picked));

	/** A run picked here is a step in history, as on Runs & results, so Back returns to the run before. */
	function choose(id: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('run', id);
		if (url.search === page.url.search) return;
		void goto(url, { reset: false });
	}

	// --- the run's details, through Runs' cache ---
	// The details on screen. Another run picked keeps them there, marked busy, until the next run's are in, so the
	// charts don't empty under a reader scrolled down; a failed load clears them, so nothing stale stays.
	let detail = $state.raw<RunDetail | null>(untrack(() => (run ? (detailCache.get(run.id) ?? null) : null)));
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	/** The run is no longer stored (404): Try again can't bring it back. */
	let detailGone = $state(false);
	let wanted = '';
	async function loadDetail(id: string) {
		wanted = id;
		detailError = null;
		detailGone = false;
		const hit = detailCache.get(id);
		if (hit) {
			detail = hit;
			detailLoading = false;
			return;
		}
		detailLoading = true;
		try {
			const d = await runDetail(id, () =>
				api.runs.get(projectId, id).then((d) => {
					// The hydrograph's flows go out now, before Model quality renders (cache.ts prefetchSeries).
					prefetchSeries(id, d.series, CATCHMENT_FLOW_KEYS.map(([, key]) => ({ key, nodeId: null })), (key, nodeId) => api.runs.series(projectId, id, key, nodeId));
					return d;
				})
			);
			if (wanted === id) detail = d;
		} catch (e) {
			if (wanted === id) {
				detail = null;
				detailError = runErrorText(e);
				detailGone = isRunGone(e);
			}
		} finally {
			if (wanted === id) detailLoading = false;
		}
	}
	$effect(() => {
		const id = run?.id ?? null;
		untrack(() => {
			if (!id) {
				wanted = '';
				detail = null;
			} else if (id !== wanted) void loadDetail(id);
		});
	});
	const retry = () => run && loadDetail(run.id);

	// Each Try again takes its alert out of the page: the focus follows the retry (retryFocus.ts, WCAG 2.4.3), onto the
	// loading line, then the new Try again or the part's heading. The list's is aria-disabled while it loads, never
	// disabled, which would drop the focus too (ui-playbook § Focus).
	const listRetry = new RetryFocus();
	const runRetry = new RetryFocus();
	let listStatus = $state<HTMLElement>();
	let listButton = $state<HTMLElement>();
	let runStatus = $state<HTMLElement>();
	let runButton = $state<HTMLElement>();
	$effect(() => {
		const state = list !== null ? 'loaded' : listError ? 'failed' : 'loading';
		const [st, bt] = [listStatus, listButton];
		untrack(() => listRetry.follow(state, st, bt));
	});
	$effect(() => {
		const state = detail ? 'loaded' : detailError ? 'failed' : 'loading';
		const [st, bt] = [runStatus, runButton];
		untrack(() => runRetry.follow(state, st, bt));
	});
	/** The run picked isn't the one on screen yet: its details are loading. */
	const busy = $derived(!!detail && !!run && detail.run.id !== run.id);
	const shownIsPicked = $derived(!!detail && !!run && detail.run.id === run.id);
	$effect(() => {
		const d = detail;
		untrack(() => onshown?.(d ? { summary: d.run.summary, subs: calShown(d.run, d.series) } : null));
	});
	// The page's first line (status.ts): the run whose details are on screen, else why there is none yet.
	$effect(() => {
		const d = detail;
		const state: CalState =
			list === null
				? listError
					? { kind: 'error' }
					: { kind: 'loading' }
				: !run
					? { kind: 'none' }
					: d
						? { kind: 'run', label: name(d.run), calibration: d.run.summary.calibration }
						: detailError
							? { kind: 'error' }
							: { kind: 'loading' };
		const gr4j = d && d.run.runoffModel === 'gr4j' ? ((d.run.settings?.gr4j as Record<string, number | null | undefined> | undefined) ?? null) : null;
		untrack(() => onstate?.(state, gr4j));
	});

	// Names and order from the current model; nodes deleted since the run fall back to the run's own names.
	const nodeOrder = $derived(new Map(nodes.map((n, i) => [n.id, i] as [string, number])));
	const nodeNames = $derived.by(() => {
		const m = new Map(nodes.map((n) => [n.id, n.name] as [string, string]));
		for (const f of detail?.run.summary.farms ?? []) if (!m.has(f.nodeId)) m.set(f.nodeId, f.name);
		return m;
	});
	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');

	// --- a link to a Model quality panel (`#res-plausibility`), on load or followed on the page ---
	// The panels render once the run's details are in, some later still (lazy chunks, and the panels after the
	// flow-duration curve, which ModelQuality draws at once for such a link). So the landing waits for the picked
	// run, then for the panel and its heading (landOnAnchor), with focus there. A panel this run doesn't have shows
	// a line saying what it needs instead, focused. With no run at all, the part's heading takes it.
	let pendingHash = $state<string | null>(null);
	let missing = $state<{ runId: string; hash: string; panel: MissingPanel } | null>(null);
	let releaseLanding = () => {};
	let destroyed = false;
	function land(id: string): (() => void) | void {
		if (!isModelQualityAnchor(id) && !isCalSubsection(id)) return;
		const known = untrack(() => list);
		if (known && !known.length) return landOnAnchor('cal-fit');
		if (untrack(() => shownIsPicked)) return landResult(id);
		pendingHash = id;
		return () => {
			if (pendingHash === id) pendingHash = null;
			releaseLanding();
		};
	}
	untrack(() => landing?.(land));
	$effect(() => {
		if (!shownIsPicked || !pendingHash) return;
		const hash = pendingHash;
		pendingHash = null;
		untrack(() => landResult(hash));
	});
	function landResult(hash: string): () => void {
		releaseLanding();
		const shown = detail;
		if (!shown) return () => {};
		const lacking = missingPanel(hash, shown.run.summary);
		missing = lacking ? { runId: shown.run.id, hash, panel: lacking } : null;
		// A sub-heading this run doesn't draw (no record to chart, no settings kept): its panel, Calibration against observed flow.
		const subs = calShown(shown.run, shown.series);
		const target = (hash === 'res-calibration-check' && !subs.check) || (hash === 'res-fit-provenance' && !subs.provenance) ? 'res-calibration' : hash;
		let release = () => {};
		let gone = false;
		tick().then(() => {
			if (destroyed || gone) return;
			const line = lacking ? document.getElementById('cal-missing') : null;
			if (line) {
				release = holdAnchor(line);
				focusAnchor(line);
			} else release = landOnAnchor(target);
		});
		releaseLanding = () => {
			gone = true;
			release();
		};
		return releaseLanding;
	}
	onDestroy(() => {
		destroyed = true;
		releaseLanding();
	});

	const name = (r: Pick<RunMeta, 'label'>) => r.label || 'Untitled run';
	const runDays = (r: { startDate: string; endDate: string }) => toEpochDay(r.endDate) - toEpochDay(r.startDate) + 1;
</script>

{#if list === null}
	{#if listError}
		<div class="alert alert-error" role="alert">
			Couldn’t load the runs: {listError}
			<button
				type="button"
				class="btn btn-sm"
				bind:this={listButton}
				aria-disabled={listLoading || undefined}
				onclick={(e) => {
					if (listLoading) return;
					listRetry.press(e.currentTarget);
					void loadList();
				}}>Try again</button
			>
		</div>
	{:else}
		<p class="muted retry-line" role="status" tabindex="-1" bind:this={listStatus} data-testid="calibration-runs-loading">Loading the runs…</p>
	{/if}
{:else if !run}
	<!-- The part's one empty state (ui-playbook.md § 2): what to do first. With no record to compare with, a run
	     would show no fit, so that comes first; then a run, which the header's Run model starts (as on Runs & results). -->
	<div class="empty" data-testid="calibration-no-run">
		{#if hasRecord === false}
			<p>
				<strong>No observed flow record yet.</strong> A fit compares a run’s flows with a record measured at a gauge: add one on
				<a href="?tab=series">Data</a>{canEdit ? ', then run the model.' : '.'}
			</p>
		{:else}
			<p><strong>No run yet.</strong> {canEdit ? 'Run the model to see how its flows fit the observed record.' : 'An editor can run the model.'}</p>
		{/if}
		<p class="muted small">A run shows here with its hydrograph, flow-duration curve, calibration scores and plausibility checks.</p>
	</div>
{:else}
	<!-- The picker and the way to the run's own page on one line, its dates and maker on the next: the select takes the room
	     its labels need up to a cap, so the line never wraps the run's details beside it (issue #586 R3-D). On a narrow
	     page, where a long label is cut in the closed select, the second line starts with the run's whole name. -->
	<div class="run-head" data-testid="calibration-run">
		<div class="run-row">
			{#if list.length > 1}
				<label class="run-pick" for="cal-run">Run</label>
				<select id="cal-run" value={run.id} onchange={(e) => choose(e.currentTarget.value)}>
					{#each list as r, i (r.id)}<option value={r.id}>{runOptionLabel(r, (iso) => fmtWhen(iso), i === 0)}</option>{/each}
				</select>
			{:else}
				<span class="run-pick">Run</span> <strong class="only">{name(run)}</strong>
			{/if}
			<a class="btn btn-sm open" href={runHref(run.id)}>Open in Runs &amp; results</a>
		</div>
		<p class="muted small run-line">
			{#if list.length > 1}<span class="whole-name">{name(run)}{' · '}</span>{/if}{fmtDay(run.startDate)} – {fmtDay(run.endDate)} ({fmtNum(runDays(run))} days) · ran {fmtWhen(run.createdAt)} by {run.createdBy ??
				FORMER_MEMBER} · engine {run.engineVersion}
		</p>
	</div>
	{#if changed.length}
		<!-- The form's parameters aren't the ones this run used (an edit, saved or not, or a fit applied): its scores are the run's. -->
		<p class="alert alert-info" role="note" data-testid="calibration-changed">
			The form’s GR4J parameters differ from the ones this run used ({changed.join(', ')}): the fit below is this run’s. {canEdit
				? 'Run the model to score the form’s.'
				: 'An editor can run the model to score the form’s.'}
		</p>
	{/if}
	{#if pickedGone}
		<p class="alert alert-info" role="note">That run no longer exists (deleted, or removed by the storage cap), so this shows {run.id === list[0]?.id ? 'the newest run' : 'the published run'}.</p>
	{/if}

	{#if detailError && !detail}
		<div class="alert alert-error" role="alert">
			{detailError}
			{#if !detailGone}
				<button
					type="button"
					class="btn btn-sm"
					bind:this={runButton}
					onclick={(e) => {
						runRetry.press(e.currentTarget);
						void retry();
					}}>Try again</button
				>
			{:else if list[0] && list[0].id !== run.id}
				<button type="button" class="btn btn-sm" onclick={() => choose(list[0]!.id)}>Show the newest run</button>
			{/if}
		</div>
	{:else if detail}
		{#if missing && missing.runId === detail.run.id}
			<!-- A link to a panel this run doesn't have (runs/missingPanel.ts): what it needs, focused on landing. -->
			<p class="panel" id="cal-missing" tabindex="-1" data-testid="missing-panel" data-for={missing.hash}>
				{missing.panel.text}{#if missing.panel.link}{' '}<a href={missing.panel.link.href}>{missing.panel.link.label}</a>{/if}
			</p>
		{/if}
		<!-- data-run: the run whose details are on screen; aria-busy while another run picked is loading (both for the tests). -->
		<div class="results" data-testid="calibration-results" data-run={detail.run.id} aria-busy={busy || detailLoading}>
			<ModelQuality {projectId} run={detail.run} refs={detail.series} {nodeNames} {nodeOrder} runs={list} {series} {projectSettings} bind:flowUnit />
		</div>
	{:else}
		<div class="chart-ph retry-line" role="status" tabindex="-1" bind:this={runStatus} data-testid="calibration-run-loading">Loading the run…</div>
	{/if}
{/if}

<style>
	/* The part answers to its own width (the page's, less the side index), for the narrow line below. */
	.run-head {
		container: cal-run / inline-size;
		margin: 0 0 1rem;
	}
	.run-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.75rem;
	}
	.run-pick {
		font-weight: 600;
	}
	/* The select takes the room its labels need, up to a cap that leaves Open in Runs & results on its line. */
	.run-row select {
		flex: 0 1 auto;
		min-width: 0;
		max-width: min(100%, 44rem);
		min-height: 2rem;
		text-overflow: ellipsis;
	}
	.run-row .open {
		margin-left: auto;
	}
	.run-line {
		margin: 0.35rem 0 0;
	}
	.whole-name {
		display: none;
		font-weight: 600;
		color: var(--text-2);
	}
	@container cal-run (max-width: 48rem) {
		.whole-name {
			display: inline;
		}
	}
	/* The part's one empty state, as Runs & results' (RunsTab.svelte .empty, left-aligned across the width). */
	.empty {
		color: var(--text-muted);
		padding: 1.25rem 0.75rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty p {
		margin: 0;
		max-width: 75ch;
	}
	.empty p + p {
		margin-top: 0.4rem;
	}
	.empty strong {
		color: var(--text);
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 390px;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
	/* Focused only by a retry (retryFocus.ts), never by Tab: no ring round the whole line, as LoadState's. */
	.retry-line:focus {
		outline: none;
	}
	.results[aria-busy='true'] {
		opacity: 0.7;
	}
</style>
