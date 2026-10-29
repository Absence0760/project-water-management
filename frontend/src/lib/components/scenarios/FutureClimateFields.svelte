<script lang="ts">
	// Add a change → Future climate (issue #621 slice 5; docs/ui.md § Scenarios,
	// docs/scenarios.md § Future climate): one climate model, pathway (SSP) and
	// window of the project's change factor table, which OpForm adds as a
	// `climate.delta` op (ops.ts buildOp). The table is worked out by a
	// background job over the catchment boundary (POST …/climate-factors); this
	// follows that job, says when the boundary changed since, and shows the
	// picked case's 24 factors before it is added. Editors only (OpForm is).
	import { onDestroy, untrack } from 'svelte';
	import { CLIMATE_HORIZONS, CLIMATE_SSPS, futureFactorsComplete, SSP_LABEL, type ClimateHorizon, type ClimateSsp, type FutureFactorTable } from '@water-management/engine';
	import { api, type ClimateFactorsState } from '#lib/api/index.js';
	import { fmtDate, fmtNum } from '#lib/format/number.js';
	import { jobStatus } from '#lib/components/yield/yield.js';
	import { MONTH_NAMES } from './fields';

	let {
		projectId,
		model = $bindable(''),
		ssp = $bindable(''),
		horizon = $bindable(''),
		table = $bindable(null)
	}: {
		projectId: string;
		model?: string;
		ssp?: ClimateSsp | '';
		horizon?: ClimateHorizon | '';
		/** The factor table the picks read, for buildOp; null until one is worked out. */
		table?: FutureFactorTable | null;
	} = $props();

	let cf = $state.raw<ClimateFactorsState | null>(null);
	let loadError = $state<string | null>(null);
	let startError = $state<string | null>(null);
	let starting = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** Read the state; while its job is queued or running, again in 1.5 s. */
	async function load() {
		clearTimeout(timer);
		try {
			const s = await api.climateFactors.get(projectId);
			cf = s;
			loadError = null;
			table = s.factors?.factors ?? null;
			if (jobStatus(s.job)?.busy) timer = setTimeout(load, 1500);
		} catch (e) {
			loadError = msg(e);
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	async function start() {
		starting = true;
		startError = null;
		try {
			await api.climateFactors.start(projectId);
			await load();
		} catch (e) {
			startError = msg(e);
		} finally {
			starting = false;
		}
	}

	const status = $derived(jobStatus(cf?.job ?? null));
	/** The newest job's failure, unless a table was made after it. */
	const failed = $derived(status?.failed && cf?.job && (!cf.factors || cf.job.createdAt > cf.factors.createdAt) ? status.text : null);
	const models = $derived(table ? [...new Set(table.cases.map((c) => c.model))] : []);
	const picked = $derived(table?.cases.find((c) => c.model === model && c.ssp === ssp && c.horizon === horizon) ?? null);
	const windowText = (h: ClimateHorizon) => `${CLIMATE_HORIZONS[h].from}–${CLIMATE_HORIZONS[h].to}`;
</script>

<div class="climate" data-testid="op-climate">
	{#if loadError}
		<p class="alert alert-error" role="alert">The change factors couldn’t be read: {loadError}</p>
	{:else if !cf}
		<p class="hint" role="status">Reading the change factors…</p>
	{:else if !cf.enabled}
		<p class="hint" data-testid="op-climate-off">Future climate is off on this server: the climate projections aren’t loaded.</p>
	{:else}
		{#if cf.boundary === 'none'}
			<p class="hint" data-testid="op-climate-boundary">
				The change factors are read over the catchment boundary on the Map tab{cf.factors ? ', which has since been removed' : ''}. Draw or upload one there first.
			</p>
		{:else if !cf.factors && !status?.busy}
			<p class="hint">The change factors haven’t been worked out for this catchment yet. It takes each climate model in the data copy, over the boundary’s 0.25° cells.</p>
		{:else if cf.boundary === 'changed'}
			<p class="alert alert-warning" data-testid="op-climate-changed">The catchment boundary has changed since these factors were worked out. Work them out again to read them over the new one.</p>
		{/if}
		{#if status?.busy}
			<p class="hint" role="status" data-testid="op-climate-job">Working out the change factors. {status.text}</p>
		{:else if cf.boundary !== 'none' && (!cf.factors || cf.boundary === 'changed' || failed)}
			<p>
				<button type="button" class="btn" disabled={starting} onclick={start}>{starting ? 'Queueing…' : cf.factors ? 'Work them out again' : 'Work out the change factors'}</button>
			</p>
		{/if}
		{#if failed}<p class="alert alert-error" role="alert" data-testid="op-climate-failed">The change factors couldn’t be worked out. {failed}</p>{/if}
		{#if startError}<p class="alert alert-error" role="alert">{startError}</p>{/if}

		{#if cf.factors && table}
			<div class="form-row">
				<div class="field">
					<label for="op-climate-model">Climate model</label>
					<select id="op-climate-model" bind:value={model}>
						<option value="" disabled>Pick one</option>
						{#each models as m (m)}<option value={m}>{m}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="op-climate-ssp">Pathway</label>
					<select id="op-climate-ssp" bind:value={ssp}>
						<option value="" disabled>Pick one</option>
						{#each CLIMATE_SSPS as s (s)}<option value={s}>{SSP_LABEL[s]}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="op-climate-horizon">Window</label>
					<select id="op-climate-horizon" bind:value={horizon}>
						<option value="" disabled>Pick one</option>
						{#each Object.keys(CLIMATE_HORIZONS) as ClimateHorizon[] as h (h)}<option value={h}>{windowText(h)}</option>{/each}
					</select>
				</div>
			</div>
			<p class="hint" data-testid="op-climate-source">
				{models.length} climate model{models.length === 1 ? '' : 's'}, worked out {fmtDate(cf.factors.createdAt)}{cf.factors.createdBy ? ` by ${cf.factors.createdBy}` : ''}, against the
				{table.windows.baseline.from}–{table.windows.baseline.to} baseline. Source: {table.citation}
			</p>
			{#if !futureFactorsComplete(table)}
				<p class="alert alert-warning" data-testid="op-climate-partial">
					These factors rest on part of their 30-year windows: the data copy holds only some of their years. Read them as a trial of the method, not as projections.
				</p>
			{/if}
			{#each cf.factors.warnings as w, i (i)}<p class="hint">{w}</p>{/each}
			{#if picked}
				<div class="table-wrap">
					<table class="data compact" data-testid="op-climate-factors">
						<caption>Change factors of {picked.model}, {SSP_LABEL[picked.ssp]}, {windowText(picked.horizon)}, by calendar month</caption>
						<thead>
							<tr>
								<th scope="col"></th>
								{#each MONTH_NAMES as m (m)}<th scope="col" class="num">{m}</th>{/each}
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row">Rain</th>
								{#each picked.rainFactorByMonth as f, i (i)}<td class="num">× {fmtNum(f, 2)}</td>{/each}
							</tr>
							<tr>
								<th scope="row">Evaporation</th>
								{#each picked.evapFactorByMonth as f, i (i)}<td class="num">× {fmtNum(f, 2)}</td>{/each}
							</tr>
						</tbody>
					</table>
				</div>
				{#each picked.warnings as w, i (i)}<p class="hint">{w}</p>{/each}
			{/if}
		{/if}
	{/if}
	<p class="hint">
		Always a <strong>baseline assumption</strong>: the climate is never the applicant’s to propose, so an assessor sees this change in red.
		<span class="explain">
			Every rain record and the evaporation inputs (the A-pan row, the daily A-pan, reference ET, a monthly PE row) are multiplied by the month’s factor, and every MAP by the
			year’s. The historical sequence stays: droughts come when they did, no longer or more often. One future climate a scenario.
		</span>
	</p>
</div>

<style>
	.climate {
		margin: 0 0 0.75rem;
	}
	.field {
		min-width: 10rem;
	}
	.hint {
		font-size: var(--font-sm);
		color: var(--text-muted);
		margin: 0 0 0.75rem;
	}
	.table-wrap {
		margin: 0 0 0.5rem;
	}
	caption {
		text-align: left;
		font-size: var(--font-sm);
		color: var(--text-2);
		padding-bottom: 0.25rem;
	}
	@media (max-width: 640px) {
		.field {
			min-width: 0;
			flex: 1 1 100%;
		}
	}
</style>
