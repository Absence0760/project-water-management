<script lang="ts">
	// River & reserve (issue #17, option A · Outcomes): one run's river, for
	// the run the URL names (`run=`) or else the newest (river.ts pickRiverRun).
	// The page header and run picker, two KPI tiles (river.ts riverKpis), then
	// the flow against the EWR (the app's one flow vs reserve chart, with its
	// 30 days / 1 year / All switch and the days below the reserve shaded; the
	// Summary shows the days below by month and links here, issue #162) beside
	// the days below the reserve per water year. The page flows in the window's
	// one scroll (nothing is sized to the window, and no card or table scrolls
	// inside itself); the chart has a fixed height. Below it, the panels that were Runs & results' River & Reserve group,
	// moved unchanged with their `#res-…` ids: Reserve compliance, EWR by month
	// (with the EWR required vs met per site and water year under its grid),
	// the uncertainty bands (with the sensitivity runs under them), the outcome
	// matrix, the seasonal outlook and the water account.
	import { onDestroy, tick, untrack } from 'svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type Project, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import { runOptionLabel } from '$lib/components/compare/picker';
	import EwrHeatmap from '$lib/components/ewr/EwrHeatmap.svelte';
	import EwrRequiredMet from '$lib/components/ewr/EwrRequiredMet.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { runHref } from '$lib/components/overview/attention';
	import { historyDays } from '$lib/components/overview/latestRun';
	import { hasRuleLine } from '$lib/components/overview/summaryChart';
	import { headlineSite } from '$lib/components/runs/ewrAssurance';
	import { detailCache } from '$lib/components/runs/cache';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { holdAnchor } from '$lib/help/anchor';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import UncertaintyPanel from '$lib/components/uncertainty/UncertaintyPanel.svelte';
	import SensitivityPanel from '$lib/components/uncertainty/SensitivityPanel.svelte';
	import OutcomeMatrixPanel from '$lib/components/outcomes/OutcomeMatrixPanel.svelte';
	import OutlookPanel from '$lib/components/outlook/OutlookPanel.svelte';
	import WaterAccountPanel from '$lib/components/reliability/WaterAccountPanel.svelte';
	import { riverAnchor } from './links';
	import { ewrRuleText, pickRiverRun, reserveYearsWords, riverKpis, riverNavGroups } from './river';
	import SectionNav from '$lib/components/common/SectionNav.svelte';

	// The panels every run shows (the uncertainty bands, the outcome matrix, the seasonal outlook, the
	// water account) are in this tab's chunk: only this tab uses them, and as chunks of their own they
	// loaded on every visit anyway, paying split overhead (issue #9). The flow chart (uPlot), the
	// water-year bars (shared with Compare runs) and Reserve compliance (only with a rule table) stay lazy.
	const loadFlowVsReserve = () => import('$lib/components/overview/FlowVsReserve.svelte');
	const loadReserveYears = () => import('$lib/components/compare/ReserveYearsChart.svelte');
	const loadAssurancePanel = () => import('$lib/components/runs/EwrAssurancePanel.svelte');

	let {
		projectId,
		project,
		editor,
		runs,
		canEdit,
		onProjectChange
	}: {
		projectId: string;
		project: Project;
		editor: ModelEditor;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The outcome matrix saved a project setting (its Reserve site): the page takes the new project. */
		onProjectChange?: (p: Project) => void;
	} = $props();

	const pick = $derived(pickRiverRun(runs, page.url.searchParams.get('run')));
	// Newest first, for the picker.
	const ordered = $derived([...(runs ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
	const name = (r: RunMeta) => r.label || 'Untitled run';

	// A run picked is a new history entry, so Back returns to the run before.
	function choose(id: string) {
		const url = new URL(page.url);
		url.searchParams.set('run', id);
		url.hash = '';
		goto(url, { noScroll: true, keepFocus: true });
	}

	// --- the run's record and the one before it, through the Runs tab's cache ---
	type Detail = { run: Run; series: RunSeriesRef[] };
	let detail = $state.raw<Detail | null>(null);
	let previous = $state.raw<Run | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let previousError = $state<string | null>(null);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function fetchDetail(id: string): Promise<Detail> {
		const hit = detailCache.get(id);
		if (hit) return hit;
		const d = await api.runs.get(projectId, id);
		detailCache.set(id, d);
		return d;
	}

	let loadKey = '';
	async function load(runId: string, previousId: string | null) {
		const key = (loadKey = `${runId}|${previousId ?? ''}`);
		detail = detailCache.get(runId) ?? null;
		previous = previousId ? (detailCache.get(previousId)?.run ?? null) : null;
		error = previousError = null;
		loading = !detail;
		const prev = previousId && !previous ? fetchDetail(previousId) : null;
		try {
			const d = await fetchDetail(runId);
			if (loadKey === key) detail = d;
		} catch (e) {
			if (loadKey === key) error = msg(e);
		} finally {
			if (loadKey === key) loading = false;
		}
		if (prev) {
			try {
				const p = await prev;
				if (loadKey === key) previous = p.run;
			} catch (e) {
				if (loadKey === key) previousError = msg(e);
			}
		}
	}
	const retry = () => pick && load(pick.run.id, pick.previous?.id ?? null);
	$effect(() => {
		const runId = pick?.run.id ?? null;
		const previousId = pick?.previous?.id ?? null;
		untrack(() => {
			if (!runId) {
				loadKey = '';
				detail = previous = null;
			} else if (`${runId}|${previousId ?? ''}` !== loadKey) load(runId, previousId);
		});
	});

	/** The record shown: only once it is the run picked, never a stale one while the next loads. */
	const shown = $derived(detail && detail.run.id === pick?.run.id ? detail : null);
	const summary = $derived(shown?.run.summary ?? null);
	// A Reserve rule table judges the Reserve (the tile's rule months, Reserve compliance), so the panels that count
	// the pragmatic EWR are named for it, not "the reserve" (issue #177); the flow chart keeps its name when it
	// draws the outlet's rule requirement.
	const ruleTable = $derived(!!summary && headlineSite(summary) !== null);
	const ruleLine = $derived(!!shown && hasRuleLine(shown.series));
	const yearsWords = $derived(reserveYearsWords(ruleTable));
	const kpis = $derived(
		shown ? riverKpis(shown.run.summary, historyDays(shown.run), previous && previous.id === pick?.previous?.id ? { summary: previous.summary, days: historyDays(previous) } : null) : []
	);

	// --- a link to one of the panels (`#res-reserve`, or an old Runs & results link sent here):
	// the panels render once the record is in, after the browser's own jump, so scroll there then
	// and hold it while the page settles (as RunsTab does), with focus on the panel's heading.
	let fragmentShown = false;
	let releaseFragment = () => {};
	let destroyed = false;
	$effect(() => {
		if (!shown || fragmentShown) return;
		fragmentShown = true;
		const hash = untrack(() => page.url.hash.slice(1));
		if (!riverAnchor(hash)) return;
		tick().then(() => {
			const el = destroyed ? null : document.getElementById(hash);
			if (!el) return;
			releaseFragment = holdAnchor(el);
			// Most panels are lazy chunks: their heading may arrive after the panel's box, so wait for it.
			const focusHeading = () => {
				const heading = el.querySelector<HTMLElement>('h2, h3, h4');
				if (!heading) return false;
				if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
				heading.focus({ preventScroll: true });
				return true;
			};
			if (focusHeading()) return;
			const mo = new MutationObserver(() => focusHeading() && mo.disconnect());
			mo.observe(el, { childList: true, subtree: true });
			stopWaiting = () => mo.disconnect();
		});
	});
	let stopWaiting = () => {};
	onDestroy(() => {
		destroyed = true;
		releaseFragment();
		stopWaiting();
	});

	// --- the chart's fixed height: generous where the page is wide (it is the page's main content), less on a phone.
	let firstW = $state(0);
	const flowH = $derived(firstW >= 640 ? 420 : 280);

	// The section header (workspace/SectionHeader) carries the title; the page gives it the run line,
	// the run picker and Open in Runs & results.
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));

	const LEGACY_TITLE =
		'Legacy runoff model (b023 workbook): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence.';
</script>

{#snippet headerContext()}
	{#if pick}
		<span class="river-context" data-testid="river-context">
			<strong class="lbl">{name(pick.run)}</strong>
			{#if pick.run.legacy}<span class="badge badge-warn" title={LEGACY_TITLE}>Workbook comparison</span>{/if}
			{#if pick.run.evidence === 'current'}<span class="badge badge-owner">Evidence</span>{/if}
			<span>· {fmtDay(pick.run.startDate)} – {fmtDay(pick.run.endDate)}</span>
			<span>· engine {pick.run.engineVersion}</span>
			{#if summary}<span>· {ewrRuleText(summary)}</span>{/if}
		</span>
	{:else}
		<span>Whether enough water stays in the river for its Ecological Reserve, run by run.</span>
	{/if}
{/snippet}
{#snippet headerActions()}
	{#if pick}
		<!-- Laid out like the other sections' run pickers (Units & supply, Allocations): the name is for screen readers,
		     so on a phone the select fills a row of its own instead of sitting under a "Run" line. -->
		<select class="run-pick" aria-label="Run" value={pick.run.id} onchange={(e) => choose(e.currentTarget.value)}>
			{#each ordered as r, i (r.id)}<option value={r.id}>{runOptionLabel(r, (iso) => fmtDate(iso, true), i === 0)}</option>{/each}
		</select>
		<a class="btn" href={runHref(pick.run.id)}>Open in Runs &amp; results</a>
	{/if}
{/snippet}

{#if runs === null}
	<p class="alert alert-error" role="alert">The run list couldn’t be loaded, so there is nothing to show yet. Reload the page to try again.</p>
{:else if !pick}
	<section class="panel empty" aria-labelledby="river-empty-h">
		<h2 id="river-empty-h">No run yet</h2>
		<p class="muted">
			After a run, this page shows the simulated outflow against the EWR, how often the reserve was met, the days below it each
			water year, compliance by month and the uncertainty on those findings.
		</p>
		{#if canEdit}<a class="btn btn-primary" href="?tab=runs">Run the model</a>{:else}<p class="muted small">An editor can run the model.</p>{/if}
	</section>
{:else}
	<!-- In-page menu (common/SectionNav, as on Settings and Runs): the page runs to seven panels
	     under its first screen. Its group names show on the bar (issue #162), so the gaps between
	     the groups read as groups. -->
	{#if shown && summary}<SectionNav groups={riverNavGroups(ruleTable, ruleLine)} label="River sections" />{/if}
	<div class="first" bind:clientWidth={firstW}>
		<div class="top">
		<LoadState loading={loading && !shown} error={shown ? null : error} {retry}>
			<dl class="stats kpis" aria-label="River and reserve figures">
				{#each kpis as k (k.id)}
					<div class="stat" class:flagged={k.flagged} data-kpi={k.id}>
						<dt>{k.term}{#if k.help} <HelpTip key={k.help} />{/if}</dt>
						<dd class="value" class:none={k.value === '–'}>{k.value}{#if k.unit}<small>{k.unit}</small>{/if}</dd>
						{#each k.sub as line, i (i)}<dd class="sub">{line}</dd>{/each}
						{#if k.delta}<dd class="sub change"><Delta m={k.delta} spec={k.spec} /> vs previous run</dd>{/if}
					</div>
				{/each}
			</dl>
			{#if pick.previous}
				<p class="muted small after">
					{#if previousError}
						The previous run couldn’t be loaded ({previousError}), so no changes are shown.
					{:else}
						Changes are against the previous run, <a href="?tab=river&run={encodeURIComponent(pick.previous.id)}">{name(pick.previous)}</a>.
					{/if}
				</p>
			{/if}
		</LoadState>
		</div>
		{#if shown}
			<div class="cols">
				<div class="flow-cell" id="res-ewr">
					<Lazy load={loadFlowVsReserve}>
						{#snippet children(FlowVsReserve)}
							<FlowVsReserve projectId={projectId} runId={shown!.run.id} refs={shown!.series} forecastFrom={shown!.run.summary.forecast?.from ?? null} height={flowH} units pannable {ruleTable} />
						{/snippet}
					</Lazy>
				</div>
				<section class="panel years" id="res-reserve-years" aria-labelledby="years-h">
					<h2 id="years-h">{yearsWords.heading}</h2>
					<Lazy load={loadReserveYears}>
						{#snippet children(ReserveYearsChart)}
							<ReserveYearsChart
								runs={[{ name: name(shown!.run), projectId, runId: shown!.run.id, colour: 'var(--series-2)', forecastFrom: shown!.run.summary.forecast?.from ?? null }]}
								minHeight={240}
								below={yearsWords.below}
							/>
						{/snippet}
					</Lazy>
				</section>
			</div>
		{/if}
	</div>

	{#if shown && summary}
		{@const shownRun = shown.run}
		{@const runSeries = shown.series}
		<div class="panels">
			{#if summary.ewrAssurance?.length}
				<div class="panel" id="res-reserve">
					<Lazy load={loadAssurancePanel}>
						{#snippet children(EwrAssurancePanel)}
							<EwrAssurancePanel sites={summary.ewrAssurance ?? []} />
						{/snippet}
					</Lazy>
				</div>
			{/if}
			<div class="panel" id="res-ewr-grid">
				{#if summary.ewrCompliance}
					<EwrHeatmap compliance={summary.ewrCompliance} />
				{:else}
					<h3>EWR compliance by month</h3>
					<p class="muted">This run was made before the monthly EWR compliance grid existed. Run the model again to see it.</p>
				{/if}
				<!-- The volume side of compliance, per site and water year (the water account's tail until issue #175). -->
				<EwrRequiredMet assurance={summary.supplyAssurance} />
			</div>
			<!-- The uncertainty bands (issue #4 phase 9) beside the EWR and Reserve findings they qualify, and under
			     them the sensitivity runs (CR-21): the same question for the inputs the record can't settle. -->
			<div class="panel" id="res-uncertainty">
				{#key shownRun.id}
					<UncertaintyPanel {projectId} runId={shownRun.id} runEngineVersion={shownRun.engineVersion} canEdit={canEdit} />
					<SensitivityPanel {projectId} runId={shownRun.id} />
				{/key}
			</div>
			<div class="panel" id="res-outcomes">
				{#key shownRun.id}
					<OutcomeMatrixPanel
						{projectId}
						run={shownRun}
						hasNaturalFlow={runSeries.some((r) => r.nodeId === null && r.key === 'natural_flow')}
						outcomes={project.settings.outcomes}
						nodes={editor.model.nodes}
						ewrRules={project.settings.ewrRules}
						{onProjectChange}
						canEdit={canEdit}
					/>
				{/key}
			</div>
			<div class="panel" id="res-outlook">
				{#key shownRun.id}
					<OutlookPanel {projectId} run={shownRun} outlook={project.settings.outlook} canEdit={canEdit} droughtRestriction={project.settings.droughtRestriction ?? null} {onProjectChange} />
				{/key}
			</div>
			<div class="panel" id="res-water-account">
				<WaterAccountPanel assurance={summary.supplyAssurance} engineVersion={shownRun.engineVersion} />
			</div>
		</div>
	{/if}
{/if}

<style>
	.river-context {
		display: contents;
	}
	.river-context .lbl {
		color: var(--text);
	}
	.empty {
		max-width: 44rem;
	}
	.empty h2 {
		margin-top: 0;
		font-size: 1.05rem;
	}
	.first {
		display: grid;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	/* Two tiles side by side, at every width. */
	.kpis {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-bottom: 0.4rem;
	}
	@media (max-width: 760px) {
		.kpis {
			gap: 0.5rem;
		}
	}
	.stat dt {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat {
		padding: 0.75rem 0.95rem;
	}
	.stat dd.value {
		font-size: 1.6rem;
		line-height: 1.2;
		margin: 0.1rem 0;
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.stat dd.none {
		color: var(--text-muted);
	}
	.stat.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	.after {
		margin: 0;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.flow-cell {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.flow-cell :global(.flow) {
		margin-bottom: 0;
	}
	.years {
		display: flex;
		flex-direction: column;
		min-width: 0;
		margin: 0;
	}
	.years h2 {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
	}
	/* The page is the one scroll: the water-year table (Show as a table) grows with its rows instead of
	   scrolling in its 18rem box. */
	.years :global(div.table-wrap) {
		max-height: none;
	}
	/* Wide: the bars beside the chart, as tall as it (the grid row stretches them; their plot takes what
	   is left). Opening their table makes the row taller; the chart keeps its height at the row's top. */
	@media (min-width: 1100px) {
		.cols {
			grid-template-columns: minmax(0, 1fr) clamp(300px, 28vw, 400px);
			align-items: stretch;
		}
		.flow-cell {
			align-self: start;
		}
	}
	/* The panels moved from Runs & results, full width: Reserve compliance's tables and the EWR grid need it. */
	.panels > .panel {
		min-width: 0;
	}
	/* Nor do the panels' tables scroll in a box of their own (the app's 70vh cap, the EWR grid's): they
	   grow with the page and scroll only sideways when they are wide. Long ones fold instead
	   (Reserve compliance's month by month shows its first rows, then Show all). */
	.panels :global(div.table-wrap) {
		max-height: none;
	}
	.run-pick {
		max-width: min(34rem, 60vw);
		min-height: 36px;
	}
	/* The section header gives the picker a full row on a phone (workspace/SectionHeader). */
	@media (max-width: 640px) {
		.run-pick {
			min-height: 44px;
		}
	}
</style>
