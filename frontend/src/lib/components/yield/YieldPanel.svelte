<script lang="ts">
	// Yield of one dam (WP-3.6, docs/ui.md § Yield): pick a pattern and an
	// assurance, queue a firm yield or a storage–yield curve as a background
	// job, follow it (queued, running with a %, done, failed, cancel), and show
	// the stored results as a table and a uPlot curve. On a saved run of the
	// model (the Network tab) or on a scenario. Viewers see results but have
	// no run buttons. On open it picks up a job for this dam that is already
	// pending (another tab, a reload, a colleague) and follows it.
	//
	// It also shows an instant preview of the firm yield, worked out in this
	// browser by the preview worker (lib/preview, WP-1.17) on the same input
	// the job would use, for the pattern and assurance picked. The preview is
	// never stored: the job's result, below it, is the one the project keeps.
	// The preview runs this web build's engine (ENGINE_VERSION, the worker is
	// part of the same build) and names it, with a note when the stored
	// result came from another engine (the backend is released separately).
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { api, type JobMeta, type RunMeta, type YieldResult } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtDate, fmtNum, fmtPct } from '$lib/format/number';
	import type { PreviewEngine } from '$lib/preview/runner';
	import { runInputFor } from '$lib/preview/inputs';
	import { ENGINE_VERSION } from '@water-management/engine/version';
	import type { YieldPoint } from '@water-management/engine';
	import {
		ASSURANCE_OPTIONS,
		assuranceLabel,
		curveChart,
		engineDiffersNote,
		HISTORICAL_NOTE,
		jobStatus,
		jobToFollow,
		latestResults,
		modelRuns,
		patternLabel,
		PREVIEW_TOLERANCE,
		previewSource,
		type PreviewScenario
	} from './yield';

	let {
		projectId,
		nodeId,
		nodeName,
		runs = null,
		scenarioId = null,
		scenario = null,
		canEdit,
		hasDam
	}: {
		projectId: string;
		nodeId: string;
		nodeName: string;
		/** The project's runs, newest first: the yield runs on one of the model's own (not with scenarioId). */
		runs?: RunMeta[] | null;
		/** Run on this scenario instead of a saved run. */
		scenarioId?: string | null;
		/** With scenarioId: its base run and ops, so the browser can preview it (not given for an application). */
		scenario?: PreviewScenario | null;
		canEdit: boolean;
		/** The node has a dam (capacity > 0): a curve needs one. */
		hasDam: boolean;
	} = $props();

	const choices = $derived(modelRuns(runs));
	let runId = $state<string>('');
	$effect(() => {
		// Default to the newest run of the model; keep a choice that still exists.
		const ids = choices.map((r) => r.id);
		if (!ids.includes(untrack(() => runId))) runId = ids[0] ?? '';
	});
	const target = $derived(scenarioId ? { scenarioId } : runId ? { runId } : null);
	const targetKey = $derived(scenarioId ? `s:${scenarioId}` : `r:${runId}`);

	let pattern = $state<'constant' | 'demand'>('constant');
	let assurance = $state(1);

	let results = $state<YieldResult[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let job = $state<JobMeta | null>(null);
	let submitError = $state<string | null>(null);
	let submitting = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let loadFor = '';

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		const t = target;
		const key = `${targetKey}|${nodeId}`;
		loadFor = key;
		if (!t) {
			results = [];
			return;
		}
		loading = true;
		loadError = null;
		try {
			const [r, pending] = await Promise.all([api.yield.list(projectId, { ...t, nodeId }), api.yield.jobs(projectId, { ...t, nodeId })]);
			if (loadFor !== key) return;
			results = r;
			// Follow a job started elsewhere, unless this panel already follows one of its own.
			const found = jobToFollow(pending);
			if (found && found.id !== job?.id && !jobStatus(job)?.busy) {
				job = found;
				clearTimeout(timer);
				if (jobStatus(found)?.busy) timer = setTimeout(() => poll(found.id), 1500);
			}
		} catch (e) {
			if (loadFor === key) loadError = msg(e);
		} finally {
			if (loadFor === key) loading = false;
		}
	}

	$effect(() => {
		void targetKey;
		void nodeId;
		untrack(load);
	});

	// Follow the job on WP-2.8's status list until it stops.
	async function poll(id: string) {
		clearTimeout(timer);
		try {
			const found = (await api.jobs.list(projectId, { limit: 50 })).find((j) => j.id === id) ?? null;
			if (job?.id !== id) return;
			job = found;
			if (found?.status === 'done') {
				await load();
				return;
			}
			if (found && (found.status === 'queued' || found.status === 'running')) timer = setTimeout(() => poll(id), 1500);
		} catch (e) {
			submitError = msg(e);
		}
	}

	async function start(kind: 'firm' | 'curve') {
		if (!target) return;
		submitting = true;
		submitError = null;
		try {
			const res = await api.yield.start(projectId, { ...target, nodeId, kind, params: { pattern, assurance } });
			job = res.job;
			await poll(res.jobId);
		} catch (e) {
			submitError = msg(e);
		} finally {
			submitting = false;
		}
	}

	async function cancel() {
		if (!job) return;
		const id = job.id;
		try {
			await api.yield.cancel(projectId, id);
			await poll(id);
		} catch (e) {
			submitError = msg(e);
		}
	}

	// --- the in-browser preview (never stored) ------------------------------
	const source = $derived(previewSource(scenarioId, runId, scenario));
	// A string, so a parent passing an equal scenario object again doesn't start a new preview.
	const sourceKey = $derived(source?.key ?? '');
	let preview = $state<{ state: 'computing' } | { state: 'done'; point: YieldPoint; pattern: typeof pattern; assurance: number } | { state: 'error'; message: string } | null>(null);
	let engine: PreviewEngine | null = null;
	let previewSeq = 0;

	async function runPreview() {
		const src = source;
		const seq = ++previewSeq;
		engine?.cancel();
		if (!src) {
			preview = null;
			return;
		}
		preview = { state: 'computing' };
		try {
			const input = await runInputFor(projectId, src.runId, api.uncertainty.runInput);
			if (seq !== previewSeq) return;
			engine ??= (await import('$lib/preview/runner')).createPreviewEngine();
			if (seq !== previewSeq) return;
			// A plain copy: the scenario's ops come from reactive state, and a proxy can't be posted to a worker.
			const ops = src.ops ? $state.snapshot(src.ops) : undefined;
			const asked = { pattern, assurance };
			const point = await engine.firmYield({ input, ops, nodeId, ...asked, tolerance: PREVIEW_TOLERANCE });
			if (seq === previewSeq) preview = { state: 'done', point, ...asked };
		} catch (e) {
			// A newer preview replaced this one: not an error.
			if (seq !== previewSeq || (e instanceof Error && e.name === 'PreviewSuperseded')) return;
			preview = { state: 'error', message: msg(e) };
		}
	}

	$effect(() => {
		void sourceKey;
		void nodeId;
		void pattern;
		void assurance;
		untrack(runPreview);
	});

	onDestroy(() => {
		clearTimeout(timer);
		previewSeq++;
		engine?.close();
	});

	const status = $derived(jobStatus(job));
	const latest = $derived(latestResults(results));
	const chart = $derived(latest.curve ? curveChart(latest.curve) : null);
	const busy = $derived(submitting || !!status?.busy);
	const engineNote = $derived(engineDiffersNote(ENGINE_VERSION, latest.firm));
</script>

<section class="panel yield" aria-labelledby="yield-h-{nodeId}-t" data-testid="yield-panel">
	<div class="panel-head">
		<h2 id="yield-h-{nodeId}"><span id="yield-h-{nodeId}-t">Yield of {nodeName || 'this dam'}</span> <HelpTip key="firm-yield" /></h2>
		<span class="muted small">How much this dam can supply, drawing steadily through the whole record.</span>
	</div>
	<p class="note small">{HISTORICAL_NOTE}</p>

	{#if !scenarioId}
		{#if choices.length === 0}
			<p class="muted">Run the model first: a yield is worked out on a saved run's inputs.</p>
		{:else}
			<div class="field">
				<label for="yield-run-{nodeId}">Run</label>
				<select id="yield-run-{nodeId}" bind:value={runId} disabled={busy}>
					{#each choices as r (r.id)}
						<option value={r.id}>{r.label || 'Unlabelled run'} · {fmtDate(r.createdAt, true)}</option>
					{/each}
				</select>
			</div>
		{/if}
	{/if}

	{#if target && (canEdit || source)}
		<div class="controls">
			<div class="field">
				<label for="yield-pattern-{nodeId}">Draft pattern <HelpTip key="draft-pattern" label="About how the draft is spread over the year" /></label>
				<select id="yield-pattern-{nodeId}" bind:value={pattern} disabled={busy}>
					<option value="constant">Constant: the same every day</option>
					<option value="demand">This hydrological unit's irrigation demand, by month</option>
				</select>
			</div>
			<div class="field">
				<label for="yield-assurance-{nodeId}">Assurance <HelpTip key="yield-assurance" /></label>
				<select id="yield-assurance-{nodeId}" bind:value={assurance} disabled={busy}>
					{#each ASSURANCE_OPTIONS as o (o.value)}
						<option value={o.value}>{o.label}</option>
					{/each}
				</select>
			</div>
			{#if canEdit}<div class="buttons">
				<button type="button" class="btn btn-primary" disabled={busy} onclick={() => start('firm')}>Work out the yield</button>
				<button
					type="button"
					class="btn"
					disabled={busy || !hasDam}
					title={hasDam ? undefined : 'A storage–yield curve needs a dam with a capacity above 0'}
					onclick={() => start('curve')}>Storage–yield curve</button
				>
			</div>{/if}
		</div>
	{/if}

	{#if source}
		<div class="preview" data-testid="yield-preview" data-state={preview?.state ?? 'computing'}>
			<h3>Preview <span class="badge">Not stored</span></h3>
			<div aria-live="polite">
				{#if preview?.state === 'done'}
					{@const p = preview.point}
					<p data-testid="yield-preview-value">
						<strong>{fmtNum(p.yieldM3Day)} m³/day</strong> ({fmtNum(p.yieldM3Year)} m³ a year): historical {assuranceLabel(preview.assurance)} yield, {patternLabel(preview.pattern)},
						with {p.failureDays} failure days in {p.failedYears} water years at that draft.
					</p>
				{:else if preview?.state === 'error'}
					<p class="failed" data-testid="yield-preview-error">The preview couldn't be worked out: {preview.message.replace(/\.$/, '')}.</p>
				{:else}
					<p class="muted">Working it out in your browser…</p>
				{/if}
			</div>
			<p class="muted small">
				Worked out in this browser, on <span data-testid="yield-preview-engine">engine {ENGINE_VERSION}</span>, on the same inputs the stored calculation uses, for the pattern and assurance above. It is not saved{canEdit
					? ': Work out the yield stores it for everyone.'
					: '.'}
			</p>
			{#if engineNote}
				<p class="note small" data-testid="yield-engine-differs">{engineNote}</p>
			{/if}
		</div>
	{/if}

	<div class="status" role="status" aria-live="polite">
		{#if status}
			<span class:failed={status.failed} data-testid="yield-status">{status.text}</span>
			{#if status.busy && canEdit}
				<button type="button" class="btn btn-sm" onclick={cancel}>Cancel</button>
			{/if}
			{#if status.busy && job?.status === 'running' && job.progress != null}
				<progress max="100" value={job.progress} aria-label="Yield calculation progress">{job.progress} %</progress>
			{/if}
		{/if}
	</div>
	{#if submitError}<div class="alert alert-error" role="alert">{submitError}</div>{/if}

	{#if loading}
		<p class="muted">Loading results…</p>
	{:else if loadError}
		<div class="alert alert-error" role="alert">{loadError} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></div>
	{:else if !latest.firm && !latest.curve}
		{#if target}<p class="muted" data-testid="yield-empty">No yield worked out for this dam on this {scenarioId ? 'scenario' : 'run'} yet.</p>{/if}
	{:else}
		{#if latest.firm}
			{@const p = latest.firm.points.point}
			<dl class="firm" data-testid="yield-firm">
				<div>
					<dt>Historical {assuranceLabel(latest.firm.params.assurance)} yield</dt>
					<dd><strong>{fmtNum(p.yieldM3Day)} m³/day</strong> ({fmtNum(p.yieldM3Year)} m³ a year)</dd>
				</div>
				<div><dt>Dam capacity</dt><dd>{fmtNum(p.capacityM3)} m³</dd></div>
				<div><dt>Pattern</dt><dd>{patternLabel(latest.firm.params.pattern)}</dd></div>
				<div><dt>Failures at that draft</dt><dd>{p.failureDays} days, in {p.failedYears} water years</dd></div>
				<div><dt>Worked out</dt><dd>{fmtDate(latest.firm.createdAt, true)} by {latest.firm.createdBy ?? 'a former member'} (engine {latest.firm.engineVersion})</dd></div>
			</dl>
		{/if}
		{#if latest.curve && chart}
			{@const c = latest.curve}
			<h3>Storage–yield curve <HelpTip key="storage-yield-curve" label="About the curve of yield against capacity" /></h3>
			<p class="muted small">
				{assuranceLabel(c.params.assurance)} yield, {patternLabel(c.params.pattern)}, at {c.points.points.length} capacities from 0 to twice the dam's {fmtNum(c.points.baseCapacityM3)} m³.
				Worked out {fmtDate(c.createdAt, true)}.
			</p>
			{#if !c.points.monotone}
				<p class="alert alert-warning small" data-testid="yield-not-monotone">
					The yield falls somewhere as the dam gets bigger. That can be real (a bigger, shallower dam loses more to evaporation, or starts further below its minimum operating level), not a fault in the search.
				</p>
			{/if}
			<LineChart title="Storage–yield curve" height={260} series={chart.series} xy={chart.xy} xLabel="Dam capacity (thousand m³)" unit="m³/day" pannable={false} />
			<div class="table-wrap">
				<table class="data compact" data-testid="yield-curve-table">
					<caption class="visually-hidden">Yield at each dam capacity</caption>
					<thead>
						<tr>
							<th scope="col">Capacity (m³)</th>
							<th scope="col" class="num">Yield (m³/day)</th>
							<th scope="col" class="num">Yield (m³/year)</th>
							<th scope="col" class="num">Failed water years</th>
						</tr>
					</thead>
					<tbody>
						{#each c.points.points as p (p.capacityM3)}
							<tr class:own={p.capacityM3 === c.points.baseCapacityM3}>
								<th scope="row" class="num">{fmtNum(p.capacityM3)}{p.capacityM3 === c.points.baseCapacityM3 ? ' (this dam)' : ''}</th>
								<td class="num">{fmtNum(p.yieldM3Day)}</td>
								<td class="num">{fmtNum(p.yieldM3Year)}</td>
								<td class="num">{p.failedYears}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted small">Assurance {fmtPct(c.params.assurance, 0)}; each yield found to within {fmtPct(c.params.tolerance, 1)}.</p>
		{/if}
	{/if}
</section>

<style>
	.yield .note {
		margin: 0 0 0.75rem;
		color: var(--text-muted);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: end;
		margin: 0.5rem 0;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.5rem;
		margin: 0.5rem 0;
	}
	.status .failed,
	.preview .failed {
		color: var(--danger);
	}
	.preview {
		margin: 0.75rem 0;
		padding: 0.5rem 0.75rem;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
	}
	.preview h3 {
		margin: 0 0 0.25rem;
		font-size: 1rem;
	}
	.preview p {
		margin: 0.25rem 0;
	}
	.firm {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.5rem 1rem;
		margin: 0.75rem 0;
	}
	.firm dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.firm dd {
		margin: 0;
	}
	tr.own th,
	tr.own td {
		font-weight: 600;
	}
</style>
