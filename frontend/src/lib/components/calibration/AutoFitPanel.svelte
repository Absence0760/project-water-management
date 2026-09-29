<!--
	Automated calibration (issue #153): runs the project's saved calibration
	rules end to end in the calibration worker. The rules leave years out,
	fit every case with validation and keep one by its held-out score among
	the fits that pass the filters, or none, saying why. It only runs on the
	saved rules (a fit must run under rules fixed before its result is seen),
	and, like Fit automatically, never saves: Apply writes the kept fit and
	its record into the form.
-->
<script lang="ts">
	import {
		rulesLines,
		waterYearLabel,
		type AutoCalibrationProgress,
		type AutoCalibrationReport,
		type CalibrationFlowKind,
		type CalibrationReport,
		type CalibrationRules,
		type FitRecord,
		type ProjectModel,
		type ProjectSettings,
		type SeriesOrigin,
		type SeriesProvenance,
		type ApanDailyFingerprint
	} from '@water-management/engine';
	import { api } from '$lib/api';
	import { apanDailyOfValues, chirpsSourceOfInput } from '$lib/series/provenance';
	import { fitInput, marPenaltyOn } from '$lib/calibration/fit';
	import { autoCaseRows, autoFitRecordFor, autoProgressFraction, autoRunsTotal, autoStageText, keptPan, rulesUnsaved, selectionText } from '$lib/calibration/autoFit';
	import { FitCancelled, startAutoFit } from '$lib/calibration/runner';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';

	let {
		projectId,
		settings,
		savedRules,
		formRules,
		model,
		hasObserved,
		readonly,
		onApply
	}: {
		projectId: string;
		/** The Settings form as it stands (unsaved edits included). */
		settings: () => ProjectSettings;
		/** settings.calibrationRules as saved: the only rules the run uses. */
		savedRules: CalibrationRules;
		/** The form's rules as they stand: the run and Apply wait while they differ from the saved ones. */
		formRules: CalibrationRules;
		model?: () => ProjectModel | undefined;
		hasObserved: boolean;
		readonly: boolean;
		/** Writes the kept fit, its record and the pan coefficient it was fitted under (when not the project's) into the form. */
		onApply: (report: CalibrationReport, record: FitRecord, pan: { values: number[]; source: string } | null) => void;
	} = $props();

	const uid = $props.id();
	let status = $state<'idle' | 'loading' | 'running' | 'done' | 'error'>('idle');
	let progress = $state<AutoCalibrationProgress | null>(null);
	let report = $state.raw<AutoCalibrationReport | null>(null);
	let error = $state<string | null>(null);
	let handle: { cancel(): void } | null = null;
	let ran: { settings: ProjectSettings; chirpsSource?: SeriesProvenance | null; apanDaily?: ApanDailyFingerprint | null; observedOrigin?: SeriesOrigin | null } | null = null;
	// Whether the WR2012 penalty adds a fit, as the last run saw it (for its progress bar).
	let runPenalty = false;

	const unsaved = $derived(rulesUnsaved(savedRules, formRules));
	const busy = $derived(status === 'running' || status === 'loading');
	const canStart = $derived(hasObserved && !unsaved && !busy);
	const pct = $derived(progress ? Math.round(100 * autoProgressFraction(progress, runPenalty, savedRules.run.starts)) : 0);
	const rows = $derived(report ? autoCaseRows(report) : []);
	const kept = $derived(report && report.chosen !== null ? report.cases[report.chosen]! : null);

	async function start() {
		if (!canStart) return;
		status = 'loading';
		error = null;
		report = null;
		progress = null;
		try {
			const server = await api.runs.modelInput(projectId);
			// The form as it stands, but always under the saved rules.
			const form = { ...settings(), calibrationRules: savedRules };
			const input = fitInput(server, form, model?.());
			const context = { settings: form, chirpsSource: chirpsSourceOfInput(server.series), apanDaily: await apanDailyOfValues(server.series.evap_apan_mm) };
			status = 'running';
			runPenalty = marPenaltyOn(form);
			const h = startAutoFit({ kind: 'auto', input }, (p) => (progress = p));
			handle = h;
			report = await h.result;
			const fitted = server.series[report.flowKind as CalibrationFlowKind];
			ran = { ...context, ...(fitted?.origin !== undefined ? { observedOrigin: fitted.origin } : {}) };
			status = 'done';
		} catch (e) {
			if (e instanceof FitCancelled) {
				status = 'idle';
				return;
			}
			error = e instanceof Error ? e.message : String(e);
			status = 'error';
		} finally {
			handle = null;
		}
	}

	function apply() {
		if (!report || !ran || !kept?.report || unsaved) return;
		const record = autoFitRecordFor(report, ran.settings, ran);
		if (record) onApply(kept.report, record, keptPan(report));
	}

	const fmtParam = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 3));
	$effect(() => () => handle?.cancel());
</script>

<section class="auto" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Automated calibration <HelpTip key="calibration-rules" /></h3>
	{#if !hasObserved}
		<p class="muted small">Upload an observed or logger flow record (Data) to calibrate against it.</p>
	{:else}
		<p class="muted small">
			Runs the saved calibration rules below from start to finish: no one chooses after the scores are seen. It fits in your browser and never saves:
			apply the kept fit to the form, then save.
		</p>
		<dl class="rules small" data-testid="auto-rules">
			<dt>Rules</dt>
			<dd>Revision {savedRules.revision}, {savedRules.signedOff ? `signed off by ${savedRules.signedOff.by} on ${savedRules.signedOff.on}` : 'draft (not signed off)'}</dd>
			{#each rulesLines(savedRules) as l (l.subject)}
				<dt>{l.subject}</dt>
				<dd>{l.text}</dd>
			{/each}
		</dl>
		{#if !savedRules.signedOff}
			<p class="alert alert-warning small">These rules are drafts until the hydrologist signs them off: a fit they keep is not evidence yet.</p>
		{/if}
		<p class="muted small" data-testid="auto-runs">{fmtNum(autoRunsTotal(savedRules, marPenaltyOn(settings())))} model runs in all, by the rules’ search.</p>
		{#if unsaved}
			<p class="alert alert-info small" data-testid="auto-rules-unsaved">The calibration rules have unsaved changes. Save them first: automated calibration only runs, and its fit only applies, under saved rules.</p>
		{/if}
		<div class="row">
			{#if busy}
				<button type="button" class="btn" onclick={() => handle?.cancel()} disabled={status === 'loading'}>Cancel</button>
			{:else}
				<button type="button" class="btn btn-primary" onclick={start} disabled={!canStart}>Run the calibration rules</button>
			{/if}
		</div>

		{#if status === 'loading'}
			<p class="muted small" role="status">Loading the project’s data…</p>
		{:else if status === 'running'}
			<div class="progress">
				<div
					class="bar"
					role="progressbar"
					aria-label="Automated calibration progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={pct}
					aria-valuetext="{pct}%{progress ? `, ${autoStageText(progress)}` : ''}"
				>
					<span style:width="{pct}%"></span>
				</div>
				<p class="muted small" aria-live="polite">{progress ? autoStageText(progress) : 'Starting…'}</p>
			</div>
		{:else if status === 'error'}
			<div class="alert alert-error" role="alert">{error}</div>
		{/if}

		{#if report}
			<div class="result" aria-live="polite">
				<h4>Result</h4>
				<p class="small muted">
					Kept by {selectionText(report.rules)} · rules revision {report.rules.revision} · seed {report.seed} · {report.starts} start{report.starts === 1 ? '' : 's'} and {fmtNum(report.budget)} model runs per fit
				</p>
				{#each report.notes as n (n)}<p class="alert alert-warning small">{n}</p>{/each}
				{#if report.ruleExclusions.length}
					<p class="small" data-testid="auto-rule-exclusions">
						Left out by rule: {report.years
							.filter((y) => y.excluded)
							.map((y) => `WY ${waterYearLabel(y.waterYear)} (${y.flaggedDays} of ${y.observedDays} days flagged)`)
							.join(', ')}.
					</p>
				{/if}
				<div class="table-wrap">
					<table class="data compact">
						<caption>Fits the rules tried</caption>
						<thead>
							<tr>
								<th scope="col">Fit</th>
								<th scope="col">Result</th>
								<th scope="col" class="num">Held-out score</th>
								<th scope="col" class="num">Natural MAR (Mm³/a)</th>
								<th scope="col">Filters</th>
								<th scope="col">Why not kept</th>
							</tr>
						</thead>
						<tbody>
							{#each rows as r, i (i)}
								<tr class:kept={r.verdict === 'Kept'}>
									<th scope="row">{r.label}</th>
									<td>{r.verdict}</td>
									<td class="num">{r.score}</td>
									<td class="num">{r.mar}</td>
									<td>{r.filters}</td>
									<td>{r.reasons.join('; ') || '–'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if kept?.report}
					<div class="table-wrap">
						<table class="data compact">
							<caption>Kept fit: parameters</caption>
							<thead><tr><th scope="col">Parameter</th><th scope="col" class="num">Current</th><th scope="col" class="num">Fitted</th></tr></thead>
							<tbody>
								{#each kept.report.free as k (k)}
									<tr><th scope="row">{k.toUpperCase()}</th><td class="num">{fmtParam(kept.report.startParams[k])}</td><td class="num">{fmtParam(kept.report.params[k])}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if !readonly}
						<div class="row">
							<button type="button" class="btn btn-primary" onclick={apply} disabled={unsaved}>Apply the kept fit to form</button>
							<span class="muted small">
								Fills in its parameters{kept.pan.values ? ' and the pan coefficient it was fitted under' : ''}, and records how the rules chose it; nothing is saved until you
								press Save settings.
							</span>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	{/if}
</section>

<style>
	.auto {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
		margin: 0.75rem 0;
	}
	h3 {
		margin: 0 0 0.25rem;
	}
	h4 {
		margin: 0.75rem 0 0.25rem;
	}
	.rules {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.1rem 0.75rem;
		margin: 0.5rem 0;
	}
	.rules dt {
		font-weight: 500;
		color: var(--text-2);
	}
	.rules dd {
		margin: 0;
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
	tr.kept th,
	tr.kept td {
		font-weight: 600;
	}
	@media (max-width: 640px) {
		.rules {
			grid-template-columns: 1fr;
		}
		.btn {
			min-height: 44px;
		}
	}
</style>
