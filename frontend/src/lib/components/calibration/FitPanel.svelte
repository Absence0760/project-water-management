<!--
	"Fit automatically" (issue #4 phase 5): fits the selected runoff model's
	parameters to the observed record in a Web Worker, shows the fit next to
	its validation, and can write the result into the Settings form, with a
	fit record of how it was made (issue #4). It never saves: the user reviews
	the form and saves it. Its choices, the running fit and the result live in
	the workspace's FitSession (lib/calibration/fitSession.svelte.ts), so they
	outlast this panel when another tab opens.
-->
<script lang="ts">
	import {
		CALIBRATION_BOUNDS,
		DEFAULT_STARTS,
		MAX_STARTS,
		OBJECTIVES,
		calibrationSeriesKey,
		type CalibrationFlowKind,
		type CalibrationReport,
		type FitRecord,
		type ProjectModel,
		type ProjectSettings
	} from '@water-management/engine';
	import { untrack } from 'svelte';
	import { apanDailyOfValues, chirpsSourceOfInput } from '$lib/series/provenance';
	import { api } from '$lib/api';
	import {
		benchmarkColumns,
		benchmarkRows,
		BOUNDS_LABEL,
		boundsHint,
		climatologyWarning,
		benchmarkSourceNote,
		fmtScore,
		fitInput,
		fitParams,
		fitRecordFor,
		marPenaltyOn,
		objectiveName,
		progressFraction,
		rankedByText,
		SCORE_ROWS,
		scoreCellText,
		scoreColumns,
		SEED_MAX,
		seedError,
		stageText,
		totalRuns,
		validationRecordOptions
	} from '$lib/calibration/fit';
	import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
	import MarPenaltyResult from './MarPenaltyResult.svelte';
	import DataQualityPanel from './DataQualityPanel.svelte';
	import { representativenessGist, representativenessKey, representativenessRows } from './representativeness';
	import Wr2012FitTable from './Wr2012FitTable.svelte';
	import { wr2012FitPeriods } from '$lib/calibration/wr2012Fit';
	import { startFit } from '$lib/calibration/runner';
	import type { FitSession } from '$lib/calibration/fitSession.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum } from '$lib/format/number';

	let {
		projectId,
		x2Open,
		settings,
		model,
		hasObserved,
		seriesKinds = null,
		calibrationFlowKind = null,
		readonly,
		onApply,
		session
	}: {
		projectId: string;
		x2Open: boolean;
		/** The Settings form as it stands (unsaved edits included). */
		settings: () => ProjectSettings;
		/** The network with unsaved edits, if any (else the saved one is used). */
		model?: () => ProjectModel | undefined;
		hasObserved: boolean;
		/** Series kinds the project has (null = not known): decides which records can validate the fit. */
		seriesKinds?: string[] | null;
		/** The record the fit uses, as the form stands (null = the default pick). */
		calibrationFlowKind?: CalibrationFlowKind | null;
		readonly: boolean;
		/** Writes the fit into the form, with its record (never saves). */
		onApply: (report: CalibrationReport, record: FitRecord) => void;
		/** The workspace's fit: choices, progress and result, kept across tab changes. */
		session: FitSession;
	} = $props();

	const uid = $props.id();
	const seedProblem = $derived(seedError(session.seed));
	// Several searches from different seeds: nearly equal scores with scattered
	// parameters show what the record can't pin down (calibration research CR-2).
	const startsOk = $derived(session.starts !== null && Number.isInteger(session.starts) && session.starts >= 1 && session.starts <= MAX_STARTS);
	// Offered only when the project has both a gauge and a logger record.
	const recordOptions = $derived(validationRecordOptions(seriesKinds, calibrationFlowKind));
	const chosenRecord = $derived(session.validationRecord && recordOptions.includes(session.validationRecord) ? session.validationRecord : null);
	// Seeded from the defaults up front, so the checkbox bindings never see a missing key.
	untrack(() => {
		if (!Object.keys(session.picked).length) session.picked = Object.fromEntries(fitParams(x2Open).map((p) => [p.key, p.checked]));
	});
	const status = $derived(session.status);
	const report = $derived(session.report);
	const progress = $derived(session.progress);

	const params = $derived(fitParams(x2Open));
	// Keep the user's ticks; a parameter new to the list (another model, or X2
	// once exchange is on) starts at its default.
	$effect(() => {
		const prev = untrack(() => session.picked);
		session.picked = Object.fromEntries(params.map((p) => [p.key, prev[p.key] ?? p.checked]));
	});
	const free = $derived(params.filter((p) => session.picked[p.key]).map((p) => p.key));
	// The WR2012 MAR penalty (Settings → WR2012 check) adds a fit without it, for comparison.
	const penalty = $derived(marPenaltyOn(settings()));
	const runs = $derived(totalRuns(session.budget ?? 0, session.validate, penalty, startsOk ? session.starts! : 1));
	const canStart = $derived(hasObserved && free.length > 0 && session.budget !== null && session.budget >= 50 && !seedProblem && startsOk && !session.busy);
	const columns = $derived(report ? scoreColumns(report) : []);
	// Model vs the mean-flow and climatology benchmarks (engine ≥ 1.19.0, CR-5); none on an older report.
	const benchCols = $derived(benchmarkColumns(columns));
	const benchRows = $derived(report ? benchmarkRows(columns, report.objective) : []);
	const climWarning = $derived(report ? climatologyWarning(columns, report.objective) : null);
	const benchSource = $derived(report ? benchmarkSourceNote(columns) : null);
	const anyInterval = $derived(columns.some((c) => c.intervals));
	const pct = $derived(progress ? Math.round(100 * progressFraction(progress, session.runValidate, penalty, session.runStarts)) : 0);
	// A report for another model than the form now shows can't be applied.

	function start() {
		const { budget, seed, starts, objective, bounds, validate } = session;
		if (!canStart || budget === null || seed === null || starts === null) return;
		const validationRecord = chosenRecord;
		let server: Awaited<ReturnType<typeof api.runs.modelInput>>;
		let input: ReturnType<typeof fitInput>;
		void session.start(
			async () => {
				server = await api.runs.modelInput(projectId);
				const form = settings();
				input = fitInput(server, form, model?.());
				// The CHIRPS series' label as the server loaded it: the record's forcing keeps it (issue #40c).
				// And the daily A-pan series it runs on (issue #45), by the hash a run's snapshot records.
				return {
					settings: form,
					validate,
					validationRecord,
					chirpsSource: chirpsSourceOfInput(server.series),
					apanDaily: await apanDailyOfValues(server.series.evap_apan_mm)
				};
			},
			() => {
				session.runStarts = starts;
				session.runValidate = validate;
				const f = free;
				return startFit({ input, model: 'gr4j', objective, bounds, budget, free: f, validate, seed, starts, validationRecord: validationRecord ?? undefined }, (p) => (session.progress = p));
			},
			// The fitted record's source and given unit as the server loaded it (107_series_source.sql); undefined when it didn't say.
			// At the calibration site: the outlet's record, or a gauge's (engine ≥ 1.41.0).
			(r) => server.series[calibrationSeriesKey(r.flowKind as CalibrationFlowKind, r.siteNodeId)]?.origin
		);
	}

	function apply() {
		const { report: r, ran } = session;
		if (!r || !ran) return;
		onApply(r, fitRecordFor(r, ran.settings, ran));
		session.applied = true;
	}

	const fmtParam = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 3));
	const paramLabel = (key: string) => params.find((p) => p.key === key)?.label ?? key;
</script>

<section class="fit" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Fit automatically <HelpTip key="auto-calibration" /></h3>
	{#if !hasObserved}
		<p class="muted small">Upload an observed or logger flow record (Data) to fit the parameters to it.</p>
	{:else}
		<p class="muted small">
			Searches the GR4J parameters for the best match between the run and the observed record, over the
			calibration window above. It uses the form as it stands, fits in your browser, and never saves: check the result, apply it to the form,
			then save.
		</p>
		<div class="controls">
			<div class="field">
				<label for="{uid}-obj">Objective <HelpTip key="calibration-objective" label="About what to optimise" /></label>
				<select id="{uid}-obj" bind:value={session.objective} disabled={status === 'running'}>
					{#each OBJECTIVES as o (o)}<option value={o}>{objectiveName(o)}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{uid}-bounds">Bounds <HelpTip key="calibration-bounds" /></label>
				<select id="{uid}-bounds" bind:value={session.bounds} disabled={status === 'running'} aria-describedby="{uid}-bounds-h">
					{#each CALIBRATION_BOUNDS as b (b)}<option value={b}>{BOUNDS_LABEL[b]}</option>{/each}
				</select>
				<span class="hint" id="{uid}-bounds-h">{boundsHint(session.bounds)}</span>
			</div>
			<div class="field">
				<label for="{uid}-budget">Model runs per fit <HelpTip key="calibration-search" label="About the search settings" /></label>
				<NumberInput id="{uid}-budget" min={50} max={10_000} step={50} bind:value={session.budget} disabled={status === 'running'} aria-describedby="{uid}-budget-h" />
				<span class="hint" id="{uid}-budget-h">{fmtNum(runs)} runs in all. Default 1 500.</span>
			</div>
			<div class="field">
				<label for="{uid}-seed">Seed</label>
				<NumberInput id="{uid}-seed" min={0} max={SEED_MAX} step={1} bind:value={session.seed} disabled={status === 'running'} aria-describedby="{uid}-seed-h" aria-invalid={seedProblem ? 'true' : undefined} />
				<span class="hint" id="{uid}-seed-h">{seedProblem ?? 'The same seed, data and engine version give the same fit. Recorded with the fit.'}</span>
			</div>
			<div class="field">
				<label for="{uid}-starts">Starts</label>
				<NumberInput id="{uid}-starts" min={1} max={MAX_STARTS} step={1} bind:value={session.starts} disabled={status === 'running'} aria-describedby="{uid}-starts-h" aria-invalid={startsOk ? undefined : 'true'} />
				<span class="hint" id="{uid}-starts-h">
					{startsOk
						? `Separate searches of the whole record, each from its own seed; the best is kept. Nearly equal scores with scattered parameters mean the record can’t pin them down. Default ${DEFAULT_STARTS}.`
						: `Starts must be a whole number from 1 to ${MAX_STARTS}.`}
				</span>
			</div>
			<fieldset class="plain params">
				<legend>Parameters to fit <HelpTip key="gr4j" label="About the GR4J parameters" /></legend>
				{#each params as p (p.key)}
					<label class="check">
						<input type="checkbox" bind:checked={session.picked[p.key]} disabled={status === 'running'} />
						{p.label}
					</label>
				{/each}
			</fieldset>
			<div class="tip-row">
				<label class="check validate">
					<input type="checkbox" bind:checked={session.validate} disabled={status === 'running'} />
					Validate: split-sample and dry → wet tests (two more fits)
				</label>
				<HelpTip key="validation-tests" label="About the validation tests" />
			</div>
			{#if recordOptions.length}
				<div class="field">
					<label for="{uid}-record">Also validate against</label>
					<select id="{uid}-record" bind:value={session.validationRecord} disabled={status === 'running'} aria-describedby="{uid}-record-h">
						<option value={null}>No other record</option>
						{#each recordOptions as k (k)}<option value={k}>{FLOW_KIND_LABEL[k]}</option>{/each}
					</select>
					<span class="hint" id="{uid}-record-h">Scores the fit against a second instrument over that record’s own days. No extra fit.</span>
				</div>
			{/if}
		</div>
		{#if penalty}
			<p class="muted small">
				The WR2012 MAR penalty is on (Settings → WR2012 check), so the fit also runs once without it for comparison.
			</p>
		{/if}
		<div class="row">
			{#if status === 'running' || status === 'loading'}
				<button type="button" class="btn" onclick={() => session.cancel()} disabled={status === 'loading'}>Cancel</button>
			{:else}
				<button type="button" class="btn btn-primary" onclick={start} disabled={!canStart}>Fit automatically</button>
			{/if}
		</div>

		{#if status === 'loading'}
			<p class="muted small" role="status">Loading the project’s data…</p>
		{:else if status === 'running'}
			<div class="progress">
				<div
					class="bar"
					role="progressbar"
					aria-label="Calibration progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct}
					aria-valuetext="{pct}%{progress ? `, ${stageText(progress)}` : ''}"
				>
					<span style:width="{pct}%"></span>
				</div>
				<p class="muted small" aria-live="polite">
					{#if progress}{stageText(progress)}: {fmtNum(progress.evaluations)} of {fmtNum(progress.budget)} runs · best {fmtNum(progress.best, 3)}{:else}Starting…{/if}
				</p>
				<p class="muted small">You can open other tabs while it runs; the fit carries on and its result waits here.</p>
			</div>
		{:else if status === 'error'}
			<div class="alert alert-error" role="alert">{session.error}</div>
		{/if}

		{#if report}
			<div class="result" aria-live="polite">
				<h4>Result</h4>
				<p class="small muted">
					{objectiveName(report.objective)} · {BOUNDS_LABEL[report.bounds].replace(' (default)', '')} bounds · seed {report.seed}{report.starts > 1 ? ` · ${report.starts} starts` : ''} · {fmtNum(report.evaluations)} runs{report.exclusions.length ? ` · ${report.exclusions.length} excluded period${report.exclusions.length === 1 ? '' : 's'}` : ''} · fitted against the simulated outflow
				</p>
				{#each report.notes as n (n)}<p class="alert alert-warning small">{n}</p>{/each}
				<div class="table-wrap">
					<table class="data compact">
						<caption>Parameters</caption>
						<thead><tr><th scope="col">Parameter</th><th scope="col" class="num">Current</th><th scope="col" class="num">Fitted</th></tr></thead>
						<tbody>
							{#each report.free as k (k)}
								<tr><th scope="row">{paramLabel(k)}</th><td class="num">{fmtParam(report.startParams[k])}</td><td class="num">{fmtParam(report.params[k])}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if report.startResults.length > 1}
					<div class="table-wrap">
						<table class="data compact">
							<caption>Starts: separate searches of the whole record ({objectiveName(report.objective)} without any penalty)</caption>
							<thead>
								<tr>
									<th scope="col">Start</th>
									<th scope="col" class="num">Seed</th>
									<th scope="col" class="num">Score</th>
									{#each report.free as k (k)}<th scope="col" class="num">{paramLabel(k)}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each report.startResults as r, i (r.seed)}
									<tr class:kept={r.best}>
										<th scope="row">{i + 1}{#if r.best} (kept){/if}</th>
										<td class="num">{r.seed}</td>
										<td class="num">{fmtScore(r.score)}</td>
										{#each report.free as k (k)}<td class="num">{fmtParam(r.params[k])}</td>{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
				<div class="table-wrap">
					<table class="data compact scores">
						<caption>Fit, and validation on days the parameters were not fitted to <HelpTip key="validation-tests" label="About the validation columns" /></caption>
						<thead>
							<tr>
								<th scope="col">Score</th>
								{#each columns as c (c.id)}
									<th scope="col" class="num" class:val={c.validation}>{c.label}<br /><span class="period">{c.period}</span></th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each SCORE_ROWS as r (r.key)}
								<tr>
									<th scope="row">{r.label} <span class="muted">(ideal {r.ideal})</span> <HelpTip key={r.help} label="About {r.label}" /></th>
									{#each columns as c (c.id)}
										<td class="num" class:val={c.validation}>{scoreCellText(c, r.key, r.unit)}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if anyInterval}
					<p class="muted small">
						In brackets: the 90 % range of the score when whole water years are resampled (1 000 times). A short record gives a wide range; with
						fewer than 3 water years there is none. <HelpTip key="score-interval" label="About the score range" />
					</p>
				{/if}
				{#if benchRows.length}
					<div class="table-wrap">
						<table class="data compact scores" data-testid="fit-benchmarks">
							<caption>{objectiveName(report.objective)}: the model against two simple benchmarks on the same days <HelpTip key="fit-benchmarks" label="About the benchmarks" /></caption>
							<thead>
								<tr>
									<th scope="col">Simulation</th>
									{#each benchCols as c (c.id)}
										<th scope="col" class="num" class:val={c.validation}>{c.label}<br /><span class="period">{c.period}</span></th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each benchRows as b (b.label)}
									<tr>
										<th scope="row">{b.label}</th>
										{#each b.cells as v, i (i)}<td class="num" class:val={benchCols[i]?.validation}>{v}</td>{/each}
									</tr>
								{/each}
							</tbody>
							<!-- How to read it, once, at the table's foot (it was a note at the end of the panel, issue #174). -->
							<tfoot>
								<tr>
									<td colspan={benchCols.length + 1} class="muted small note" data-testid="fit-benchmarks-note">
										Judge the fit by the validation columns: they score days the parameters never saw. The model should clearly beat the mean
										flow every day, and in a strongly seasonal catchment the day-of-year climatology too.
									</td>
								</tr>
								{#if benchSource}
									<tr>
										<td colspan={benchCols.length + 1} class="muted small note" data-testid="fit-benchmarks-source">{benchSource}</td>
									</tr>
								{/if}
							</tfoot>
						</table>
					</div>
					{#if climWarning}<p class="alert alert-warning small" data-testid="fit-climatology-warning">{climWarning}</p>{/if}
				{/if}
				{#if report.differential}
					<p class="muted small" data-testid="fit-dsst-ranking">Dry → wet test: {rankedByText(report.differential)}.</p>
				{/if}
				<Wr2012FitTable periods={wr2012FitPeriods(report)} />
				{#if report.marPenalty}
					<MarPenaltyResult {report} penalty={report.marPenalty} {paramLabel} />
				{/if}
				{#if report.dayQuality}
					<!-- Calibration research CR-22: the per-day quality flags of the fitted record and its rain. -->
					<DataQualityPanel quality={report.dayQuality} />
				{/if}
				{#if report.representativeness}
					{@const rep = report.representativeness}
					<!-- Calibration research CR-34: the record's length and where its years sit in the long-term rain. -->
					<section class="rep" aria-labelledby="{uid}-rep-h" data-testid="fit-representativeness">
						<h5 id="{uid}-rep-h">How representative is the record <HelpTip key="record-representativeness" label="About how representative the record is" /> <span class="muted gist">{representativenessGist(rep)}</span></h5>
						<p class="small">{rep.summary}</p>
						{#if rep.years.length}
							<div class="table-wrap">
								<table class="data compact">
									<caption class="visually-hidden">Rain of each scored water year against the long-term record</caption>
									<thead>
										<tr>
											<th scope="col">Water year</th>
											<th scope="col" class="num">Scored days</th>
											<th scope="col" class="num">Rain</th>
											<th scope="col" class="num">Percentile</th>
											<th scope="col">Class</th>
										</tr>
									</thead>
									<tbody>
										{#each representativenessRows(rep) as row (row.year)}
											<tr>
												<th scope="row">{row.year}</th>
												<td class="num">{row.scoredDays}</td>
												<td class="num">{row.rain}</td>
												<td class="num">{row.percentile}</td>
												<td>{row.klass}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
						<p class="muted small">{representativenessKey(rep)} Any limit this implies is listed with the notes above.</p>
					</section>
				{/if}
				<div class="row">
					{#if !readonly}
						<button type="button" class="btn btn-primary" onclick={apply}>{session.applied ? 'Apply to form again' : 'Apply to form'}</button>
					{/if}
					<button type="button" class="btn" onclick={() => session.discard()}>Discard result</button>
					{#if !readonly}
						<span class="muted small" data-testid="fit-apply-hint">
							{session.applied
								? 'The fitted parameters are in the form, with this fit’s record. Save your changes to keep them.'
								: 'Fills in the fitted parameters and records this fit with them; nothing is saved until you save your changes. The result stays here while you look at other tabs.'}
						</span>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</section>

<style>
	.fit {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
		margin: 0.25rem 0 0.75rem;
	}
	h3 {
		margin: 0 0 0.25rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.controls {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.25rem 1.25rem;
		align-items: start;
		margin: 0.5rem 0;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.plain legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 32px;
	}
	.validate {
		align-self: end;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin: 0.5rem 0;
	}
	.progress {
		max-width: 520px;
	}
	.bar {
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		overflow: hidden;
	}
	.bar span {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
	.scores tfoot .note {
		white-space: normal;
		text-align: left;
		font-weight: 400;
		padding-top: 0.4rem;
	}
	.scores th.val,
	.scores td.val {
		background: var(--accent-soft);
	}
	tr.kept th,
	tr.kept td {
		font-weight: 600;
	}
	.rep h5 {
		margin: 0.75rem 0 0.25rem;
		font-size: 0.9rem;
	}
	.gist {
		font-weight: 400;
		font-size: 0.8rem;
	}
	.period {
		font-weight: 400;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
	}
	/* A label and its help tip on one line: the tip sits outside the label (a label holds only its own control). */
	.tip-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
</style>
