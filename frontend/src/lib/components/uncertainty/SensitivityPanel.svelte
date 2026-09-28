<!--
	Sensitivity runs: EWR compliance as a range (calibration research CR-21,
	docs/ui.md § Sensitivity runs, docs/model.md §2.10g). Beside the
	uncertainty bands on River & reserve.

	Run fetches the run's own inputs and runs the central case and each
	factor's low and high (rain, pan coefficient, dam evaporation,
	abstraction, the dams' starting storage) in the calibration worker, so
	the page stays responsive. Nothing is stored: it is a live diagnostic
	anyone who can see the run can repeat. The verdict per EWR site is
	re-judged at once when the threshold changes; the tornado and its table
	show the swing of each factor.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { SENSITIVITY_THRESHOLDS, type SensitivityResult } from '@water-management/engine';
	import { api } from '$lib/api';
	import { FitCancelled, startSensitivity, type EnsembleHandle } from '$lib/calibration/runner';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import TornadoChart from './TornadoChart.svelte';
	import { factorsLine, metricsFor, thresholdOn, tornadoRows, TORNADO_METRICS, VERDICT_LABELS, verdictsAt, type TornadoMetric } from './sensitivity';

	let { projectId, runId }: { projectId: string; runId: string } = $props();

	const uid = $props.id();
	let result = $state<SensitivityResult | null>(null);
	let running = $state(false);
	let progress = $state<{ done: number; total: number } | null>(null);
	let error = $state<string | null>(null);
	let handle: EnsembleHandle<SensitivityResult> | null = null;
	onDestroy(() => handle?.cancel());

	// Thresholds on screen, in %; the verdict is re-judged from the stored values without a re-run.
	let daysMetPct = $state(SENSITIVITY_THRESHOLDS.daysMet * 100);
	let reservePct = $state(SENSITIVITY_THRESHOLDS.reserveRate * 100);
	const clamp01 = (v: number, d: number) => (Number.isFinite(v) ? Math.min(Math.max(v / 100, 0), 1) : d);
	const thresholds = $derived({ daysMet: clamp01(daysMetPct, SENSITIVITY_THRESHOLDS.daysMet), reserveRate: clamp01(reservePct, SENSITIVITY_THRESHOLDS.reserveRate) });

	let siteIndex = $state(0);
	let metric = $state<TornadoMetric>('daysNotMet');

	async function run() {
		error = null;
		running = true;
		progress = null;
		try {
			const input = await api.uncertainty.runInput(projectId, runId);
			handle = startSensitivity({ kind: 'sensitivity', input, options: {} }, (p) => (progress = p));
			const r = await handle.result;
			result = r;
			siteIndex = 0;
			metric = metricsFor(r.sites[0]?.hasRuleTable ?? false)[0]!;
		} catch (err) {
			if (!(err instanceof FitCancelled)) error = err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
			progress = null;
			handle = null;
		}
	}

	const verdicts = $derived(result ? verdictsAt(result, thresholds) : []);
	const site = $derived(result?.sites[siteIndex] ?? null);
	const metrics = $derived(metricsFor(site?.hasRuleTable ?? false));
	const shownMetric = $derived(metrics.includes(metric) ? metric : metrics[0]!);
	const rows = $derived(result ? tornadoRows(result, siteIndex, shownMetric) : []);
	const central = $derived(result?.central[siteIndex]?.[shownMetric] ?? null);
	const threshold = $derived(result ? thresholdOn(shownMetric, verdicts[siteIndex], result.days) : null);
	const m = $derived(TORNADO_METRICS[shownMetric]);
	const hasReserve = $derived(result?.sites.some((s) => s.hasRuleTable) ?? false);
</script>

<section aria-labelledby="{uid}-h" data-testid="sensitivity-panel">
	<h3 id="{uid}-h">Sensitivity runs</h3>
	<p class="muted small">
		How far EWR compliance moves when one input the record can't settle is changed at a time: rain ±10 %, the pan coefficient and the dam
		evaporation factor ±15 %, abstraction ±30 %, and the dams starting empty or full. The runoff parameters stay this run's. A result whose
		range crosses the threshold is not determinable with current data. Nothing is stored.
	</p>

	<div class="actions">
		<button type="button" class="btn btn-sm" onclick={run} disabled={running}>{running ? 'Running…' : result ? 'Run again' : 'Run sensitivity'}</button>
		{#if running}<button type="button" class="btn btn-sm" onclick={() => handle?.cancel()}>Cancel</button>{/if}
		{#if progress}
			<span role="status" aria-live="polite" class="small" data-testid="sensitivity-progress">{fmtNum(progress.done)} of {fmtNum(progress.total)} runs</span>
		{/if}
	</div>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	{#if result && site}
		<p class="muted small">
			{factorsLine(result)} · EWR days and shortfall over the reporting window {fmtDay(result.reportStart)} – {fmtDay(result.reportEnd)} ({fmtNum(result.days)} days) · engine
			{result.engineVersion}
		</p>

		<div class="form-row">
			<div class="field">
				<label for="{uid}-dm">Threshold: days the EWR is met (%)</label>
				<input id="{uid}-dm" type="number" min="0" max="100" step="5" bind:value={daysMetPct} />
			</div>
			{#if hasReserve}
				<div class="field">
					<label for="{uid}-rr">Threshold: months meeting the rule table (%)</label>
					<input id="{uid}-rr" type="number" min="0" max="100" step="5" bind:value={reservePct} />
				</div>
			{/if}
		</div>
		<p class="muted small">The thresholds are defaults (80 %) pending the hydrologist: a rule table and the pragmatic EWR carry no pass mark of their own.</p>

		<ul class="verdicts" data-testid="sensitivity-verdicts">
			{#each verdicts as v (v.key)}
				<li class={v.verdict}>
					<strong>{VERDICT_LABELS[v.verdict]}.</strong>
					{v.text}
				</li>
			{/each}
		</ul>

		<div class="form-row">
			{#if result.sites.length > 1}
				<div class="field">
					<label for="{uid}-s">EWR site</label>
					<select id="{uid}-s" bind:value={siteIndex}>
						{#each result.sites as s, i (s.key)}<option value={i}>{s.name}</option>{/each}
					</select>
				</div>
			{/if}
			<div class="field">
				<label for="{uid}-m">Result</label>
				<select id="{uid}-m" value={shownMetric} onchange={(e) => (metric = e.currentTarget.value as TornadoMetric)}>
					{#each metrics as k (k)}<option value={k}>{TORNADO_METRICS[k].label}</option>{/each}
				</select>
			</div>
		</div>

		{#if rows.length}
			<h4 id="{uid}-tt">{m.label} at {site.name}, {m.unit}: each factor's low and high against the central run</h4>
			<TornadoChart title="{m.label} at {site.name}, {m.unit}, by sensitivity factor" {rows} {central} metric={shownMetric} {threshold} />
			<p class="muted small">
				Largest swing first. Blue: the factor's low setting; orange: its high setting; each is named beside its bar. The solid line is the
				central run{threshold !== null ? ', the dashed line the threshold' : ''}.
			</p>
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-cap">
					<caption id="{uid}-cap">{m.label} at {site.name} ({m.unit}): central {m.fmt(central)}</caption>
					<thead>
						<tr>
							<th scope="col">Factor</th>
							<th scope="col">Low</th>
							<th scope="col" class="num">Result</th>
							<th scope="col">High</th>
							<th scope="col" class="num">Result</th>
							<th scope="col" class="num">Swing</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.factor)}
							<tr>
								<th scope="row">{r.label}</th>
								<td>{r.lowLabel}</td>
								<td class="num">{m.fmt(r.low)}</td>
								<td>{r.highLabel}</td>
								<td class="num">{m.fmt(r.high)}</td>
								<td class="num">{m.fmt(r.swing)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="empty">No factor applies to this project.</p>
		{/if}

		{#if result.skipped.length}
			<p class="muted small" data-testid="sensitivity-skipped">
				Not run: {result.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}.
			</p>
		{/if}
	{/if}
</section>

<style>
	.small {
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin: 0.75rem 0;
	}
	.verdicts {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0;
		display: grid;
		gap: 0.4rem;
	}
	.verdicts li {
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--border-strong);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		font-size: 0.9rem;
	}
	.verdicts li.meets {
		border-left-color: var(--success);
	}
	.verdicts li.fails {
		border-left-color: var(--danger);
	}
	.verdicts li.notDeterminable {
		border-left-color: var(--warning);
	}
	.empty {
		color: var(--text-muted);
	}
	h4 {
		margin: 1rem 0 0.5rem;
		font-size: 0.95rem;
	}
</style>
