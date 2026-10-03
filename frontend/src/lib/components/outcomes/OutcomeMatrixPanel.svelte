<!--
	The outcome matrix (issue #53 R4, docs/ui.md § Outcome matrix,
	docs/model.md §2.14): on a saved run of the model, a demand sweep
	(R2, docs/api.md § Sweeps) runs the run's inputs at a few demand levels
	(demand.scale, 100 / 85 / 70 % by default) in the background, and the
	matrix shows, per level and per class of water year (the base run's own
	natural flow, the project's method), how the river's requirement fared in
	those years: the share of years met, n years, coloured by the project's
	risk cut-offs. Its own chunk: RunsTab loads it lazily.

	The Reserve site (settings.outcomes.siteNodeId, the outlet or a gauge with
	a rule table) is a project setting, so everyone reading the project sees
	the same matrix: an editor changes it here and it is saved at once;
	viewers see it, disabled.

	It reports what past years did at each level; it never picks one. The
	pending state follows the sweep's own status and its job's (polled), and
	the panel's data-state attribute says which, for the e2e spec.
-->
<script lang="ts">
	import { isScenarioRun, type ScenarioRunFields } from '$lib/components/runs/scenarioRun';
	import { onDestroy, untrack } from 'svelte';
	import type { EwrRuleTable, NetworkNode, ProjectSettings } from '@water-management/engine';
	import { api, type OutcomeSettings, type Project, type RunMeta, type Sweep } from '$lib/api';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { fmtDate } from '$lib/format/number';
	import {
		buildMatrixView,
		chooseSite,
		DEFAULT_DEMAND_LEVELS,
		demandSweepRequest,
		latestDemandSweep,
		matrixSites,
		parseDemandLevels,
		SWEEP_MEMBERS_MAX,
		sweepState,
		type MatrixView
	} from './matrix';
	import { resolveOutcomes } from './outcomeSettings';

	let {
		projectId,
		run,
		hasNaturalFlow,
		outcomes,
		nodes = [],
		ewrRules = [],
		onProjectChange,
		canEdit
	}: {
		projectId: string;
		/** The shown run: the sweep's base. */
		run: Pick<RunMeta, 'id' | 'startDate' | 'forecastFrom'> & ScenarioRunFields;
		/** The run stores a catchment natural_flow series (the year classes' input). */
		hasNaturalFlow: boolean;
		/** settings.outcomes (the method and the cut-offs); an older API sends none. */
		outcomes: OutcomeSettings | undefined;
		/** The network, for the Reserve site picker (the outlet and gauges). */
		nodes?: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId' | 'sortOrder'>[];
		/** settings.ewrRules: which gauges have a rule table. */
		ewrRules?: readonly Pick<EwrRuleTable, 'siteNodeId'>[];
		/** The project after the site was saved. */
		onProjectChange?: (p: Project) => void;
		canEdit: boolean;
	} = $props();

	const settings = $derived(resolveOutcomes({ outcomes }));
	const sites = $derived(matrixSites(nodes, ewrRules));
	/** The site just picked here, until the saved project comes back through `outcomes`. */
	let pickedSite = $state<{ id: string | null } | null>(null);
	let siteSaving = $state(false);
	let siteError = $state<string | null>(null);
	const chosen = $derived(chooseSite(pickedSite ? pickedSite.id : outcomes?.siteNodeId, sites));
	const ordinary = $derived(!isScenarioRun(run) && !run.forecastFrom);
	let sweep = $state<Sweep | null>(null);
	let natural = $state.raw<(number | null)[] | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let submitError = $state<string | null>(null);
	let submitting = $state(false);
	let levelsText = $state(DEFAULT_DEMAND_LEVELS.join(', '));
	let timer: ReturnType<typeof setTimeout> | undefined;
	let live = true;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const parsed = $derived(parseDemandLevels(levelsText));
	const shown = $derived(sweep ? sweepState(sweep) : null);
	const view = $derived.by((): MatrixView | null => {
		if (!sweep || shown?.kind !== 'complete' || !natural) return null;
		return buildMatrixView({ baseStartDate: run.startDate, baseNatural: natural, members: sweep.members, settings, site: chosen.site });
	});
	const dataState = $derived(loading ? 'loading' : !sweep ? 'empty' : (shown?.kind ?? 'loading'));

	/** A complete sweep with its members' series, and the base run's natural flow. */
	async function loadComplete(id: string) {
		const [full, nat] = await Promise.all([
			api.sweeps.get(projectId, id, { series: true }),
			cachedSeries(run.id, 'natural_flow', null, () => api.runs.series(projectId, run.id, 'natural_flow', null))
		]);
		if (!live || sweep?.id !== id) return;
		natural = nat.values as (number | null)[];
		sweep = full;
	}

	/** Follow a pending sweep on its own status until it completes or its job stops. */
	async function poll(id: string) {
		clearTimeout(timer);
		try {
			const s = await api.sweeps.get(projectId, id);
			if (!live || sweep?.id !== id) return;
			const st = sweepState(s);
			if (st.kind === 'complete') {
				await loadComplete(id);
				return;
			}
			sweep = s;
			if (st.kind === 'pending') timer = setTimeout(() => poll(id), 1500);
		} catch (e) {
			if (live) loadError = msg(e);
		}
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const found = latestDemandSweep(await api.sweeps.list(projectId, { baseRunId: run.id }));
			if (!live) return;
			sweep = found;
			if (found && found.status === 'complete') await loadComplete(found.id);
			else if (found && sweepState(found).kind === 'pending') timer = setTimeout(() => poll(found.id), 1500);
		} catch (e) {
			if (live) loadError = msg(e);
		} finally {
			if (live) loading = false;
		}
	}

	$effect(() => {
		if (!hasNaturalFlow || !untrack(() => ordinary)) {
			loading = false;
			return;
		}
		untrack(load);
	});

	async function start(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed.levels) return;
		submitting = true;
		submitError = null;
		try {
			const res = await api.sweeps.create(projectId, demandSweepRequest(run.id, parsed.levels));
			natural = null;
			sweep = res.sweep;
			await poll(res.sweep.id);
		} catch (err) {
			submitError = msg(err);
		} finally {
			submitting = false;
		}
	}

	/** Save the picked site as the project's (an editor's choice is everyone's). */
	async function pickSite(e: Event) {
		const raw = (e.currentTarget as HTMLSelectElement).value;
		const id = raw === '' ? null : raw;
		const before = pickedSite;
		pickedSite = { id };
		siteSaving = true;
		siteError = null;
		try {
			const p = await api.projects.update(projectId, { settings: { outcomes: { siteNodeId: id } } as unknown as Partial<ProjectSettings> });
			if (live) onProjectChange?.(p);
		} catch (err) {
			if (live) {
				pickedSite = before;
				siteError = msg(err);
			}
		} finally {
			if (live) siteSaving = false;
		}
	}

	onDestroy(() => {
		live = false;
		clearTimeout(timer);
	});

	const busy = $derived(submitting || shown?.kind === 'pending');
	const fmtBound = (c: { bounds: string; nYears: number }) => `${c.bounds} · ${c.nYears} ${c.nYears === 1 ? 'year' : 'years'}`;
</script>

<section aria-labelledby="outcome-h" data-testid="outcome-matrix" data-state={dataState}>
	<h3 id="outcome-h">Outcome matrix</h3>
	<p class="muted small lead">
		This run’s inputs at a few demand levels, by class of water year: how often the river’s requirement was met in past years of each
		kind. Historical, not a forecast; the choice of level is the WUA’s.
	</p>

	{#if !ordinary}
		<p class="muted">A demand sweep is based on an ordinary run of the model, not a scenario or forecast run.</p>
	{:else if !hasNaturalFlow}
		<p class="muted">This run has no catchment natural flow, so its water years can’t be classed. Run the model again.</p>
	{:else}
		{#if canEdit}
			<form class="start" onsubmit={start} novalidate>
				<div class="field">
					<label for="outcome-levels">Demand levels <span class="u">(% of today’s hydrological unit demand)</span></label>
					<input id="outcome-levels" type="text" bind:value={levelsText} disabled={busy} aria-describedby="outcome-levels-h" aria-invalid={!!parsed.error} />
					<span class="hint" id="outcome-levels-h">Up to {SWEEP_MEMBERS_MAX}, separated by commas. Each scales every hydrological unit’s irrigation demand; on a full-allocation run, its registered volume (80 means 80 % of it).</span>
				</div>
				<button type="submit" class="btn btn-primary" disabled={busy || !!parsed.error}>{sweep ? 'Run a new demand sweep' : 'Run demand sweep'}</button>
			</form>
			{#if parsed.error}<p class="err" role="alert">{parsed.error}</p>{/if}
		{/if}
		{#if submitError}<div class="alert alert-error" role="alert">{submitError}</div>{/if}

		{#if sites.length > 1}
			<div class="field site">
				<label for="outcome-site">Reserve site</label>
				<select id="outcome-site" value={chosen.site.id ?? ''} onchange={pickSite} disabled={!canEdit || siteSaving} aria-describedby="outcome-site-h">
					{#each sites as o (o.id ?? '')}
						<option value={o.id ?? ''}>{o.label}</option>
					{/each}
				</select>
				<span class="hint" id="outcome-site-h">
					Whose Reserve rule table the matrix reads, for everyone on the project{canEdit ? '' : ' (an editor can change it)'}. Days below the
					pragmatic EWR are only at the outlet.
				</span>
			</div>
		{/if}
		{#if chosen.notice}<p class="hint" data-testid="outcome-site-notice">{chosen.notice}</p>{/if}
		{#if siteError}<div class="alert alert-error" role="alert">{siteError}</div>{/if}

		<div role="status" aria-live="polite" class="status">
			{#if loading}
				<span class="muted">Loading…</span>
			{:else if shown?.kind === 'pending'}
				<span data-testid="sweep-status">{shown.text}</span>
				{#if shown.progress != null}<progress max="100" value={shown.progress} aria-label="Demand sweep progress">{shown.progress} %</progress>{/if}
			{:else if shown?.kind === 'stuck'}
				<span class="err" data-testid="sweep-status">{shown.text}</span>
			{/if}
		</div>
		{#if loadError}<div class="alert alert-error" role="alert">{loadError}</div>{/if}

		{#if !loading && !sweep && !loadError}
			<p class="muted" data-testid="outcome-empty">
				No demand sweep on this run yet.{canEdit ? '' : ' An editor can run one.'}
			</p>
		{/if}

		{#if view && sweep}
			<p class="small meta">
				{sweep.name} · run {fmtDate(sweep.completedAt ?? sweep.createdAt, true)}{sweep.createdBy ? ` by ${sweep.createdBy}` : ''}
				{#if sweep.engineVersion}· engine {sweep.engineVersion}{/if}
			</p>
			<div class="badges">
				{#if view.metricLabel}<span class="badge" data-testid="outcome-metric">Measure: {view.metricLabel}</span>{/if}
				<span class="badge">{view.method === 'quintiles' ? 'Quintiles' : 'Terciles'} of {view.nYears} complete water years</span>
				{#if view.cutoffsPending}<span class="badge badge-warn" data-testid="cutoffs-pending">Provisional risk cut-offs, not yet confirmed by the catchment’s hydrologist</span>{/if}
			</div>
			{#if view.siteMissing}
				<p class="alert alert-warning" data-testid="outcome-site-missing">{view.siteMissing}</p>
			{:else if view.columns.length && view.nYears}
				<div class="scroll">
					<table class="matrix" data-testid="outcome-table">
						<caption class="visually-hidden">Outcome by demand level (rows) and class of water year (columns)</caption>
						<thead>
							<tr>
								<th scope="col">Demand level</th>
								{#each view.columns as c (c.id)}
									<th scope="col">
										{c.label}
										<span class="bounds">{fmtBound(c)}</span>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each view.rows as r (r.id)}
								<tr>
									<th scope="row">{r.label}</th>
									{#if r.kind === 'cells'}
										{#each r.cells as cell, i (i)}
											<td class="cell {cell.risk ? `risk-${cell.risk}` : 'risk-none'}" data-risk={cell.risk ?? 'none'}>
												<strong>{cell.riskLabel}</strong>
												<span>{cell.text}</span>
											</td>
										{/each}
									{:else}
										<td colspan={view.columns.length} class="not-run" data-status={r.status}>
											<strong>{r.status === 'problems' ? 'Could not be applied' : r.status === 'failed' ? 'Run failed' : 'Not run'}:</strong>
											{r.lines.join(' ')}
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if view.cutoffsText}<p class="hint">{view.cutoffsText}{view.cutoffsPending ? ' These are placeholders until the hydrologist confirms them (Settings → Outcome matrix).' : ''}</p>{/if}
			{#if view.excluded.length}
				<p class="hint">Not classed: {view.excluded.map((y) => `${y.label} (${y.reason === 'partial' ? 'part year' : 'a day missing'})`).join(', ')}.</p>
			{/if}
			{#if view.warnings.length}
				<ul class="warnings" data-testid="outcome-warnings">
					{#each view.warnings as w (w)}<li>{w}</li>{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.lead {
		max-width: 80ch;
		margin: 0 0 0.75rem;
	}
	.start {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1rem;
	}
	.start input {
		min-width: 14rem;
	}
	.site {
		margin: 0.75rem 0 0;
		max-width: 60ch;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	.status {
		margin: 0.5rem 0;
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}
	.meta {
		color: var(--text-muted);
		margin: 0.25rem 0;
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.25rem 0 0.5rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.matrix {
		border-collapse: collapse;
		min-width: 100%;
	}
	.matrix th,
	.matrix td {
		border: 1px solid var(--border);
		padding: 0.45rem 0.6rem;
		vertical-align: top;
		text-align: left;
	}
	.bounds {
		display: block;
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.cell {
		min-width: 11rem;
		font-size: 0.8rem;
		border-left-width: 4px;
	}
	.cell strong {
		display: block;
		font-size: 0.85rem;
	}
	.risk-lower {
		background: var(--success-soft);
		border-left-color: var(--success);
	}
	.risk-increasing {
		background: var(--warning-soft);
		border-left-color: var(--warning);
	}
	.risk-high {
		background: var(--danger-soft);
		border-left-color: var(--danger);
	}
	.risk-none {
		color: var(--text-muted);
	}
	.not-run {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.warnings {
		font-size: 0.8rem;
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
</style>
