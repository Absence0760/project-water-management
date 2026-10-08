<!--
	Automated calibration (issue #153): the server runs the project's saved
	calibration rules, one background job per fit, and keeps a fit by its
	held-out score among the fits that pass the filters, or none, saying why.
	New data can queue a run too (the rules' "after" group). Applying the kept
	fit is the server's: it saves the parameters with a fit record it builds,
	makes a run and, when the rules say so, queues the uncertainty ensemble
	around it. The page only asks, shows and follows.
-->
<script lang="ts">
	import { rulesLines, waterYearLabel, type CalibrationRules } from '@water-management/engine';
	import { api } from '$lib/api';
	import type { AutoCalibration } from '$lib/api/types';
	import { applyBlocker, autoCaseRows, autoRunsTotal, autoState, rulesUnsaved, selectionText, triggerText } from '$lib/calibration/autoFit';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';

	let {
		projectId,
		savedRules,
		formRules,
		formDirty,
		penalty,
		hasObserved,
		readonly,
		onApplied
	}: {
		projectId: string;
		/** settings.calibrationRules as saved: the only rules the server runs. */
		savedRules: CalibrationRules;
		/** The form's rules as they stand: the run and Apply wait while they differ from the saved ones. */
		formRules: CalibrationRules;
		/** The settings form has unsaved edits: applying saves at once, so it waits for them to be saved or discarded. */
		formDirty: boolean;
		/** The WR2012 MAR penalty is on: each fit runs once more without it. */
		penalty: boolean;
		hasObserved: boolean;
		readonly: boolean;
		/** The server saved an applied fit: reload the project's settings. */
		onApplied: () => Promise<void>;
	} = $props();

	const uid = $props.id();
	let latest = $state.raw<AutoCalibration | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let runError = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const unsaved = $derived(rulesUnsaved(savedRules, formRules));
	const runState = $derived(latest ? autoState(latest) : null);
	const running = $derived(runState?.kind === 'running');
	const canStart = $derived(hasObserved && !readonly && !unsaved && !busy && !running);
	const rows = $derived(latest ? autoCaseRows(latest) : []);
	const kept = $derived(latest && latest.chosen !== null ? latest.cases[latest.chosen]! : null);
	const blocker = $derived(latest ? applyBlocker(latest, { rulesUnsaved: unsaved, formDirty, readonly }) : null);

	/** Follow a running calibration until it completes, fails or its job stops. */
	async function follow(id: string) {
		clearTimeout(timer);
		try {
			latest = await api.autoCalibrations.get(projectId, id);
			if (autoState(latest).kind === 'running') timer = setTimeout(() => follow(id), 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function load() {
		try {
			const [first] = await api.autoCalibrations.list(projectId);
			latest = first ?? null;
			if (first && autoState(first).kind === 'running') timer = setTimeout(() => follow(first.id), 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function start() {
		if (!canStart) return;
		busy = true;
		error = null;
		runError = null;
		try {
			const res = await api.autoCalibrations.start(projectId);
			latest = res.calibration;
			await follow(res.calibration.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function apply() {
		if (!latest || blocker) return;
		busy = true;
		error = null;
		try {
			const res = await api.autoCalibrations.apply(projectId, latest.id);
			latest = res.calibration;
			runError = res.runError;
			await onApplied();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		void projectId;
		load();
		return () => clearTimeout(timer);
	});
</script>

<section class="auto" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Automated calibration <HelpTip key="calibration-rules" label="About automated calibration" /></h3>
	{#if !hasObserved}
		<p class="muted small">Upload an observed or logger flow record (Data) to calibrate against it.</p>
	{:else}
		<p class="muted small">
			The server runs the saved calibration rules below from start to finish, one background job per fit: no one chooses after the scores are seen.
			Applying the kept fit saves it at once, with a record of how the rules chose it.
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
		<p class="muted small" data-testid="auto-runs">{fmtNum(autoRunsTotal(savedRules, penalty))} model runs in all, by the rules’ search.</p>
		{#if unsaved}
			<p class="alert alert-info small" data-testid="auto-rules-unsaved">The calibration rules have unsaved changes. Save them first: the server only runs, and applies fits under, saved rules.</p>
		{/if}
		{#if !readonly}
			<div class="row">
				<button type="button" class="btn btn-primary" onclick={start} disabled={!canStart}>Run the calibration rules</button>
			</div>
		{/if}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if latest && runState}
			<div class="result" data-testid="auto-result">
				<h4>Latest run</h4>
				<p class="small muted">
					{triggerText(latest)} · rules revision {latest.rulesRevision} · kept by {selectionText(latest.rules)} · {latest.createdAt.slice(0, 16).replace('T', ' ')}
				</p>
				{#if runState.kind === 'running'}
					<div class="progress">
						<div class="bar" role="progressbar" aria-label="Automated calibration progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={runState.progress ?? 0} aria-valuetext={runState.text}>
							<span style:width="{runState.progress ?? 0}%"></span>
						</div>
						<p class="muted small" role="status">{runState.text}</p>
					</div>
				{:else if runState.kind === 'failed' || runState.kind === 'stopped'}
					<p class="alert alert-error small" role="alert">{runState.text}</p>
				{/if}
				{#each latest.report?.notes ?? [] as n (n)}<p class="alert alert-warning small">{n}</p>{/each}
				{#if latest.plan.ruleExclusions.length}
					<p class="small" data-testid="auto-rule-exclusions">
						Left out by rule: {latest.plan.years
							.filter((y) => y.excluded)
							.map((y) => `WY ${waterYearLabel(y.waterYear)} (${y.flaggedDays} of ${y.observedDays} days flagged)`)
							.join(', ')}.
					</p>
				{/if}
				{#if rows.length}
					<div class="table-wrap">
						<table class="data compact">
							<caption>Fits the rules tried</caption>
							<thead>
								<tr>
									<th scope="col">Fit</th>
									<th scope="col">Result</th>
									<th scope="col" class="num">Held-out score <HelpTip key="calibration-selection-score" label="About the held-out score" /></th>
									<th scope="col" class="num">Natural MAR (Mm³/a) <HelpTip key="wr2012-check" label="About the natural MAR" /></th>
									<th scope="col">Filters <HelpTip key="calibration-rule-filters" label="About the filters" /></th>
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
				{/if}
				{#if kept?.params}
					<div class="table-wrap">
						<table class="data compact">
							<caption>Kept fit: parameters</caption>
							<thead><tr><th scope="col">Parameter</th><th scope="col" class="num">Fitted</th></tr></thead>
							<tbody>
								{#each Object.entries(kept.params) as [k, v] (k)}
									<tr><th scope="row">{k.toUpperCase()}</th><td class="num">{fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 3)}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if latest.appliedAt}
						<p class="small" data-testid="auto-applied">
							Applied by {latest.appliedBy ?? 'a former member'} on {latest.appliedAt.slice(0, 16).replace('T', ' ')}{latest.appliedRunId ? ', with a run' : ''}{latest.uncertaintyId
								? ' and its uncertainty ensemble (Runs tab)'
								: ''}.
						</p>
						{#if runError}<p class="alert alert-warning small">The fit is saved, but no run followed: {runError}</p>{/if}
					{:else if !readonly}
						<div class="row">
							<button type="button" class="btn btn-primary" onclick={apply} disabled={!!blocker || busy}>Apply and save the kept fit</button>
							<span class="muted small" data-testid="auto-apply-hint">{blocker ?? `Saves its parameters with a record of how the rules chose it${kept.pan.values ? ', and the pan coefficient it was fitted under' : ''}, then runs the model.`}</span>
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
