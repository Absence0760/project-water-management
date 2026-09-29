<script lang="ts">
	// The printable catchment report for one run (WP-2.15 Phase A, docs/ui.md
	// § Report): /projects/:id/report?run=<runId>, the latest run without one.
	// It reuses the Runs tab's components in their print modes, on the same
	// API routes, and prints to A4 through the browser (Download PDF →
	// window.print()). data-report-ready says every section has loaded and
	// every chart has drawn: e2e waits on it, and so does the server-side render
	// (backend/src/reports/render.ts), which prints this same page.
	//
	// `&against=<projectId>:<runId>` (Compare runs' Export impact report, issue
	// #17 A4) makes it an impact report: an "Impact against the baseline"
	// section after the cover (report/ImpactSection.svelte, its own chunk),
	// from GET /compare/runs. The server-side PDF prints it too: the report
	// request carries the baseline (082), and the renderer opens this route
	// with the same `against`.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { fdcPercentileTable, REPORT_FOOTER, toEpochDay, type NetworkNode, type ProjectModel, type SeriesMeta } from '@water-management/engine';
	import { fdcReportDays, fdcReportRows } from '$lib/components/report/fdc';
	import { apanDailyOfInput, chirpsSourceOfInput, originOfInput, runChirpsFactors } from '$lib/series/provenance';
	import { api, ApiError, type Project, type Run, type RunCompareResponse, type SignoffList } from '$lib/api';
	import CalibrationPanel from '$lib/components/calibration/CalibrationPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { loadOnce } from '$lib/components/common/lazy';
	import CurtailmentTable from '$lib/components/curtailment/CurtailmentTable.svelte';
	import EwrHeatmap from '$lib/components/ewr/EwrHeatmap.svelte';
	import Disclaimer from '$lib/components/liability/Disclaimer.svelte';
	import SignoffSection from '$lib/components/liability/SignoffSection.svelte';
	import ValidationStatement from '$lib/components/liability/ValidationStatement.svelte';
	import NetworkSchematic from '$lib/components/network/NetworkSchematic.svelte';
	import { ranAgo } from '$lib/components/network/supplyColour';
	import { supplyColouring } from '$lib/components/network/farmColour';
	import { coverageRows, cropAreaRows, effectiveSettings, monthlyRows, nodeRows, settingsRows, transferRows } from '$lib/components/report/inputs';
	import { forceLightForPrint, restoreThemeAfterPrint } from '$lib/components/report/printTheme';
	import { disclaimerSection, forecastNote, isReportReady, readFirst, reportCharts, reportSections } from '$lib/components/report/sections';
	import { cachedSeries } from '$lib/components/runs/cache';
	import EwrAssurancePanel from '$lib/components/runs/EwrAssurancePanel.svelte';
	import { CATCHMENT_FLOW_KEYS, EWR_RULE_CAPTION, EWR_RULE_KEY, ewrChartSeries, hydrographSeries, observedCaption, observedSources, type CatchmentFlows, type ObservedSources } from '$lib/components/runs/flowSeries';
	import { toDisplayUnit } from '$lib/components/runs/results';
	import RunSummaryView from '$lib/components/runs/RunSummaryView.svelte';
	import UnitResultsTable from '$lib/components/supply/UnitResultsTable.svelte';
	import { loadHumanImpacts } from '$lib/components/runs/humanImpacts';
	import { runSentence } from '$lib/components/runs/runSentence';
	import SelfChecksPanel from '$lib/components/runs/SelfChecksPanel.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtDate, fmtNum } from '$lib/format/number';

	// The server-side PDF (Generate / Email me). In the report's chunk: the bar renders it for every
	// report of a run, so as a chunk of its own it only added split overhead (issue #9).
	import ServerPdf from '$lib/components/report/ServerPdf.svelte';

	const projectId = $derived(page.params.id ?? '');
	const runParam = $derived(page.url.searchParams.get('run'));
	/** The baseline of an impact report ("<projectId>:<runId>", as Compare runs' refs); null for the plain report. */
	const againstParam = $derived(page.url.searchParams.get('against') || null);
	// The impact section: its own chunk, loaded (before "ready") only for an impact report.
	const loadImpact = () => import('$lib/components/report/ImpactSection.svelte');
	let impact = $state.raw<RunCompareResponse | null>(null);
	let impactError = $state<string | null>(null);

	let project = $state.raw<Project | null>(null);
	let run = $state.raw<Run | null>(null);
	let series = $state.raw<SeriesMeta[]>([]);
	// $state.raw: daily arrays, replaced and never mutated (as in RunCharts).
	let flows = $state.raw<CatchmentFlows>({});
	/** Gauge or logger behind each observed series (issue #45). */
	let sources = $state.raw<ObservedSources>({});
	// The run's sign-offs and the statement a signer confirms (WP-3.13); part of what "ready" waits for.
	let signoffs = $state.raw<SignoffList | null>(null);
	let status = $state<'loading' | 'loaded' | 'no-runs' | 'not-found' | 'no-run' | 'error' | 'chunk-failed'>('loading');
	let error = $state('');
	let hydroDrawn = $state(false);
	let ewrDrawn = $state(false);

	async function load(id: string, want: string | null, against: string | null) {
		status = 'loading';
		impact = null;
		impactError = null;
		// A new run's charts start undrawn: a remounted chart takes its ready flag from these bindings.
		hydroDrawn = false;
		ewrDrawn = false;
		try {
			// A non-member gets 404 on the project, like the workspace.
			const [p, list, sl] = await Promise.all([
				api.projects.get(id),
				want ? null : api.runs.list(id),
				api.series.list(id).catch(() => [] as SeriesMeta[])
			]);
			project = p;
			series = sl;
			const runId = want ?? list?.[0]?.id;
			if (!runId) {
				status = 'no-runs';
				return;
			}
			let detail: Awaited<ReturnType<typeof api.runs.get>>;
			try {
				detail = await api.runs.get(id, runId);
			} catch (e) {
				if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
					status = 'no-run';
					return;
				}
				throw e;
			}
			const have = (k: string) => detail.series.some((r) => r.key === k && r.nodeId === null);
			const [pairs, so, cmp] = await Promise.all([
				Promise.all(
					[...CATCHMENT_FLOW_KEYS, EWR_RULE_KEY].filter(([, k]) => have(k)).map(
						async ([slot, k]) => [slot, await cachedSeries(runId, k, null, () => api.runs.series(id, runId, k, null))] as const
					)
				),
				api.signoffs.list(id, runId),
				// The impact section: a baseline that can't be compared says why in its section; the report still loads.
				against
					? api.compare.runs(against, `${id}:${runId}`).catch((e: unknown) => {
							impactError =
								e instanceof ApiError && (e.status === 404 || e.status === 400)
									? "The baseline doesn't exist any more, or its project isn't shared with you."
									: e instanceof Error
										? e.message
										: String(e);
							return null;
						})
					: null
			]);
			signoffs = so;
			impact = cmp;
			// The summary's land cover, groundwater and other users' tables are a chunk of their own: in before "ready".
			// If it fails to download, only a reload can fetch it (lazy.ts), so it gets its own message, not "Try again".
			try {
				await Promise.all([loadOnce(loadHumanImpacts), against ? loadOnce(loadImpact) : null]);
			} catch {
				status = 'chunk-failed';
				return;
			}
			flows = Object.fromEntries(pairs) as CatchmentFlows;
			sources = observedSources(detail.series);
			run = detail.run;
			status = 'loaded';
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) status = 'not-found';
			else {
				error = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		}
	}
	$effect(() => {
		const id = projectId;
		const want = runParam;
		const against = againstParam;
		untrack(() => load(id, want, against));
	});

	/** After a sign-off: the new list, or (null, the statement changed) a fresh read of it. */
	async function signoffsChanged(next: SignoffList['signoffs'] | null) {
		if (!run || !signoffs) return;
		if (next) signoffs = { ...signoffs, signoffs: next };
		else {
			try {
				signoffs = await api.signoffs.list(projectId, run.id);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		}
	}

	const sections = $derived(run ? reportSections(run, { impact: !!againstParam }) : []);
	const ready = $derived(isReportReady(status === 'loaded', reportCharts(sections), { hydrograph: hydroDrawn, ewr: ewrDrawn }));

	const model = $derived((run?.model ?? {}) as Partial<ProjectModel>);
	const nodes = $derived((model.nodes ?? []) as NetworkNode[]);
	const settings = $derived(effectiveSettings(run?.settings));
	const conv = (d: { values: readonly (number | null)[] }) => toDisplayUnit(d.values, 'm³/day', 'm³/s').values;
	// The printed report has no legend to click, so natural flow shows from the start.
	const hydro = $derived(hydrographSeries(flows, conv, false, sources));
	const ewrLines = $derived(ewrChartSeries(flows, conv));
	// The Runs tab's FDC Q10–Q95 table (issue #45), from the same engine function;
	// a forecast run's forecast days left out (issue #51).
	const fdc = $derived(
		fdcPercentileTable(
			{
				...(flows.natural ? { natural: conv(flows.natural) } : {}),
				...(flows.simulated ? { simulated: conv(flows.simulated) } : {}),
				...(flows.observed ? { observed: conv(flows.observed) } : {})
			},
			run ? { startDate: (flows.simulated ?? flows.natural)?.startDate ?? run.startDate, forecastFrom: run.summary.forecast?.from ?? null } : undefined
		)
	);
	const days = $derived(run ? toEpochDay(run.endDate) - toEpochDay(run.startDate) + 1 : 0);
	const farmNames = $derived(Object.fromEntries(nodes.map((n) => [n.id, n.name])));
	const nodeOrder = $derived(new Map(nodes.map((n) => [n.id, n.sortOrder] as [string, number])));
	const runName = $derived(run ? run.label || `Run of ${fmtDate(run.createdAt, true)}` : '');
	const prepared = fmtDate(new Date().toISOString(), true);
	// The cover box; an unsigned run nominated as evidence, or an impact report, says it isn't evidence.
	const box = $derived(readFirst(sections, signoffs?.signoffs ?? [], run?.evidence === 'current' || !!againstParam));
	// The server PDF prints this on every page (backend reports/render.ts reads it).
	const footer = $derived(project && run ? REPORT_FOOTER(project.name, runName, disclaimerSection(sections)) : undefined);

	// Printing is A4, in the light theme, without the app's header (see the styles).
	$effect(() => {
		const pageRule = document.createElement('style');
		pageRule.textContent = '@page { size: A4; margin: 14mm 12mm 18mm; }';
		document.head.append(pageRule);
		const before = () => forceLightForPrint();
		const after = () => restoreThemeAfterPrint();
		addEventListener('beforeprint', before);
		addEventListener('afterprint', after);
		return () => {
			pageRule.remove();
			removeEventListener('beforeprint', before);
			removeEventListener('afterprint', after);
			restoreThemeAfterPrint();
		};
	});
</script>

<svelte:head><title>{project ? `Report · ${project.name} · ` : ''}Water Management</title></svelte:head>

<main class="page report" data-report-ready={ready || undefined} data-report-footer={footer} aria-busy={!ready && status === 'loading'}>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">
			This project doesn't exist or you don't have access to it. <a href="{base}/">Back to projects</a>
		</div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The report could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, runParam, againstParam)}>Try again</button>
		</div>
	{:else if status === 'chunk-failed'}
		<ChunkFailed what="The report" />
	{:else if status === 'no-runs' || status === 'no-run'}
		<div class="alert alert-info" role="status">
			{status === 'no-runs' ? 'This project has no runs yet, so there is nothing to report.' : 'This run doesn’t exist any more.'}
			<a href="{base}/projects/{projectId}?tab=runs">Go to Runs &amp; results</a>
		</div>
	{/if}

	{#if status === 'loading' || status === 'loaded'}
		<div class="bar no-print">
			{#if againstParam && run}
				<a href="{base}/projects/{projectId}?tab=compare&{new URLSearchParams({ a: againstParam, b: `${projectId}:${run.id}` })}">← Back to the comparison</a>
			{:else}
				<a href="{base}/projects/{projectId}?tab=runs{run ? `&run=${run.id}` : ''}">← Back to the run</a>
			{/if}
			<button type="button" class="btn btn-primary" disabled={!ready} onclick={() => window.print()}>Download PDF</button>
			<!-- An impact report whose baseline can't be read has no server PDF: the API would refuse it (the section says why). -->
			{#if run && (!againstParam || impact)}
				<ServerPdf {projectId} runId={run!.id} against={againstParam} />
			{/if}
			<p class="muted small" role="status">
				{#if ready}
					Opens your browser’s print dialog: choose <strong>Save as PDF</strong> as the destination. The report prints on A4, in the light
					theme.
				{:else}
					Preparing the report…
				{/if}
			</p>
		</div>
	{/if}

	{#if status === 'loaded' && project && run}
		{@const summary = run.summary}
		{#each sections as s, i (s.id)}
			{#if s.id === 'cover'}
				<section class="cover" aria-labelledby="rep-cover-h">
					<p class="eyebrow">{s.title}</p>
					<h1 id="rep-cover-h">{project.name}</h1>
					<p class="run-name">
						{runName}
						{#if run.evidence === 'current'}<span class="badge badge-owner">Evidence</span>{:else if run.evidence === 'past'}<span class="badge">Former evidence</span>{/if}
					</p>
					<dl class="facts">
						<div><dt>Period</dt><dd>{run.startDate} – {run.endDate} ({fmtNum(days)} days)</dd></div>
						<div><dt>Run made</dt><dd>{fmtDate(run.createdAt, true)}{run.createdBy ? ` by ${run.createdBy}` : ''}</dd></div>
						<div><dt>Engine version</dt><dd>{run.engineVersion}</dd></div>
						<div><dt>Report prepared</dt><dd>{prepared}</dd></div>
					</dl>
					{#if run.legacy}
						<p class="alert alert-warning">
							Legacy runoff model (b023 workbook, removed in engine 1.0.0): it does not conserve water at the event scale (audit H1).
							Workbook comparison only, not evidence.
						</p>
					{/if}
					<!-- Read this first (delict review §5.2, docs/legal/disclaimer-review.md § 1): the disclaimer's key points and the sign-off status, in normal type. -->
					<div class="read-first" role="note" aria-labelledby="rep-read-first-h" data-testid="report-read-first">
						<!-- Not a heading: the report's h2s are its numbered sections. -->
						<p id="rep-read-first-h" class="rf-title">Read this first</p>
						<p>{box.text}</p>
						<p>{box.status}</p>
						{#if box.notEvidence}<p><strong>{box.notEvidence}</strong></p>{/if}
					</div>
					<p class="lede">{runSentence(summary)}</p>
					<!-- A forecast run (WP-2.12): the days from its first forecast day use forecast rain (CHIRPS-GEFS named only when it was the source). -->
					{#if summary.forecast}<p class="alert alert-warning" data-testid="report-forecast-note">{forecastNote(run)}</p>{/if}
					<nav aria-label="Contents">
						<ol>
							{#each sections.slice(1) as c (c.id)}<li><a href="#rep-{c.id}">{c.title}</a></li>{/each}
						</ol>
					</nav>
				</section>
			{:else}
				<section class="panel rep" id="rep-{s.id}" aria-labelledby="rep-{s.id}-h">
					<h2 id="rep-{s.id}-h">{i}. {s.title}</h2>
					{#if s.id === 'impact'}
						{#if impact}
							<Lazy load={loadImpact}>
								{#snippet children(ImpactSection)}<ImpactSection data={impact!} />{/snippet}
							</Lazy>
						{:else}
							<p class="alert alert-warning" role="status">This run couldn't be compared with the baseline: {impactError}</p>
						{/if}
					{:else if s.id === 'network'}
						{@const colouring = supplyColouring(nodes, summary, { name: runName, ago: ranAgo(run.createdAt) }, false)}
						<!-- The screen scrolls the usual drawing; paper gets one wrapped to the A4 width (NetworkSchematic's `paper`). -->
						<div class="sch-screen"><NetworkSchematic {nodes} transfers={model.transfers ?? []} {colouring} /></div>
						<div class="sch-paper"><NetworkSchematic {nodes} transfers={model.transfers ?? []} {colouring} paper /></div>
					{:else if s.id === 'inputs'}
						<p class="muted small">As this run used them: its own copy of the settings and the model, not today’s.</p>
						<h3>Settings</h3>
						<dl class="kv">
							{#each settingsRows(settings, run) as [k, v] (k)}<div><dt>{k}</dt><dd>{v}</dd></div>{/each}
						</dl>
						<div class="table-wrap">
							<table class="data compact">
								<caption class="visually-hidden">Monthly settings, October to September</caption>
								<thead><tr><th scope="col">Monthly</th>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr></thead>
								<tbody>
									{#each monthlyRows(settings) as r (r.label)}<tr><th scope="row">{r.label}</th>{#each r.values as v, j (j)}<td class="num">{v}</td>{/each}</tr>{/each}
								</tbody>
							</table>
						</div>
						{@render table('Hydrological units, gauges and other users', ['Node', 'Kind', 'Drains into', 'Area (km²)', 'Dam (m³)', 'Irrigation efficiency'], [3, 4, 5], nodeRows(model))}
						{@render table('Crops and planted areas', ['Hydrological unit', 'Crop', 'Area (ha)'], [2], cropAreaRows(model))}
						{@render table('Transfers', ['From', 'To', 'Months', 'Max rate (m³/s)', 'Daily cap (m³)', 'On'], [3, 4], transferRows(model))}
						{@render table(
							'Data coverage (the project’s input series today; the run used them up to its end date)',
							['Series', 'Starts', 'Ends', 'Days', 'Days in the run'],
							[3, 4],
							coverageRows(series, run)
						)}
					{:else if s.id === 'calibration'}
						<CalibrationPanel
							calibration={summary.calibration}
							requestedStart={settings.calibrationStart ?? null}
							requestedEnd={settings.calibrationEnd ?? null}
						/>
						{#if run.settings}<FitProvenance record={run.settings.fitRecord} settings={run.settings} chirpsSource={chirpsSourceOfInput(run.inputSeries)} apanDaily={apanDailyOfInput(run.inputSeries)} chirpsFactors={runChirpsFactors(run.summary)} observedOrigin={originOfInput(run.inputSeries, run.settings.fitRecord?.flowKind)} />{/if}
						<LineChart
							print
							bind:ready={hydroDrawn}
							title="Flow at the outflow gauge: natural, simulated and observed"
							unit="m³/s"
							height={300}
							series={hydro}
							caption="The whole run. {observedCaption(flows, sources)}"
						/>
						{@render table(
							`Flow-duration percentiles (m³/s): flow equalled or exceeded on 10, 50, 90 and 95 % of days, ${fdcReportDays(fdc)}`,
							['Flow record', 'Q10', 'Q50', 'Q90', 'Q95', 'Days'],
							[1, 2, 3, 4, 5],
							fdcReportRows(fdc)
						)}
					{:else if s.id === 'curtailment'}
						<CurtailmentTable {summary} {farmNames} />
					{:else if s.id === 'ewr'}
						<LineChart
							print
							bind:ready={ewrDrawn}
							title="EWR vs simulated outflow (log scale)"
							unit="m³/s"
							height={260}
							log
							series={ewrLines}
							caption={`Days the outflow dips below the pragmatic EWR line count as EWR not met.${flows.ewrRule ? ` ${EWR_RULE_CAPTION}` : ''}`}
						/>
						{#each summary.ewrAssurance ?? [] as site (site.nodeId ?? '(outlet)')}
							<div class="sub"><EwrAssurancePanel sites={[site]} print /></div>
						{/each}
						{#if summary.ewrCompliance}
							{#each ['outlet', ...summary.ewrCompliance.farms.map((f) => f.nodeId ?? 'outlet')] as site, j (j)}
								<div class="sub"><EwrHeatmap compliance={summary.ewrCompliance} {site} print /></div>
							{/each}
						{:else}
							<p class="muted">This run was made before the monthly EWR compliance grid existed.</p>
						{/if}
					{:else if s.id === 'farms'}
						<RunSummaryView {summary} {days}>
							{#snippet units()}<UnitResultsTable farms={summary.farms ?? []} {days} {nodeOrder} />{/snippet}
						</RunSummaryView>
						<div class="sub">
							<SelfChecksPanel {summary} {projectId} runId={run.id} startDate={run.startDate} endDate={run.endDate} engineVersion={run.engineVersion} nodes={[]} trace={false} />
						</div>
					{:else if s.id === 'notes'}
						<p class="notes">{run.notes}</p>
						{#if run.notesUpdatedAt}<p class="muted small">Last changed {fmtDate(run.notesUpdatedAt, true)}{run.notesUpdatedBy ? ` by ${run.notesUpdatedBy}` : ''}.</p>{/if}
					{:else if s.id === 'validation'}
						<ValidationStatement {summary} engineVersion={run.engineVersion} legacy={run.legacy} />
					{:else if s.id === 'signoff' && signoffs}
						<SignoffSection {projectId} runId={run.id} list={signoffs} onchange={signoffsChanged} />
					{:else if s.id === 'disclaimer'}
						<Disclaimer />
					{/if}
				</section>
			{/if}
		{/each}
	{/if}
</main>

<!-- A titled table of text rows: the first column heads each row; `nums` are the right-aligned (numeric) columns. -->
{#snippet table(title: string, head: string[], nums: number[], rows: string[][])}
	{#if rows.length}
		<h3>{title}</h3>
		<div class="table-wrap">
			<table class="data compact">
				<thead><tr>{#each head as h, j (j)}<th scope="col" class:num={nums.includes(j)}>{h}</th>{/each}</tr></thead>
				<tbody>
					{#each rows as r, ri (ri)}
						<tr><th scope="row">{r[0]}</th>{#each r.slice(1) as v, j (j)}<td class:num={nums.includes(j + 1)}>{v}</td>{/each}</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{/snippet}

<style>
	.report {
		max-width: 1000px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 1rem;
	}
	.bar p {
		margin: 0;
		flex-basis: 100%;
	}
	.cover {
		margin: 0.5rem 0 1.5rem;
	}
	.eyebrow {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.cover h1 {
		margin: 0.2rem 0;
	}
	.run-name {
		font-size: 1.15rem;
		font-weight: 600;
		margin: 0 0 0.75rem;
	}
	.facts,
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0 0 1rem;
	}
	.kv {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	/* Contents links: 24px targets (WCAG 2.5.8). */
	.cover ol a {
		display: inline-block;
		min-height: 24px;
		line-height: 24px;
	}
	.read-first {
		max-width: 72ch;
		margin: 0 0 1rem;
		padding: 0.6rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 4px solid var(--warning);
		border-radius: 4px;
		line-height: 1.5;
		break-inside: avoid;
	}
	.read-first .rf-title {
		margin: 0;
		font-weight: 700;
	}
	.read-first p {
		margin: 0.3rem 0 0;
	}
	.lede {
		max-width: 72ch;
		line-height: 1.55;
	}
	.notes {
		white-space: pre-wrap;
		max-width: 72ch;
	}
	.sub {
		margin-top: 1.25rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	h3 {
		margin: 1.25rem 0 0.5rem;
	}
	/* A report reads top to bottom: whole tables, not boxes that scroll. */
	.report :global(.table-wrap) {
		max-height: none;
		margin-bottom: 0.5rem;
	}
	.report :global(.chart) {
		margin-top: 1rem;
	}
	/* On screen a table as wide as the curtailment one squeezed its unit column
	   until each verdict wrapped a word to a line; give the names room and let
	   the table scroll inside its box. Paper keeps its own fit (below). */
	@media screen {
		.sch-paper {
			display: none;
		}
		.report :global(table.data tbody th[scope='row']) {
			min-width: 11rem;
		}
	}

	@media print {
		/* No app chrome (the frame hides its own sidebar and phone bar in print,
		   AppShell), and white paper whatever the screen theme. */
		:global(body:has(main.report) .verify-banner),
		.no-print {
			display: none !important;
		}
		:global(html:has(main.report)),
		:global(body:has(main.report)) {
			background: #fff;
		}
		.report {
			max-width: none;
			padding: 0;
			font-size: 10pt;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
		/* One section per page run; headings stay with what follows them. */
		.rep {
			break-before: page;
			border: 0;
			box-shadow: none;
			padding: 0;
			margin: 0;
		}
		.report :global(h2),
		.report :global(h3),
		.report :global(h4) {
			break-after: avoid;
		}
		.report :global(tr),
		.report :global(figure),
		.report :global(.stat),
		.report :global(dl > div) {
			break-inside: avoid;
		}
		/* Tables print whole, their header row repeated on every page. */
		.report :global(.table-wrap) {
			overflow: visible;
			border: 0;
		}
		.report :global(table.data thead) {
			position: static;
			display: table-header-group;
		}
		/* Wide tables (curtailment, the water balance) fit the A4 width: headings wrap, cells tighten. */
		.report :global(table.data) {
			font-size: 7.5pt;
		}
		.report :global(table.data th),
		.report :global(table.data td) {
			padding: 0.2rem 0.3rem;
		}
		.report :global(table.data thead th) {
			white-space: normal;
			font-size: 7pt;
		}
		.report :global(.scroller) {
			overflow: visible;
		}
		.sch-screen {
			display: none;
		}
		.report :global(svg.schematic) {
			max-width: 100%;
			height: auto;
		}
		.report :global(.helptip),
		.report :global(.u-legend) {
			display: none;
		}
		.report :global(a) {
			color: inherit;
			text-decoration: none;
		}
	}
</style>
