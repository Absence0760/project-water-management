<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { SeriesMeta } from '@water-management/engine';
	import { api, type Project, type Run, type RunMeta } from '$lib/api';
	import AlertsPanel from '$lib/components/alerts/AlertsPanel.svelte';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { fmtDay } from '$lib/format/number';
	import { projectToday } from '$lib/components/projects/freshness';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { loadOnce, peek } from '$lib/components/common/lazy';
	import { attention, runHref } from './attention';
	import { riverHref } from '$lib/components/river/links';
	import { supplyHref } from '$lib/components/supply/links';
	import { checklist, checklistMode } from './checklist';
	import LatestRun from './LatestRun.svelte';
	import { historyEnd, pickRuns, ranAgo, type DamsState } from './latestRun';
	import { headlineSite } from '$lib/components/runs/ewrAssurance';
	import { damLevelsFromSummary, damsInRun, damsToday, loadDamLevels, type DamLevel } from './damLevels';
	import { projectAnchor, projectHref } from '$lib/components/project/links';
	import NeedsAttention from './NeedsAttention.svelte';
	import PublishedBaseline from './PublishedBaseline.svelte';
	import ReserveStrip from './ReserveStrip.svelte';
	import SetupChecklist from './SetupChecklist.svelte';
	import SetupPill from './SetupPill.svelte';

	// Supply by farm waits for the run's record too: its own chunk keeps the page's first chunk under its budget.
	const loadSupply = () => import('./SupplyByFarm.svelte');

	let {
		project,
		editor,
		series,
		runs,
		canEdit,
		visibleTabs
	}: {
		project: Project;
		editor: ModelEditor;
		/** The page's input-series list (null if it couldn't be loaded). */
		series: SeriesMeta[] | null;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The tabs this member is shown (lib/workspace/tabs.ts); the setup checklist links only to these. */
		visibleTabs: readonly string[];
	} = $props();

	// The model's facts, the project's details, import record and notes, and who has access moved to
	// the Project page (issue #17): an old link to one of their panels (`#members-h`) goes there,
	// replacing this entry so Back skips it.
	onMount(() => {
		const hash = page.url.hash.slice(1);
		if (projectAnchor(hash)) goto(projectHref(hash), { replaceState: true, noScroll: true });
	});

	// The series and runs lists come from the page, which loads them before any
	// tab renders and refreshes them after an upload or a run, so the checklist
	// is final on the first frame and never goes stale.
	// Built from the model as edited (unsaved changes included) so the
	// checklist ticks as soon as the user fills a step in.
	const steps = $derived(
		checklist({ model: editor.model, settings: project.settings, series, runs, updatedAt: project.updatedAt })
	);
	// Once every step is done the checklist leaves the page for a "Setup complete" pill in the
	// section header, whose popover lists the steps over the page (SetupPill): opening it never
	// makes the page taller. While there's work to do (or it's still checking) it stays on the page.
	const setupDone = $derived(checklistMode(steps) === 'complete');

	// --- latest run: its headline figures and what needs attention ----------
	// The run list is the page's; the full records (summaries) are fetched here
	// through the Runs tab's cache, so opening that tab next shows the run at once.
	const pick = $derived(pickRuns(runs));
	let latestRun = $state.raw<Run | null>(null);
	let previousRun = $state.raw<Run | null>(null);
	let runLoading = $state(false);
	let runError = $state<string | null>(null);
	let previousError = $state<string | null>(null);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function fetchRun(id: string): Promise<Run> {
		const hit = detailCache.get(id);
		if (hit) return hit.run;
		const d = await api.runs.get(project.id, id);
		detailCache.set(id, d);
		return d.run;
	}

	let loadKey = '';
	async function loadRuns(latestId: string, previousId: string | null) {
		const key = (loadKey = `${latestId}|${previousId ?? ''}`);
		// Cached records paint on the first frame; the rest arrive in parallel.
		latestRun = detailCache.get(latestId)?.run ?? null;
		previousRun = previousId ? (detailCache.get(previousId)?.run ?? null) : null;
		runError = null;
		previousError = null;
		runLoading = !latestRun;
		const prev = previousId && !previousRun ? fetchRun(previousId) : null;
		try {
			const r = await fetchRun(latestId);
			if (loadKey === key) latestRun = r;
		} catch (e) {
			if (loadKey === key) runError = msg(e);
		} finally {
			if (loadKey === key) runLoading = false;
		}
		if (prev) {
			try {
				const p = await prev;
				if (loadKey === key) previousRun = p;
			} catch (e) {
				// Shown under the cards: they stand without the changes.
				if (loadKey === key) previousError = msg(e);
			}
		}
	}
	const retryRuns = () => pick && loadRuns(pick.latest.id, pick.previous?.id ?? null);

	// Reload only when the pair of runs changes (the page refreshes its list
	// after a run or a note edit; the same ids need no refetch).
	$effect(() => {
		const latestId = pick?.latest.id ?? null;
		const previousId = pick?.previous?.id ?? null;
		untrack(() => {
			if (!latestId) {
				loadKey = '';
				latestRun = previousRun = null;
			} else if (`${latestId}|${previousId ?? ''}` !== loadKey) loadRuns(latestId, previousId);
		});
	});

	/** The latest run's record, once it is the one picked (not a stale one while the next loads). */
	const shown = $derived(latestRun && latestRun.id === pick?.latest.id ? latestRun : null);

	// --- dams: each dam's level at the end of the latest run (damLevels.ts), for
	// the Dams today card (the Dams page has the table): from the run summary, or
	// for a run older than engine 1.2.0 from each dam's daily storage series
	// through the Runs cache, a few at a time. Capacity and the
	// minimum level come from the run's own model, so a later edit doesn't skew them.
	let damLevels = $state.raw<DamLevel[]>([]);
	let damsLoading = $state(false);
	let damsError = $state<string | null>(null);
	let damsKey = '';
	$effect(() => {
		const run = shown;
		const key = run ? run.id : '';
		untrack(() => {
			if (key === damsKey) return;
			damsKey = key;
			damLevels = [];
			damsError = null;
			if (!run) {
				damsLoading = false;
				return;
			}
			const id = run.id;
			const list = damsInRun(
				run.model?.nodes as { id: string }[] | undefined,
				editor.model.nodes,
				detailCache.get(id)?.series ?? []
			);
			// A run from engine ≥ 1.2.0 carries the figures in its summary (issue #55): no series to fetch.
			// A forecast run's figures are its record's: dated the day before the forecast (issue #51).
			const forecastFrom = run.summary.forecast?.from ?? null;
			const fromSummary = damLevelsFromSummary(list, run.summary.farms, historyEnd({ startDate: run.startDate, endDate: run.endDate, forecastFrom }));
			if (fromSummary) {
				damLevels = fromSummary;
				damsLoading = false;
				return;
			}
			damsLoading = list.length > 0;
			if (!list.length) return;
			const current = () => damsKey === key;
			loadDamLevels(
				list,
				(nodeId) => cachedSeries(id, 'dam_storage', nodeId, () => api.runs.series(project.id, id, 'dam_storage', nodeId)),
				4,
				undefined,
				forecastFrom
			)
				.then((l) => {
					if (current()) damLevels = l;
				})
				.catch((e) => {
					if (current()) damsError = msg(e);
				})
				.finally(() => {
					if (current()) damsLoading = false;
				});
		});
	});
	const damsState = $derived.by((): DamsState => {
		if (damsError) return { state: 'error' };
		if (damsLoading) return { state: 'loading' };
		const today = damsToday(damLevels);
		return today ? { state: 'ready', today } : { state: 'none' };
	});

	// --- the first screen (issue #17 A1, issue #162): the KPIs, the reserve strip under them (the
	// flow chart itself is River & reserve's), then Needs attention and the active alerts beside
	// Supply by farm. It flows with the page (one scroll, the window's): it used to be sized to the
	// window with the cards scrolling inside themselves, which hid everything below it with no cue
	// that it was there. Supply by farm shows its emptiest units and a "Show all" instead.
	const runFarms = $derived(shown?.summary.farms ?? []);

	// --- data-ready: true once every section that loads its own data has settled (loaded or failed)
	// and so has its final height. The Latest run card is on the page (busy) while its record loads,
	// and Supply by farm, the alerts and the published baseline fill in after it, so the page grows
	// as they arrive; a test that measures the layout waits on this first (docs/ui.md § Summary).
	// The Supply by farm chunk has arrived, or its download failed (ChunkFailed is that card's final state).
	let supplyChunk = $state(peek(loadSupply) !== undefined);
	$effect(() => {
		if (!runFarms.length || supplyChunk) return;
		const done = () => (supplyChunk = true);
		loadOnce(loadSupply).then(done, done);
	});
	let alertsReady = $state(false);
	let baselineReady = $state(false);
	const runReady = $derived(!pick || shown !== null || runError !== null);
	const previousReady = $derived(!pick?.previous || previousRun?.id === pick.previous.id || previousError !== null || runError !== null);
	const ready = $derived(
		runReady && previousReady && !damsLoading && (!runFarms.length || supplyChunk) && alertsReady && baselineReady
	);
	const modelFarmIds = $derived(new Set(editor.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id)));

	// The project's calendar date, as in the header and on the project list (issue #137).
	const today = $derived(projectToday(project.timeZone));
	const attentionItems = $derived(
		attention({
			model: editor.model,
			series,
			latest: pick?.latest ?? null,
			summary: latestRun && latestRun.id === pick?.latest.id ? latestRun.summary : null,
			today
		})
	);

	// The section header's context line: which run the Summary shows (issue #17 A1); beside the rain
	// pill, "Setup complete" once it is.
	$effect(() => fillHeader({ context: runContext, status: setupDone ? setupPill : undefined }, !!pick));
	const LEGACY_TITLE =
		'Legacy runoff model (b023 workbook, removed in engine 1.0.0): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence; it can’t be re-run.';
</script>

{#snippet runContext()}
	{#if pick}
		{@const meta = pick.latest}
		<strong class="run-lbl">{meta.label || 'Untitled run'}</strong>
		{#if meta.legacy}<span class="badge badge-warn" title={LEGACY_TITLE}>Workbook comparison</span>{/if}
		{#if meta.evidence === 'current'}<span class="badge badge-owner">Evidence</span>{/if}
		<span>· {fmtDay(meta.startDate)} – {fmtDay(meta.endDate)}</span>
		<span>· engine {meta.engineVersion}</span>
		<span>· ran {ranAgo(meta.createdAt)}</span>
		<span>· <a href={runHref(meta.id)}>Open in Runs</a></span>
	{/if}
{/snippet}

{#snippet setupPill()}<SetupPill {steps} tabs={visibleTabs} />{/snippet}

<!-- Summary (issue #17, option A, board A1): the results first. Before the
     first run there are none, so the setup checklist leads instead. -->
{#snippet moreLinks()}
	<!-- The model's facts, the project's details, notes and who has access are on the Project page
	     (issue #17). Each dam's level is on the Dams page, which the Dams today card and the sidebar
	     open (its link here went in issue #177). -->
	<ul class="more" aria-label="More about this project">
		<li><a href={projectHref()}>Model facts, details, team and sharing <span aria-hidden="true">→</span> Project</a></li>
	</ul>
{/snippet}

{#if !pick}
	<SetupChecklist {steps} tabs={visibleTabs} />
	{#if attentionItems.length}<div class="pre-run"><NeedsAttention items={attentionItems} /></div>{/if}
	<!-- Below it, before the first run: the alerts beside the published baseline, then the links. -->
	<div class="below" data-testid="summary-body" data-ready={ready ? 'true' : undefined}>
		<div class="pair">
			<!-- Alerts firing now, and (editors) which alert emails the catchment sends (WP-2.13). -->
			<AlertsPanel projectId={project.id} {canEdit} bind:ready={alertsReady} />
			<!-- What stakeholders and farmers see: the published run and the WUA's notice (WP-2.3). -->
			<PublishedBaseline projectId={project.id} {runs} {canEdit} bind:ready={baselineReady} />
		</div>
		{@render moreLinks()}
	</div>
{:else}
	<div class="first" data-testid="summary-body" data-ready={ready ? 'true' : undefined}>
		<LatestRun
			meta={pick.latest}
			run={latestRun}
			previousMeta={pick.previous}
			previous={previousRun}
			evidence={pick.evidence}
			loading={runLoading}
			error={runError}
			{previousError}
			retry={retryRuns}
			dams={damsState}
		/>
		{#if shown}
			<ReserveStrip
				compliance={shown.summary.ewrCompliance}
				forecastFrom={shown.summary.forecast?.from ?? null}
				ruleTable={headlineSite(shown.summary) !== null}
				more={{ href: riverHref(shown.id), label: 'More on River & reserve' }}
			/>
		{/if}
		<!-- What to act on (Needs attention, then the alerts firing now) beside Supply by farm, with
		     the published baseline and the links under it: that column is usually the shorter, so
		     the whole Summary fits a 1440 × 960 window with the example catchments. -->
		<div class="cols">
			<div class="act">
				<NeedsAttention items={attentionItems} />
				<!-- Alerts firing now, and (editors) which alert emails the catchment sends (WP-2.13). -->
				<AlertsPanel projectId={project.id} {canEdit} bind:ready={alertsReady} />
			</div>
			<div class="side">
				{#if runFarms.length}
					<Lazy load={loadSupply}>
						{#snippet children(SupplyByFarm)}<SupplyByFarm farms={runFarms} {modelFarmIds} more={{ href: supplyHref(shown!.id), label: 'More on Hydrological units' }} />{/snippet}
					</Lazy>
				{/if}
				<!-- What stakeholders and farmers see: the published run and the WUA's notice (WP-2.3). -->
				<PublishedBaseline projectId={project.id} {runs} {canEdit} bind:ready={baselineReady} />
				{@render moreLinks()}
			</div>
		</div>
	</div>
	<!-- Setup that isn't finished (a step undone since the run) stays on the page; once complete it
	     is the header's pill. -->
	{#if !setupDone}<SetupChecklist {steps} tabs={visibleTabs} />{/if}
{/if}

<style>
	.run-lbl {
		color: var(--text);
	}
	.first {
		display: grid;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.pre-run {
		margin-bottom: 1rem;
	}
	/* Needs attention and the alerts beside Supply by farm, the published baseline and the links, each
	   column half the width. Each card is as tall as its content (no card scrolls inside itself), so
	   the columns may end at different heights. */
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.act,
	.side {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}
	.act > :global(.panel),
	.side > :global(.panel) {
		margin: 0;
		min-width: 0;
	}
	@media (max-width: 899px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	/* Before the first run, the alerts beside the published baseline once the tab is wide enough
	   for two (a container query: the sidebar takes 240 px), each unchanged; stacked below that. */
	.below {
		container: summary-below / inline-size;
	}
	.pair {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
		margin-bottom: 1rem;
	}
	.pair > :global(.panel) {
		margin: 0;
	}
	@container summary-below (min-width: 56rem) {
		.pair {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: stretch;
		}
	}
	.more {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* Inline-block, so a long link wraps as text; at least 24 px tall (target size). */
	.more a {
		display: inline-block;
		min-height: 24px;
		line-height: 24px;
	}
</style>
