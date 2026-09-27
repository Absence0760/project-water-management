<script lang="ts">
	import { untrack } from 'svelte';
	import type { SeriesMeta } from '@water-management/engine';
	import { api, type Project, type Run, type RunMeta } from '$lib/api';
	import AlertsPanel from '$lib/components/alerts/AlertsPanel.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import { cachedSeries, detailCache } from '$lib/components/runs/cache';
	import { downloads } from '$lib/export';
	import { fmtNum, localIsoDate } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { attention } from './attention';
	import ImportReportPanel from './ImportReportPanel.svelte';
	import { checklist } from './checklist';
	import LatestRun from './LatestRun.svelte';
	import { pickRuns, type DamsState } from './latestRun';
	import { damLevelsFromSummary, damsInRun, damsToday, loadDamLevels, type DamLevel } from './damLevels';
	import MembersPanel from './MembersPanel.svelte';
	import RecentNotes from '$lib/components/notes/RecentNotes.svelte';
	import FarmersPanel from './FarmersPanel.svelte';
	import NeedsAttention from './NeedsAttention.svelte';
	import PublishedBaseline from './PublishedBaseline.svelte';
	import SetupChecklist from './SetupChecklist.svelte';
	import ShareLinksPanel from './ShareLinksPanel.svelte';
	import TeamPanel from './TeamPanel.svelte';

	// The flow chart pulls in uPlot: its own chunk, so the page's first paint doesn't wait for it.
	const loadFlowVsReserve = () => import('./FlowVsReserve.svelte');
	// The Dam levels table: its own chunk too (the levels are fetched here, for the Dams today card as well).
	const loadDamTable = () => import('./DamLevels.svelte');
	// Supply by farm waits for the run's record too: its own chunk keeps the page's first chunk under its budget.
	const loadSupply = () => import('./SupplyByFarm.svelte');

	let {
		project,
		editor,
		series,
		runs,
		canEdit,
		isOwner,
		currentUserId,
		visibleTabs,
		onProjectChange,
		onLeftProject
	}: {
		project: Project;
		editor: ModelEditor;
		/** The page's input-series list (null if it couldn't be loaded). */
		series: SeriesMeta[] | null;
		/** The page's runs list (null if it couldn't be loaded). */
		runs: RunMeta[] | null;
		canEdit: boolean;
		isOwner: boolean;
		currentUserId: string;
		/** The tabs this member is shown (lib/workspace/tabs.ts); the setup checklist links only to these. */
		visibleTabs: readonly string[];
		onProjectChange: (p: Project) => void;
		onLeftProject: () => void;
	} = $props();

	// Form fields start from the loaded project and are reset after each save.
	let name = $state(untrack(() => project.name));
	let description = $state(untrack(() => project.description ?? ''));
	// The project's time zone dates its downloads (issue #45); an older API sends none.
	const DEFAULT_TIME_ZONE = 'Africa/Johannesburg';
	let timeZone = $state(untrack(() => project.timeZone ?? DEFAULT_TIME_ZONE));
	const zones = (() => {
		try {
			return Intl.supportedValuesOf('timeZone');
		} catch {
			return [DEFAULT_TIME_ZONE];
		}
	})();
	let saving = $state(false);
	let error = $state<string | null>(null);
	let savedAt = $state<number | null>(null);

	const detailsDirty = $derived(
		name.trim() !== project.name || description.trim() !== (project.description ?? '') || timeZone.trim() !== (project.timeZone ?? DEFAULT_TIME_ZONE)
	);

	// The series and runs lists come from the page, which loads them before any
	// tab renders and refreshes them after an upload or a run, so the counts and
	// checklist are final on the first frame and never go stale.
	const seriesCount = $derived(series?.length ?? null);
	const runCount = $derived(runs?.length ?? null);

	// Built from the model as edited (unsaved changes included) so the
	// checklist ticks as soon as the user fills a step in.
	const steps = $derived(
		checklist({ model: editor.model, settings: project.settings, series, runs, updatedAt: project.updatedAt })
	);

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

	// The latest run's stored series (its detail record, cached by fetchRun), for the flow chart.
	const latestRefs = $derived(latestRun ? (detailCache.get(latestRun.id)?.series ?? []) : []);
	/** The latest run's record, once it is the one picked (not a stale one while the next loads). */
	const shown = $derived(latestRun && latestRun.id === pick?.latest.id ? latestRun : null);

	// --- dams: each dam's level at the end of the latest run (damLevels.ts), for
	// the Dams today card and the Dam levels table: from the run summary, or for
	// a run older than engine 1.1.0 from each dam's daily storage series through
	// the Runs cache, a few at a time. Capacity and the
	// minimum level come from the run's own model, so a later edit doesn't skew them.
	let damLevels = $state.raw<DamLevel[]>([]);
	let damsTotal = $state(0);
	let damsDone = $state(0);
	let damsLoading = $state(false);
	let damsError = $state<string | null>(null);
	let damsAttempt = $state(0);
	let damsKey = '';
	$effect(() => {
		const run = shown;
		const key = run ? `${run.id}|${damsAttempt}` : '';
		untrack(() => {
			if (key === damsKey) return;
			damsKey = key;
			damLevels = [];
			damsDone = 0;
			damsError = null;
			if (!run) {
				damsTotal = 0;
				damsLoading = false;
				return;
			}
			const id = run.id;
			const list = damsInRun(
				run.model?.nodes as { id: string }[] | undefined,
				editor.model.nodes,
				detailCache.get(id)?.series ?? []
			);
			damsTotal = list.length;
			// A run from engine ≥ 1.1.0 carries the figures in its summary (issue #55): no series to fetch.
			const fromSummary = damLevelsFromSummary(list, run.summary.farms, run.endDate);
			if (fromSummary) {
				damLevels = fromSummary;
				damsDone = list.length;
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
				(n) => {
					if (current()) damsDone = n;
				}
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

	// --- the first screen (issue #17 A1): KPIs, then the flow chart beside
	// Needs attention and Supply by farm. On a wide, tall enough window it is
	// exactly the height left below its own top edge (measured, not assumed, as
	// the Network's map), the chart filling what the KPIs leave; the rest of the
	// Summary follows below it.
	const FIT_QUERY = '(min-width: 1100px) and (min-height: 620px)';
	let fit = $state(false);
	$effect(() => {
		const mq = matchMedia(FIT_QUERY);
		const on = () => (fit = mq.matches);
		on();
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	let firstEl: HTMLDivElement | undefined = $state();
	let firstTop = $state(0);
	$effect(() => {
		if (!firstEl) return;
		const el = firstEl;
		const measure = () => (firstTop = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	const runFarms = $derived(shown?.summary.farms ?? []);
	const modelFarmIds = $derived(new Set(editor.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id)));

	const today = localIsoDate();
	const attentionItems = $derived(
		attention({
			model: editor.model,
			series,
			latest: pick?.latest ?? null,
			summary: latestRun && latestRun.id === pick?.latest.id ? latestRun.summary : null,
			today
		})
	);

	const stats = $derived.by(() => {
		const m = editor.model;
		const farms = m.nodes.filter((n) => n.kind === 'farm');
		const outlet = m.nodes.find((n) => n.downstreamNodeId === null);
		return {
			farms: farms.length,
			gauges: m.nodes.length - farms.length,
			areaKm2: m.nodes.reduce((s, n) => s + (n.areaKm2 || 0), 0),
			damM3: m.nodes.reduce((s, n) => s + (n.damCapacityM3 || 0), 0),
			dams: m.nodes.filter((n) => n.damCapacityM3 > 0).length,
			crops: m.crops.length,
			irrigatedHa: m.cropAreas.reduce((s, a) => s + (a.areaM2 || 0), 0) / 10_000,
			transfers: m.transfers.filter((t) => t.enabled).length,
			outlet: outlet?.name ?? null
		};
	});

	// Anyone who can open the project can take a copy of it (viewers included).
	const projectDownloads = $derived([
		{
			label: 'Download project (JSON)',
			url: downloads.project(project.id),
			hint: 'Model, settings and input series (runs not included)'
		}
	]);

	async function saveDetails(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		error = null;
		try {
			const zoneChanged = timeZone.trim() !== (project.timeZone ?? DEFAULT_TIME_ZONE);
			const p = await api.projects.update(project.id, {
				name: name.trim(),
				description: description.trim(),
				...(zoneChanged ? { timeZone: timeZone.trim() } : {})
			});
			onProjectChange(p);
			name = p.name;
			description = p.description ?? '';
			timeZone = p.timeZone ?? DEFAULT_TIME_ZONE;
			savedAt = Date.now();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<!-- Summary (issue #17, option A, board A1): the results first. Before the
     first run there are none, so the setup checklist leads instead. -->
{#if !pick}
	<SetupChecklist {steps} tabs={visibleTabs} />
	{#if attentionItems.length}<div class="pre-run"><NeedsAttention items={attentionItems} /></div>{/if}
{:else}
	<div class="first" class:fit bind:this={firstEl} style:--first-top="{firstTop}px">
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
		<div class="cols" class:solo={!attentionItems.length && !runFarms.length}>
			<div class="chart-cell">
				{#if shown}
					<Lazy load={loadFlowVsReserve}>
						{#snippet children(FlowVsReserve)}
							<FlowVsReserve projectId={project.id} runId={shown!.id} refs={latestRefs} forecastFrom={shown!.summary.forecast?.from ?? null} fill={fit} />
						{/snippet}
					</Lazy>
				{/if}
			</div>
			{#if attentionItems.length || runFarms.length}
				<div class="side">
					<NeedsAttention items={attentionItems} />
					{#if runFarms.length}
						<Lazy load={loadSupply}>
							{#snippet children(SupplyByFarm)}<SupplyByFarm farms={runFarms} {modelFarmIds} />{/snippet}
						</Lazy>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Alerts firing now, and (editors) which alert emails the catchment sends (WP-2.13). -->
<AlertsPanel projectId={project.id} {canEdit} />

<!-- What stakeholders and farmers see: the published run and the WUA's notice (WP-2.3). -->
<PublishedBaseline projectId={project.id} {runs} {canEdit} />

{#if shown && damsTotal}
	<Lazy load={loadDamTable}>
		{#snippet children(DamLevels)}
			<DamLevels
				runId={shown!.id}
				levels={damLevels}
				total={damsTotal}
				done={damsDone}
				loading={damsLoading}
				error={damsError}
				retry={() => damsAttempt++}
			/>
		{/snippet}
	</Lazy>
{/if}

{#if pick}<SetupChecklist {steps} tabs={visibleTabs} />{/if}

<h2 class="model-h">The model</h2>
<!-- Each fact links to the tab where it is edited or looked at; the link is
     stretched over the whole tile, so the tile is the click target. -->
<dl class="stats">
	<div class="stat"><dt><a href="?tab=network">Units</a></dt><dd>{fmtNum(stats.farms)}<small>+ {stats.gauges} gauge{stats.gauges === 1 ? '' : 's'}</small></dd></div>
	<div class="stat"><dt><a href="?tab=network">Catchment area</a></dt><dd>{fmtNum(stats.areaKm2, 2)}<small>km²</small></dd></div>
	<div class="stat"><dt><a href="?tab=network">Dam capacity ({stats.dams} dam{stats.dams === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.damM3)}<small>m³</small></dd></div>
	<div class="stat"><dt><a href="?tab=crops">Irrigated area ({stats.crops} crop{stats.crops === 1 ? '' : 's'})</a></dt><dd>{fmtNum(stats.irrigatedHa, 1)}<small>ha</small></dd></div>
	<div class="stat"><dt><a href="?tab=transfers">Active transfers</a></dt><dd>{fmtNum(stats.transfers)}</dd></div>
	<div class="stat"><dt><a href="?tab=series">Time series</a></dt><dd>{seriesCount === null ? '–' : fmtNum(seriesCount)}</dd></div>
	<div class="stat"><dt><a href="?tab=runs">Model runs</a></dt><dd>{runCount === null ? '–' : fmtNum(runCount)}</dd></div>
	<div class="stat"><dt><a href="?tab=network">Outflow gauge</a></dt><dd class="text">{stats.outlet ?? '–'}</dd></div>
</dl>

<div class="grid">
	<div class="col">
		<section class="panel" aria-labelledby="details-h">
			<div class="panel-head">
				<h2 id="details-h">Project details</h2>
				<DownloadMenu items={projectDownloads} />
			</div>
			<form onsubmit={saveDetails}>
				{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
				<div class="field">
					<label for="pd-name">Name</label>
					<input id="pd-name" required maxlength="200" readonly={!canEdit} bind:value={name} />
				</div>
				<div class="field">
					<label for="pd-desc">Description</label>
					<textarea id="pd-desc" rows="4" readonly={!canEdit} bind:value={description}></textarea>
				</div>
				<div class="field">
					<label for="pd-tz">Time zone</label>
					<input id="pd-tz" required maxlength="64" autocomplete="off" list="pd-tz-list" readonly={!canEdit} bind:value={timeZone} aria-describedby="pd-tz-h" />
					<datalist id="pd-tz-list">{#each zones as z (z)}<option value={z}></option>{/each}</datalist>
					<span class="hint" id="pd-tz-h">An IANA name, like Africa/Johannesburg. Downloads are dated by the day here.</span>
				</div>
				{#if canEdit}
					<div class="form-row">
						<button class="btn btn-primary" type="submit" disabled={saving || !detailsDirty || !name.trim() || !timeZone.trim()}>
							{saving ? 'Saving…' : 'Save details'}
						</button>
						{#if savedAt && !detailsDirty}<span class="muted" role="status">Saved.</span>{/if}
					</div>
				{/if}
			</form>
		</section>
		<!-- An imported project's record of what the importer flagged; nothing for any other. -->
		<ImportReportPanel projectId={project.id} />
		<!-- The newest notes on anything in the project, and the project's own notes (WP-2.7). -->
		<RecentNotes projectId={project.id} />
	</div>

	<!-- Who can open the project: the owning team, the people shared directly, then the farmers (their own farms only). -->
	<div class="col access">
		<TeamPanel {project} {isOwner} {currentUserId} {onProjectChange} />
		<MembersPanel projectId={project.id} team={project.team} {isOwner} {currentUserId} {onLeftProject} />
		<FarmersPanel projectId={project.id} {isOwner} farms={editor.model.nodes.filter((n) => n.kind === 'farm').map((n) => ({ id: n.id, name: n.name }))} />
		<!-- Read-only links to the published baseline for people outside the project (WP-2.3 phase 2): owners only. -->
		{#if isOwner}<ShareLinksPanel projectId={project.id} />{/if}
	</div>
</div>

<style>
	.first {
		display: grid;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.pre-run {
		margin-bottom: 1rem;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) clamp(280px, 26vw, 340px);
		gap: 1rem;
		align-items: start;
	}
	.cols.solo {
		grid-template-columns: minmax(0, 1fr);
	}
	.chart-cell,
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.chart-cell :global(.flow) {
		margin-bottom: 0;
	}
	@media (max-width: 1099px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	/* Wide and tall enough: the first screen is the height left in the window
	   below its top (less the save bar when it shows), the chart takes what
	   the KPIs leave, and the side column's cards scroll inside themselves. */
	.first.fit {
		height: max(560px, calc(100vh - var(--first-top, 0px) - var(--dock-h, 0px) - 1rem));
		grid-template-rows: auto minmax(0, 1fr);
	}
	.fit .cols {
		min-height: 0;
		align-items: stretch;
	}
	.fit .chart-cell,
	.fit .side {
		min-height: 0;
	}
	.fit .side > :global(.attention) {
		flex: 0 1 auto;
		min-height: 0;
		overflow: auto;
	}
	.fit .side > :global(.supply) {
		flex: 1 1 auto;
		min-height: 6rem;
		overflow: auto;
	}
	.model-h {
		margin: 1.25rem 0 0.5rem;
		font-size: 1.05rem;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: 1rem;
		align-items: start;
	}
	/* Eight facts: one row on wide screens, then 4 × 2, then 2 × 4. */
	dl.stats {
		grid-template-columns: repeat(8, minmax(0, 1fr));
	}
	@media (max-width: 1280px) {
		dl.stats {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (max-width: 560px) {
		dl.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.col {
		display: grid;
		gap: 0;
		min-width: 0;
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	textarea,
	input {
		width: 100%;
	}
	/* The description grows with its text (up to a cap) instead of hiding it
	   behind an inner scrollbar, which on a phone showed only a few lines.
	   Browsers without field-sizing keep the fixed four rows. */
	textarea {
		field-sizing: content;
		min-height: 6.5rem;
		max-height: 24rem;
	}
	.stat {
		position: relative;
	}
	.stat:hover {
		border-color: var(--accent);
	}
	.stat:has(a:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.stat dt a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	.stat dt a:focus-visible {
		outline: none;
	}
	.stat dt a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	dd.text {
		font-size: 1rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
