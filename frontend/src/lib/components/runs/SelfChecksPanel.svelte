<!--
	What the model says about its own run (engine ≥ 0.12.0): the self-checks,
	the water balance per water year (its own section on Runs & results,
	WaterBalanceTable; here in the printable report), and a trace of one farm's day with every
	intermediate column and its formula, or of the catchment's day in the
	runoff model (docs/ui.md § Self-checks).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { RunSummary } from '@water-management/engine';
	import { api, type RunCatchmentDay, type RunDay } from '$lib/api';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { checkLabel, catchmentClosure, catchmentTraceRows, checksHeadline, dayClosure, traceRows } from './checks';
	import WaterBalanceTable from './WaterBalanceTable.svelte';

	let {
		summary,
		projectId,
		runId,
		startDate,
		endDate,
		nodes,
		engineVersion,
		trace: showTrace = true,
		balanceHref
	}: {
		summary: RunSummary;
		projectId: string;
		runId: string;
		startDate: string;
		endDate: string;
		/** Nodes that can be traced, in network order. */
		nodes: { id: string; name: string; kind: 'farm' | 'gauge' | 'user' }[];
		/** The engine that made the run and ran its checks. */
		engineVersion?: string;
		/** Show Trace a day (the printable report leaves the interactive trace out). */
		trace?: boolean;
		/** Where the water balance's own section is (Runs & results); without it the table is drawn here (the printable report). */
		balanceHref?: string;
	} = $props();

	const uid = $props.id();
	const v = $derived(summary.verification);
	const headline = $derived(checksHeadline(v));

	// Trace: start on the farm and day with the largest balance residual, else the first farm on the first day.
	let nodeId = $state('');
	let date = $state('');
	$effect(() => {
		// Reset when another run is shown, and only then: a model edit mustn't clear the user's pick.
		void runId;
		untrack(() => {
			nodeId = v?.maxResidual?.nodeId ?? nodes.find((n) => n.kind === 'farm')?.id ?? nodes[0]?.id ?? '';
			date = v?.maxResidual?.date ?? startDate;
			day = null;
			traceError = null;
		});
	});
	/** The trace picker's value for the catchment (the runoff model's day) rather than a node. */
	const CATCHMENT = 'catchment';
	let day = $state.raw<RunDay | RunCatchmentDay | null>(null);
	let traceError = $state<string | null>(null);
	let tracing = $state(false);
	const rows = $derived(!day ? [] : day.kind === 'catchment' ? catchmentTraceRows(day) : traceRows(day));
	const closure = $derived(day && day.kind !== 'catchment' ? dayClosure(day) : null);
	const storeClosure = $derived(day?.kind === 'catchment' ? catchmentClosure(day) : null);

	async function trace(e: SubmitEvent) {
		e.preventDefault();
		if (!nodeId || !date) return;
		const want = runId;
		tracing = true;
		traceError = null;
		try {
			const res = nodeId === CATCHMENT ? await api.runs.catchmentDay(projectId, want, date) : await api.runs.day(projectId, want, nodeId, date);
			if (want === runId) day = res;
		} catch (err) {
			if (want === runId) {
				day = null;
				traceError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			tracing = false;
		}
	}

	/** Enough digits to see float noise without drowning the volumes. */
	const fmtValue = (x: number | null) => (x === null ? '–' : Math.abs(x) > 0 && Math.abs(x) < 1e-3 ? x.toExponential(2) : fmtNum(x, 3, true));
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Self-checks <HelpTip key="run.balance_residual" /></h3>
	<p class="alert {headline.tone === 'bad' ? 'alert-error' : 'alert-info'}" class:ok={headline.tone === 'ok'} role="status">
		{headline.text}
	</p>
	{#if v}
		<ul class="checks">
			{#each v.checks as c (c.id)}
				<li class:failed={!c.passed}>
					<span class="mark" aria-hidden="true">{c.passed ? '✓' : '✗'}</span>
					<span class="visually-hidden">{c.passed ? 'Passed:' : 'Failed:'}</span>
					{checkLabel(c.label)}
					{#if c.detail}<div class="detail">First problem: {c.detail}</div>{/if}
				</li>
			{/each}
		</ul>
		{#if engineVersion}<p class="muted small" data-testid="checks-engine">Checked by engine {engineVersion} when the run was made.</p>{/if}
		{#if v.maxResidual}
			<p class="muted small">
				Largest daily balance error of any hydrological unit (column V of its daily CSV): {fmtValue(v.maxResidual.valueM3Day)} m³/day, {v.maxResidual.name} on {v.maxResidual.date}.
				It should be float noise, far below the flows.
			</p>
		{/if}
	{/if}
</section>

{#if balanceHref}
	<!-- The water balance has its own section in Model quality (issue #137); the report keeps it here. -->
	<p class="muted small balance-link" data-testid="checks-balance-link">
		The water balance by water year is under Model quality: <a href={balanceHref}>Water balance</a>.
	</p>
{:else}
	<div class="wb"><WaterBalanceTable {summary} /></div>
{/if}

{#if showTrace}
<section aria-labelledby="{uid}-tr">
	<h3 id="{uid}-tr">Trace a day <HelpTip key="run.gross_demand" /></h3>
	<p class="muted small">
		Every column of one hydrological unit's day, with the formula the model used, so the day can be checked by hand. The hydrological unit's daily CSV has the same
		columns for every day. Pick the catchment to see how the runoff model turned the day's rain into natural flow.
	</p>
	<form class="trace-form" onsubmit={trace}>
		<label>
			<span>Hydrological unit, gauge or catchment</span>
			<select bind:value={nodeId}>
				<option value={CATCHMENT}>Catchment (rain to natural flow)</option>
				{#each nodes as n (n.id)}<option value={n.id}>{n.name}{n.kind === 'gauge' ? ' (gauge)' : n.kind === 'user' ? ' (other user)' : ''}</option>{/each}
			</select>
		</label>
		<label>
			<span>Day</span>
			<input type="date" bind:value={date} min={startDate} max={endDate} required />
		</label>
		<button type="submit" class="btn btn-sm" disabled={tracing || !nodeId}>{tracing ? 'Tracing…' : 'Trace'}</button>
	</form>
	{#if traceError}<p class="alert alert-error" role="alert">{traceError}</p>{/if}
	{#if day}
		<div class="table-wrap" aria-live="polite">
			<table class="data compact trace">
				<caption>{day.name}{day.kind === 'catchment' ? ` (${day.runoffModel === 'gr4j' ? 'GR4J' : day.runoffModel})` : ''} on {day.date}</caption>
				<thead>
					<tr>
						<th scope="col">Col.</th>
						<th scope="col">Quantity</th>
						<th scope="col" class="num">Value</th>
						<th scope="col">Formula</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr class:residual={r.key === 'balance_residual'}>
							<td class="letter">{r.letter ?? ''}</td>
							<th scope="row">{r.label}</th>
							<td class="num">{fmtValue(r.value)} <span class="u">{r.unit ?? ''}</span></td>
							<td class="formula">{r.formula}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if day.kind === 'catchment'}
			{#if storeClosure}
				<p class="closure small">
					Stores before {fmtValue(storeClosure.before)} + rain (P) {fmtValue(storeClosure.rain)} + exchange (F) {fmtValue(storeClosure.exchange)} − evaporated (AET)
					{fmtValue(storeClosure.evaporation)} − flow (Q) {fmtValue(storeClosure.flow)} − stores after {fmtValue(storeClosure.after)} =
					<strong>{fmtValue(storeClosure.residual)}</strong> mm
				</p>
			{:else if day.runoffModel === 'legacy'}
				<p class="muted small">
					This run used the legacy runoff model, which keeps no stores: the columns show how the day's rain became flow, but there is no store
					balance to close. GR4J runs trace the stores.
				</p>
			{:else}
				<p class="muted small">This run didn't record every store for this day, so its balance can't be worked out here.</p>
			{/if}
		{:else if closure}
			<p class="closure small">
				In (H + I + J + rain on dam) {fmtValue(closure.inflow)} − used (G − T) {fmtValue(closure.consumptive)} − evaporated {fmtValue(closure.evaporation)} − stored (Q − Q[t−1]) {fmtValue(closure.storageChange)}
				− out (U) {fmtValue(closure.outflow)} = <strong>{fmtValue(closure.residual)}</strong> m³
			</p>
		{:else if day.kind === 'farm'}
			<p class="muted small">This run was made before the working columns were recorded (engine 0.12.0); run the model again to trace it in full.</p>
		{/if}
	{/if}
</section>
{/if}

<style>
	.wb,
	.wb + section,
	.balance-link + section {
		margin-top: 1.25rem;
	}
	.alert.ok {
		background: var(--success-soft);
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, var(--border));
	}
	.checks {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
	}
	.checks li {
		padding: 0.2rem 0;
	}
	.mark {
		display: inline-block;
		width: 1.2rem;
		color: var(--success);
		font-weight: 700;
	}
	.failed .mark {
		color: var(--danger);
	}
	.detail {
		margin-left: 1.2rem;
		font-size: 0.8rem;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.balance-link {
		margin: 0.75rem 0 0;
	}
	.trace-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
		margin: 0.5rem 0;
	}
	.trace-form label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.8rem;
	}
	.trace caption {
		text-align: left;
		font-weight: 600;
		padding-bottom: 0.25rem;
	}
	.letter {
		font-family: var(--font-mono, monospace);
		white-space: nowrap;
	}
	.formula {
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.u {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	tr.residual th,
	tr.residual td {
		border-top: 2px solid var(--border);
	}
	.closure {
		margin: 0.5rem 0 0;
		overflow-wrap: anywhere;
	}
</style>
