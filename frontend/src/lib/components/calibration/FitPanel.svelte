<!--
	"Fit automatically" (issue #4 phase 5): fits the selected runoff model's
	parameters to the observed record in a Web Worker, shows the fit next to
	its validation, and can write the result into the Settings form. It never
	saves: the user reviews the form and saves it.
-->
<script lang="ts">
	import { OBJECTIVES, type CalibrationFlowKind, type CalibrationProgress, type CalibrationReport, type ObjectiveId, type ProjectModel, type ProjectSettings, type RunoffModelId } from '@water-management/engine';
	import { untrack } from 'svelte';
	import { api } from '$lib/api';
	import { fitInput, fitParams, marPenaltyOn, objectiveName, progressFraction, SCORE_ROWS, scoreColumns, STAGE_LABEL, totalRuns, validationRecordOptions } from '$lib/calibration/fit';
	import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
	import MarPenaltyResult from './MarPenaltyResult.svelte';
	import { FitCancelled, startFit, type FitHandle } from '$lib/calibration/runner';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum } from '$lib/format/number';

	let {
		projectId,
		runoffModel,
		x2Open,
		settings,
		model,
		hasObserved,
		seriesKinds = null,
		calibrationFlowKind = null,
		readonly,
		onApply
	}: {
		projectId: string;
		runoffModel: RunoffModelId;
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
		onApply: (report: CalibrationReport) => void;
	} = $props();

	const uid = $props.id();
	let objective = $state<ObjectiveId>('kgePrime');
	let budget = $state<number | null>(1500);
	let validate = $state(true);
	let validationRecord = $state<CalibrationFlowKind | null>(null);
	// Offered only when the project has both a gauge and a logger record.
	const recordOptions = $derived(validationRecordOptions(seriesKinds, calibrationFlowKind));
	const chosenRecord = $derived(validationRecord && recordOptions.includes(validationRecord) ? validationRecord : null);
	// Seeded from the defaults up front, so the checkbox bindings never see a missing key.
	let picked = $state<Record<string, boolean>>(untrack(() => Object.fromEntries(fitParams(runoffModel, x2Open).map((p) => [p.key, p.checked]))));
	let status = $state<'idle' | 'loading' | 'running' | 'done' | 'error'>('idle');
	let progress = $state<CalibrationProgress | null>(null);
	let report = $state.raw<CalibrationReport | null>(null);
	let error = $state<string | null>(null);
	let handle: FitHandle | null = null;

	const params = $derived(fitParams(runoffModel, x2Open));
	// Keep the user's ticks; a parameter new to the list (another model, or X2
	// once exchange is on) starts at its default.
	$effect(() => {
		const prev = untrack(() => picked);
		picked = Object.fromEntries(params.map((p) => [p.key, prev[p.key] ?? p.checked]));
	});
	const free = $derived(params.filter((p) => picked[p.key]).map((p) => p.key));
	// The WR2012 MAR penalty (Settings → WR2012 check) adds a fit without it, for comparison.
	const penalty = $derived(marPenaltyOn(settings()));
	const runs = $derived(totalRuns(budget ?? 0, validate, penalty));
	const canStart = $derived(hasObserved && free.length > 0 && budget !== null && budget >= 50 && status !== 'running' && status !== 'loading');
	const columns = $derived(report ? scoreColumns(report) : []);
	const pct = $derived(progress ? Math.round(100 * progressFraction(progress, validate, penalty)) : 0);
	// A report for another model than the form now shows can't be applied.
	const stale = $derived(report !== null && report.model !== runoffModel);

	async function start() {
		if (!canStart || budget === null) return;
		status = 'loading';
		error = null;
		report = null;
		progress = null;
		try {
			const server = await api.runs.modelInput(projectId);
			const input = fitInput(server, settings(), model?.());
			status = 'running';
			handle = startFit({ input, model: runoffModel, objective, budget, free, validate, seed: 1, validationRecord: chosenRecord ?? undefined }, (p) => (progress = p));
			report = await handle.result;
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

	function cancel() {
		handle?.cancel();
	}

	function apply() {
		if (report && !stale) onApply(report);
	}

	const fmtScore = (v: number | null, unit: '' | '%') => (v === null ? '–' : unit === '%' ? `${v > 0 ? '+' : ''}${fmtNum(v, 1)}%` : fmtNum(v, 2));
	const fmtParam = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 3));
	const paramLabel = (key: string) => params.find((p) => p.key === key)?.label ?? key;

	$effect(() => () => handle?.cancel());
</script>

<section class="fit" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Fit automatically <HelpTip key="auto-calibration" /></h3>
	{#if !hasObserved}
		<p class="muted small">Upload an observed or logger flow record (Data) to fit the parameters to it.</p>
	{:else}
		<p class="muted small">
			Searches the {runoffModel === 'gr4j' ? 'GR4J' : 'legacy'} parameters for the best match between the run and the observed record, over the
			calibration window above. It uses the form as it stands, fits in your browser, and never saves: check the result, apply it to the form,
			then save.
		</p>
		<div class="controls">
			<div class="field">
				<label for="{uid}-obj">Objective</label>
				<select id="{uid}-obj" bind:value={objective} disabled={status === 'running'}>
					{#each OBJECTIVES as o (o)}<option value={o}>{objectiveName(o)}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="{uid}-budget">Model runs per fit</label>
				<NumberInput id="{uid}-budget" min={50} max={10_000} step={50} bind:value={budget} disabled={status === 'running'} aria-describedby="{uid}-budget-h" />
				<span class="hint" id="{uid}-budget-h">{fmtNum(runs)} runs in all. Default 1 500.</span>
			</div>
			<fieldset class="plain params">
				<legend>Parameters to fit</legend>
				{#each params as p (p.key)}
					<label class="check">
						<input type="checkbox" bind:checked={picked[p.key]} disabled={status === 'running'} />
						{p.label}
					</label>
				{/each}
			</fieldset>
			<label class="check validate">
				<input type="checkbox" bind:checked={validate} disabled={status === 'running'} />
				Validate: split-sample and dry → wet tests (three fits)
			</label>
			{#if recordOptions.length}
				<div class="field">
					<label for="{uid}-record">Also validate against</label>
					<select id="{uid}-record" bind:value={validationRecord} disabled={status === 'running'} aria-describedby="{uid}-record-h">
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
				<button type="button" class="btn" onclick={cancel} disabled={status === 'loading'}>Cancel</button>
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
					aria-valuetext="{pct}%{progress ? `, ${STAGE_LABEL[progress.stage]}` : ''}"
				>
					<span style:width="{pct}%"></span>
				</div>
				<p class="muted small" aria-live="polite">
					{#if progress}{STAGE_LABEL[progress.stage]}: {fmtNum(progress.evaluations)} of {fmtNum(progress.budget)} runs · best {fmtNum(progress.best, 3)}{:else}Starting…{/if}
				</p>
			</div>
		{:else if status === 'error'}
			<div class="alert alert-error" role="alert">{error}</div>
		{/if}

		{#if report}
			<div class="result" aria-live="polite">
				<h4>Result</h4>
				<p class="small muted">
					{objectiveName(report.objective)} · {fmtNum(report.evaluations)} runs · fitted against the {report.simulatedKey === 'natural_flow' ? 'natural flow' : 'simulated outflow'}
				</p>
				{#each report.notes as n (n)}<p class="alert alert-warning small">{n}</p>{/each}
				{#if stale}<p class="alert alert-info small">This fit is for the other runoff model; switch back to apply it.</p>{/if}
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
				<div class="table-wrap">
					<table class="data compact scores">
						<caption>Fit, and validation on days the parameters were not fitted to</caption>
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
									<th scope="row">{r.label} <span class="muted">(ideal {r.ideal})</span></th>
									{#each columns as c (c.id)}
										<td class="num" class:val={c.validation}>{fmtScore(c.scores[r.key] as number | null, r.unit)}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if report.marPenalty}
					<MarPenaltyResult {report} penalty={report.marPenalty} {paramLabel} />
				{/if}
				<p class="muted small">
					Judge the fit by the validation columns: they score days the parameters never saw. KGE of the mean flow is −0.41, so a
					model should clearly beat that.
				</p>
				{#if !readonly}
					<div class="row">
						<button type="button" class="btn btn-primary" onclick={apply} disabled={stale}>Apply to form</button>
						<span class="muted small">Fills in the fitted parameters; nothing is saved until you press Save settings.</span>
					</div>
				{/if}
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
	.small {
		font-size: 0.8rem;
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
	.scores th.val,
	.scores td.val {
		background: var(--accent-soft);
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
</style>
