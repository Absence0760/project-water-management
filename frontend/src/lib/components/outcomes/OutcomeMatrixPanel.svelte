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
	the panel's data-state attribute says which, for the e2e spec. Without a
	sweep it is one row (common/ToolRow, issue #465) until an editor presses
	Run…, which opens the form with focus on the levels.
-->
<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import ToolRow from '#lib/components/common/ToolRow.svelte';
	import { isScenarioRun, type ScenarioRunFields } from '#lib/components/runs/scenarioRun.js';
	import { onDestroy, tick, untrack } from 'svelte';
	import type { EwrRuleTable, NetworkNode, ProjectSettings } from '@water-management/engine';
	import { api, type OutcomeSettings, type Project, type RunMeta, type Sweep } from '#lib/api/index.js';
	import { cachedSeries } from '#lib/components/runs/cache.js';
	import { fmtDate } from '#lib/format/number.js';
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
	import type { DailyEwrSource } from '#lib/components/ewr/notMet.js';

	let {
		projectId,
		run,
		hasNaturalFlow,
		outcomes,
		nodes = [],
		ewrRules = [],
		daily,
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
		/** The base run's daily outlet EWR source (summary.catchment.outletEwr): what its days below are counted against, by name. */
		daily?: DailyEwrSource;
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
		return buildMatrixView({ baseStartDate: run.startDate, baseNatural: natural, members: sweep.members, settings, site: chosen.site, daily });
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
	// No sweep on this run (or none can run on it): one row until the editor opens the form (issue #465).
	let opened = $state(false);
	const runnable = $derived(ordinary && hasNaturalFlow);
	const collapsed = $derived(!opened && !submitting && !submitError && !loadError && (!runnable || loading || !sweep));
	async function open() {
		opened = true;
		await tick();
		document.getElementById('outcome-levels')?.focus();
	}
	const fmtBound = (c: { bounds: string; nYears: number }) => `${c.bounds} · ${c.nYears} ${c.nYears === 1 ? 'year' : 'years'}`;
</script>

<section aria-labelledby="outcome-h-t" data-testid="outcome-matrix" data-state={dataState}>
	{#if collapsed}
		<ToolRow headingId="outcome-h" titleId="outcome-h-t" title="Outcome matrix" help="outcome-matrix" purpose="How often the river’s requirement was met at a few demand levels, in each class of past water year.">
			{#snippet action()}
				{#if !ordinary}<span>Needs an ordinary run, not a scenario or forecast.</span>
				{:else if !hasNaturalFlow}<span>Needs the catchment natural flow: run the model again.</span>
				{:else if canEdit}<button type="button" class="btn" aria-describedby="outcome-h-t" onclick={open}>Run…</button>
				{:else}<span>{loading ? 'Loading…' : 'Not run yet: an editor can run one.'}</span>{/if}
			{/snippet}
		</ToolRow>
	{:else}
	<h3 id="outcome-h"><span id="outcome-h-t">Outcome matrix</span> <HelpTip key="outcome-matrix" /></h3>
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
			<form onsubmit={start} novalidate>
				<!-- Fields and hint first, then the action row: the run button lines up with the other panels'. -->
				<div class="field start">
					<span class="label"><label for="outcome-levels">Demand levels <span class="u">(% of today’s hydrological unit demand)</span></label> <HelpTip key="demand-level" /></span>
					<input
						id="outcome-levels"
						type="text"
						bind:value={levelsText}
						disabled={busy}
						placeholder="Up to {SWEEP_MEMBERS_MAX}, separated by commas"
						aria-describedby="outcome-levels-h"
						aria-invalid={!!parsed.error}
					/>
					<!-- The hint is the placeholder and the ⓘ on screen (issue #521 § 14); read in full by a screen reader. -->
					<span class="visually-hidden" id="outcome-levels-h">Up to {SWEEP_MEMBERS_MAX}, separated by commas. Each scales every hydrological unit’s irrigation demand; on a full-allocation run, its registered volume (80 means 80 % of it).</span>
				</div>
				<div class="action-row">
					<button type="submit" class="btn btn-primary" disabled={busy || !!parsed.error}>{sweep ? 'Run a new demand sweep' : 'Run demand sweep'}</button>
				</div>
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
					daily EWR are only at the outlet.
				</span>
			</div>
		{/if}
		{#if chosen.notice}<p class="hint" data-testid="outcome-site-notice">{chosen.notice}</p>{/if}
		{#if siteError}<div class="alert alert-error" role="alert">{siteError}</div>{/if}

		<div role="status" aria-live="polite" class="status">
			{#if loading}
				<span class="muted" data-loading>Loading…</span>
			{:else if shown?.kind === 'pending'}
				<span data-testid="sweep-status">{shown.text}</span>
				{#if shown.progress != null}<progress max="100" value={shown.progress} aria-label="Demand sweep progress">{shown.progress} %</progress>{/if}
			{:else if shown?.kind === 'stuck'}
				<span class="err" data-testid="sweep-status">{shown.text}</span>
			{/if}
		</div>
		{#if loadError}
			<div class="alert alert-error" role="alert" data-testid="outcome-load-error">
				Couldn’t look up this run’s demand sweep: {loadError}
				<!-- The loading line takes its place: the focus follows (followRetry). -->
				<button
					type="button"
					class="btn btn-sm"
					data-retry
					onclick={(e) => {
						followRetry(e.currentTarget);
						load();
					}}>Try again</button
				>
			</div>
		{/if}

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
				<HelpTip key="year-class" />
				{#if view.cutoffsPending}<span class="badge badge-warn" data-testid="cutoffs-pending">Provisional risk cut-offs, not yet confirmed by the catchment’s hydrologist</span>{/if}
				<HelpTip key="outcome-risk" />
			</div>
			{#if view.siteMissing}
				<p class="alert alert-warning" data-testid="outcome-site-missing">{view.siteMissing}</p>
			{:else if view.columns.length && view.nYears}
				<div class="matrix-box">
				<div class="matrix-layout">
					<div class="scroll">
						<table class="matrix" data-testid="outcome-table">
							<caption class="visually-hidden">Outcome by demand level (rows) and class of water year (columns)</caption>
							<thead>
								<tr>
									<th scope="col" rowspan="2" class="corner">Demand level <span class="bounds">% of today’s hydrological unit demand</span></th>
									<th scope="colgroup" colspan={view.columns.length} class="flow-head">
										Annual natural flow at the outlet <span class="u">({view.boundsUnit})</span>
									</th>
								</tr>
								<tr>
									{#each view.columns as c (c.id)}
										<th scope="col" data-class={c.id} data-bounds={c.bounds}>
											<span class="range" title={c.bounds}>{c.range}</span>
											({c.label})
											<span class="bounds">{c.nYears} {c.nYears === 1 ? 'year' : 'years'}</span>
										</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each view.rows as r (r.id)}
									<tr>
										<th scope="row">
											{r.label}
											{#if r.description}<span class="bounds">{r.description}</span>{/if}
										</th>
										{#if r.kind === 'cells'}
											{#each r.cells as cell, i (i)}
												<td class="cell {cell.risk ? `risk-${cell.risk}` : 'risk-none'}" data-risk={cell.risk ?? 'none'}>
													<strong>{cell.riskLabel}{#if cell.phrase}{' '}<span class="phrase">· {cell.phrase}</span>{/if}</strong>
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
					{#if view.legend.length}
						<aside class="legend" aria-labelledby="outcome-legend-h" data-testid="outcome-legend">
							<h4 id="outcome-legend-h">Ecological outcome <span class="u">(modelled)</span></h4>
							<ul>
								{#each view.legend as l (l.risk)}
									<li class="risk-{l.risk}" data-risk={l.risk}><strong>{l.label}</strong> {l.phrase}{' '}<span class="bounds">{l.rule}{view.cutoffsPending ? ' (provisional)' : ''}</span></li>
								{/each}
							</ul>
						</aside>
					{/if}
				</div>
				</div>
				<div class="boxes">
					{#if view.context}
						<section class="box" aria-labelledby="outcome-context-h" data-testid="outcome-context">
							<h4 id="outcome-context-h">Model context</h4>
							<dl>
								<div><dt>Base run’s years</dt><dd>{view.context.period} ({view.context.years})</dd></div>
								<div><dt>Ecological assessment</dt><dd>{view.context.assessment}</dd></div>
								<div><dt>Water availability</dt><dd>{view.context.availability}</dd></div>
								<div><dt>Demand levels</dt><dd>Each a demand sweep member: every hydrological unit’s irrigation demand scaled, crop areas unchanged</dd></div>
							</dl>
						</section>
					{/if}
					<section class="box" aria-labelledby="outcome-read-h" data-testid="outcome-how-to-read">
						<h4 id="outcome-read-h">How to read this matrix</h4>
						<ol>
							<li>Pick a column: a kind of year, by how much natural flow the river had in it.</li>
							<li>Pick a row: a demand level, as a share of today’s demand.</li>
							<li>The cell says how often the river’s requirement was met in past years of that kind at that level, and the risk that gives.</li>
						</ol>
					</section>
					<section class="box" aria-labelledby="outcome-notes-h" data-testid="outcome-notes">
						<h4 id="outcome-notes-h">Important notes</h4>
						<ul>
							<li>Past years of this run’s record, at each level: indicative, not a forecast.</li>
							<li>The requirement is assessed {view.metric === 'reserveMonthsMet' ? 'month by month' : 'day by day'}, so a cell depends on when the flow came, not only on the year’s total.</li>
							<li>Less demand is not the same as less irrigated area: efficiency, crop choice and timing change it too.</li>
							<li>Lower demand can still leave the river lower on some days, where water irrigated from a dam drains back to it.</li>
							<li>For comparing levels and supporting the WUA’s decision; the app doesn’t pick a level.</li>
						</ul>
					</section>
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
	{/if}
</section>

<style>
	.lead {
		max-width: 80ch;
		margin: 0 0 0.75rem;
	}
	.start {
		margin-bottom: 0;
		align-items: flex-start;
	}
	.start input {
		min-width: 14rem;
	}
	.site {
		margin: 0.75rem 0 0;
		max-width: 60ch;
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 80ch;
		margin: 0.3rem 0 0;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
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
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.cell {
		min-width: 11rem;
		font-size: var(--font-sm);
		border-left-width: 4px;
	}
	.cell strong {
		display: block;
		font-size: 0.85rem;
	}
	.phrase {
		font-weight: 400;
	}
	.flow-head {
		text-align: center;
	}
	.corner {
		vertical-align: bottom;
	}
	.range {
		display: block;
		font-variant-numeric: tabular-nums;
	}
	/* The matrix and its key side by side where there is room; the key under it on a phone. */
	.matrix-box {
		container: outcome-matrix / inline-size;
	}
	.matrix-layout {
		display: grid;
		gap: 0.75rem;
	}
	@container outcome-matrix (min-width: 56rem) {
		.matrix-layout:has(.legend) {
			grid-template-columns: minmax(0, 1fr) 15rem;
			align-items: start;
		}
	}
	.legend h4,
	.box h4 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
	.legend ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}
	.legend li {
		font-size: var(--font-sm);
		padding: 0.3rem 0.5rem;
		/* The colour is the risk's (.risk-*), as on its cells. */
		border-left-width: 4px;
		border-left-style: solid;
	}
	.legend li strong {
		display: block;
	}
	.boxes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
	.box {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.75rem;
		font-size: var(--font-sm);
	}
	.box ol,
	.box ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.box dl {
		margin: 0;
		display: grid;
		gap: 0.3rem;
	}
	.box dt {
		color: var(--text-muted);
	}
	.box dd {
		margin: 0;
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
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.warnings {
		font-size: var(--font-sm);
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
</style>
