<script lang="ts">
	// Preview: what the unsaved edits do to the last run, before saving (issue
	// #284, roadmap WP-1.17). The last run's own input (GET …/runs/:runId/
	// model-input) with only the unsaved settings and model edits laid over it
	// (lib/preview/overlay.ts), run in this browser by the preview worker
	// against the same input without them, and the two compared as the compare
	// page compares runs. Nothing is stored and no run slot is used. The
	// dialog is modal, so the edits can't change under an answer: each opening
	// works the preview out again.
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onDestroy, untrack } from 'svelte';
	import type { MetricDelta } from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import { fmtMetric, type MetricSpec } from '$lib/components/compare/delta';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import { runInputFor } from '$lib/preview/inputs';
	import type { PreviewEffect } from '$lib/preview/messages';
	import { overlayUnsaved, previewBaseRun, type UnsavedEdits } from '$lib/preview/overlay';
	import type { PreviewEngine } from '$lib/preview/runner';

	let {
		open = $bindable(false),
		projectId,
		runs,
		edits,
		what,
		left = []
	}: {
		open?: boolean;
		projectId: string;
		/** The project's runs, newest first (null when the page couldn't load them: the dialog then asks itself). */
		runs: RunMeta[] | null;
		/** The unsaved edits, read when the dialog opens. */
		edits: () => UnsavedEdits;
		/** What is unsaved, for the dialog's words ("settings", "model edits"). */
		what: string;
		/** Unsaved edits the caller left out of `edits`, in words, listed under "Not in this preview". */
		left?: string[];
	} = $props();

	type State =
		| { state: 'computing' }
		| { state: 'done'; effect: PreviewEffect; problems: string[] }
		| { state: 'error'; message: string }
		| { state: 'no-run' };
	let result = $state<State>({ state: 'computing' });
	/** The run the preview started from (previewBaseRun). */
	let base = $state<RunMeta | null>(null);
	let engine: PreviewEngine | null = null;
	let seq = 0;
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function compute() {
		const id = ++seq;
		result = { state: 'computing' };
		base = null;
		// Read now, while the dialog holds the page: plain copies, which a worker can be sent.
		const unsaved = edits();
		try {
			// The page's list, or (when it couldn't load it: null) the dialog's own, so a failed list never reads as "no run".
			const run = previewBaseRun(runs ?? (await api.runs.list(projectId)));
			if (id !== seq) return;
			base = run;
			if (!run) {
				result = { state: 'no-run' };
				return;
			}
			const input = await runInputFor(projectId, run.id, api.uncertainty.runInput);
			if (id !== seq) return;
			const { input: edited, problems } = overlayUnsaved(input, unsaved);
			engine ??= (await import('$lib/preview/runner')).createPreviewEngine();
			if (id !== seq) return;
			const effect = await engine.effect({ baseKey: `${projectId}/${run.id}`, base: input, edited });
			if (id === seq) result = { state: 'done', effect, problems: [...left, ...problems] };
		} catch (e) {
			// Closed, or opened again: not an error.
			if (id !== seq || (e instanceof Error && e.name === 'PreviewSuperseded')) return;
			result = { state: 'error', message: msg(e) };
		}
	}

	$effect(() => {
		// Only opening and closing start or stop it: the runs list refreshing, or the edits read, don't.
		if (open) untrack(() => void compute());
		else {
			seq++;
			engine?.cancel();
		}
	});

	onDestroy(() => {
		seq++;
		engine?.close();
	});

	type Row = { label: string; m: MetricDelta; spec: MetricSpec; unit?: string };
	const VOLUME: MetricSpec = { format: 'volume', better: 'neutral' };
	const rows = $derived.by<Row[]>(() => {
		if (result.state !== 'done') return [];
		const e = result.effect;
		const out: Row[] = [
			{ label: 'Demand met', m: e.totals.fractionSupplied, spec: { format: 'fraction', better: 'higher' } },
			{ label: 'Demand', m: e.totals.demandM3Day, spec: VOLUME, unit: 'm³/day' },
			{ label: 'Shortfall', m: e.totals.deficitM3Day, spec: { format: 'volume', better: 'lower' }, unit: 'm³/day' },
			{ label: 'Units below 95% supplied', m: e.totals.farmsBelowTarget, spec: { format: 'count', better: 'lower' } },
			{ label: 'Natural flow (mean)', m: e.catchment.meanNaturalFlowM3Day, spec: VOLUME, unit: 'm³/day' },
			{ label: 'Outflow at the outlet (mean)', m: e.catchment.meanSimulatedOutflowM3Day, spec: VOLUME, unit: 'm³/day' },
			{ label: 'Days the EWR is not met', m: e.catchment.ewrDaysNotMet, spec: { format: 'days', better: 'lower' } }
		];
		if (e.calibration) {
			out.push(
				{ label: 'NSE', m: e.calibration.nse, spec: { format: 'ratio', better: 'higher' } },
				{ label: 'KGE', m: e.calibration.kge, spec: { format: 'ratio', better: 'higher' } },
				{ label: 'Percent bias', m: e.calibration.pbias, spec: { format: 'percent', better: 'zero' } }
			);
		}
		return out;
	});
	const unchanged = $derived(
		result.state === 'done' && rows.every((r) => r.m.delta === null || r.m.delta === 0) && !result.effect.units.length && !result.effect.addedUnits.length && !result.effect.removedUnits.length
	);
	const UNITS_SHOWN = 10;
	const runName = (r: RunMeta) => r.label?.trim() || `the run of ${fmtDate(r.createdAt)}`;
</script>

<Dialog bind:open title="Preview: your unsaved {what}" wide>
	<div class="preview" data-testid="unsaved-preview" data-state={result.state}>
		{#if result.state === 'no-run'}
			<p data-testid="unsaved-preview-no-run">There is no run to compare with yet. The preview starts from the last run's inputs, so run the model once, then preview your edits before saving them.</p>
		{:else}
			<p class="lede">
				The last run{#if base}, <strong>{runName(base)}</strong>,{/if} on its own inputs, against the same inputs with your unsaved {what}. Worked out in this browser; nothing is saved and no run is used.
			</p>
			{#if result.state === 'computing'}
				<p role="status" class="muted">Working out the preview…</p>
			{:else if result.state === 'error'}
				<p class="failed" role="alert" data-testid="unsaved-preview-error">The preview couldn't be worked out: {result.message.replace(/\.$/, '')}.</p>
			{:else}
				{@const e = result.effect}
				{#if result.problems.length}
					<div class="alert alert-warning" data-testid="unsaved-preview-problems">
						<p>Not in this preview:</p>
						<ul>
							{#each result.problems as p (p)}<li>{p}.</li>{/each}
						</ul>
					</div>
				{/if}
				<p class="muted period">Over {fmtDay(e.startDate)} to {fmtDay(e.endDate)}, engine {e.engineVersion}. <HelpTip key="unsaved-preview" label="About this preview" /></p>
				{#if unchanged}<p data-testid="unsaved-preview-unchanged">These edits don't change any of the figures below.</p>{/if}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-wrap" tabindex="0" role="region" aria-label="The figures, last run and with your edits">
					<table class="data" data-testid="unsaved-preview-table">
						<caption class="visually-hidden">The last run and the same run with your unsaved {what}</caption>
						<thead>
							<tr><th scope="col">Figure</th><th scope="col" class="num">Last run</th><th scope="col" class="num">With your edits</th><th scope="col" class="num">Change</th></tr>
						</thead>
						<tbody>
							{#each rows as r (r.label)}
								<tr>
									<th scope="row">{r.label}{#if r.unit}{' '}<span class="unit">({r.unit})</span>{/if}</th>
									<td class="num">{fmtMetric(r.m.a, r.spec)}</td>
									<td class="num">{fmtMetric(r.m.b, r.spec)}</td>
									<td class="num"><Delta m={r.m} spec={r.spec} /></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if e.units.length}
					<h3>Units whose supply changes</h3>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div class="table-wrap" tabindex="0" role="region" aria-label="Units whose supply changes">
						<table class="data" data-testid="unsaved-preview-units">
							<thead>
								<tr><th scope="col">Unit</th><th scope="col" class="num">Demand met</th><th scope="col" class="num">Change</th><th scope="col" class="num">Shortfall change (m³/day)</th></tr>
							</thead>
							<tbody>
								{#each e.units.slice(0, UNITS_SHOWN) as u, i (i)}
									<tr>
										<th scope="row">{u.name}</th>
										<td class="num">{fmtMetric(u.fractionSupplied.a, { format: 'fraction', better: 'higher' })} → {fmtMetric(u.fractionSupplied.b, { format: 'fraction', better: 'higher' })}</td>
										<td class="num"><Delta m={u.fractionSupplied} spec={{ format: 'fraction', better: 'higher' }} /></td>
										<td class="num"><Delta m={u.deficitM3Day} spec={{ format: 'volume', better: 'lower' }} /></td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if e.units.length > UNITS_SHOWN}<p class="muted">And {e.units.length - UNITS_SHOWN} more, with smaller changes.</p>{/if}
				{/if}
				{#if e.addedUnits.length}<p>Added by your edits: {e.addedUnits.join(', ')}.</p>{/if}
				{#if e.removedUnits.length}<p>Removed by your edits: {e.removedUnits.join(', ')}.</p>{/if}
				<p class="muted foot">Changes saved since that run aren't in the preview, only the unsaved ones. A saved run reads the data as it is then, so its figures can differ.</p>
			{/if}
		{/if}
	</div>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
	{/snippet}
</Dialog>

<style>
	.preview p {
		margin: 0 0 0.6rem;
	}
	.lede {
		color: var(--text-2);
	}
	.period,
	.foot {
		font-size: 0.85rem;
	}
	.foot {
		margin-top: 0.8rem;
	}
	h3 {
		font-size: 0.95rem;
		margin: 1rem 0 0.4rem;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.unit {
		font-weight: 400;
		color: var(--text-2);
	}
	th[scope='row'] {
		font-weight: 500;
		text-align: left;
	}
	.failed {
		color: var(--danger);
	}
	.alert ul {
		margin: 0;
		padding-left: 1.2rem;
	}
</style>
