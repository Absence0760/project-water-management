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
	//
	// The Draft pattern lists the dam's own unit's irrigation demand and every
	// other unit's that has some (engine ≥ 1.117.0), read with the dam's capacity
	// from the model the job runs on (GET …/yield/options). A unit with no dam
	// there (capacity 0) has no yield of its own: the panel says so, offers no
	// firm yield or preview, and sizes a proposed dam with a storage–yield curve
	// up to a largest capacity the user enters. A dam nothing routes water into
	// (no runoff or upstream share to the dam, no River to dam, no transfer in)
	// yields 0 at any size: the panel says why and offers no yield. A scenario's
	// stored yield worked out on earlier changes says so.
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import { onDestroy, untrack } from 'svelte';
	import { api, type JobMeta, type RunMeta, type YieldOptions, type YieldResult } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { fmtDate, fmtNum, fmtPct } from '#lib/format/number.js';
	import type { PreviewEngine } from '#lib/preview/runner.js';
	import { runInputFor } from '#lib/preview/inputs.js';
	import { ENGINE_VERSION } from '@water-management/engine/version';
	import type { YieldPoint } from '@water-management/engine';
	import {
		ASSURANCE_OPTIONS,
		assuranceLabel,
		curveChart,
		curveRangeText,
		engineDiffersNote,
		HISTORICAL_NOTE,
		jobStatus,
		jobToFollow,
		latestResults,
		yieldWithheld,
		modelRuns,
		noDamText,
		parseMaxCapacity,
		patternChoices,
		patternLabel,
		patternParams,
		noInflowText,
		staleNote,
		startLabel,
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
		hasDam,
		scenarioState = null,
		onsetfield = null
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
		/** The node has a dam (capacity > 0) as the page knows it; the model the job runs on (GET …/yield/options) decides once read. */
		hasDam: boolean;
		/** With scenarioId: its ops hash and last change, so a stored yield worked out on earlier changes says so. */
		scenarioState?: { opsSha256: string; updatedAt: string } | null;
		/** In a scenario the user may change: open its Add a change on this unit's field (no dam: its capacity; no inflow: its runoff to dam). */
		onsetfield?: ((field: 'damCapacityM3' | 'pctRunoffToDam') => void) | null;
	} = $props();

	const runChoices = $derived(modelRuns(runs));
	let runId = $state<string>('');
	$effect(() => {
		// Default to the newest run of the model; keep a choice that still exists.
		const ids = runChoices.map((r) => r.id);
		if (!ids.includes(untrack(() => runId))) runId = ids[0] ?? '';
	});
	const target = $derived(scenarioId ? { scenarioId } : runId ? { runId } : null);
	const targetKey = $derived(scenarioId ? `s:${scenarioId}` : `r:${runId}`);

	/** The Draft pattern choice: 'constant', 'demand' (this unit's) or `unit:<id>` (patternChoices). */
	let pattern = $state('constant');
	let assurance = $state(1);
	/** The storage–yield curve's "Up to" capacity, as typed (parseMaxCapacity). */
	let maxText = $state('');

	// --- what the model the job runs on offers: the dam's capacity and the units that can shape its draft ---
	let options = $state<YieldOptions | null>(null);
	let optionsError = $state<string | null>(null);
	let optionsFor = '';
	async function loadOptions() {
		const t = target;
		const key = `${targetKey}|${nodeId}`;
		optionsFor = key;
		options = null;
		optionsError = null;
		if (!t) return;
		try {
			const o = await api.yield.options(projectId, { ...t, nodeId });
			if (optionsFor === key) options = o;
		} catch (e) {
			if (optionsFor === key) optionsError = msg(e);
		}
	}
	$effect(() => {
		void targetKey;
		void nodeId;
		untrack(loadOptions);
	});
	const choices = $derived(patternChoices(options?.units ?? null, nodeId));
	$effect(() => {
		// A choice the model no longer offers (another run, a unit removed, its own demand gone) falls back to Constant.
		const ok = choices.some((c) => c.value === untrack(() => pattern) && !c.disabled);
		if (!ok) pattern = 'constant';
	});
	/** No dam in the model the job runs on (capacity 0): no yield of its own, a curve only up to an entered capacity. */
	const noDam = $derived(options ? !(options.damCapacityM3 > 0) : !hasDam);
	/** Nothing routes water into the dam (options.inflow): its yield is 0 at any size, so none is offered (the API refuses one). */
	const noInflow = $derived(noInflowText(nodeName, options?.inflow));
	const maxParsed = $derived(parseMaxCapacity(maxText));
	const maxError = $derived('error' in maxParsed ? maxParsed.error : null);
	const maxValue = $derived('value' in maxParsed ? maxParsed.value : undefined);
	const curveBlocked = $derived(maxError !== null || (noDam && maxValue === undefined));

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
			const params = { ...patternParams(pattern), assurance, ...(kind === 'curve' && maxValue !== undefined ? { maxCapacityM3: maxValue } : {}) };
			const res = await api.yield.start(projectId, { ...target, nodeId, kind, params });
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
	let preview = $state<
		{ state: 'computing' } | { state: 'done'; point: YieldPoint; params: ReturnType<typeof patternParams>; assurance: number } | { state: 'error'; message: string } | null
	>(null);
	let engine: PreviewEngine | null = null;
	let previewSeq = 0;

	async function runPreview() {
		const src = source;
		const seq = ++previewSeq;
		engine?.cancel();
		// A unit with no dam, or a dam that receives no water, has no firm yield to preview.
		if (!src || noDam || noInflow) {
			preview = null;
			return;
		}
		preview = { state: 'computing' };
		try {
			const input = await runInputFor(projectId, src.runId, api.uncertainty.runInput);
			if (seq !== previewSeq) return;
			engine ??= (await import('#lib/preview/runner.js')).createPreviewEngine();
			if (seq !== previewSeq) return;
			// A plain copy: the scenario's ops come from reactive state, and a proxy can't be posted to a worker.
			const ops = src.ops ? $state.snapshot(src.ops) : undefined;
			const params = patternParams(pattern);
			const point = await engine.firmYield({ input, ops, nodeId, ...params, assurance, tolerance: PREVIEW_TOLERANCE });
			if (seq === previewSeq) preview = { state: 'done', point, params, assurance };
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
		void noDam;
		void noInflow;
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
		<span class="muted small">How much this dam can supply, drawing steadily through the whole record, starting it half full.</span>
	</div>
	<p class="note small">{HISTORICAL_NOTE}</p>

	{#if !scenarioId}
		{#if runChoices.length === 0}
			<p class="muted">Run the model first: a yield is worked out on a saved run's inputs.</p>
		{:else}
			<div class="field">
				<label for="yield-run-{nodeId}">Run</label>
				<select id="yield-run-{nodeId}" bind:value={runId} disabled={busy}>
					{#each runChoices as r (r.id)}
						<option value={r.id}>{r.label || 'Unlabelled run'} · {fmtDate(r.createdAt, true)}</option>
					{/each}
				</select>
			</div>
		{/if}
	{/if}

	{#if target && noDam}
		<div class="alert alert-info no-dam" role="note" data-testid="yield-no-dam">
			<p>{noDamText(nodeName)}</p>
			{#if canEdit && !noInflow}<p>To size a proposed dam, draw a storage–yield curve up to the largest capacity you would consider.</p>{/if}
			{#if onsetfield && canEdit}<button type="button" class="btn btn-sm" onclick={() => onsetfield('damCapacityM3')}>Set its dam capacity in this scenario</button>{/if}
		</div>
	{/if}
	{#if target && noInflow}
		<div class="alert alert-warning no-dam" role="note" data-testid="yield-no-inflow">
			<p>{noInflow}</p>
			{#if onsetfield && canEdit}<button type="button" class="btn btn-sm" onclick={() => onsetfield('pctRunoffToDam')}>Set its runoff to dam in this scenario</button>{/if}
		</div>
	{/if}
	{#if optionsError}<p class="muted small" data-testid="yield-options-error">The units that could shape the draft couldn't be read ({optionsError.replace(/\.$/, '')}), so the pattern list is the dam's own.</p>{/if}

	{#if target && (canEdit || source)}
		<div class="controls">
			<div class="field">
				<label for="yield-pattern-{nodeId}">Draft pattern <HelpTip key="draft-pattern" label="About how the draft is spread over the year" /></label>
				<select id="yield-pattern-{nodeId}" bind:value={pattern} disabled={busy}>
					{#each choices as c (c.value)}
						<option value={c.value} disabled={c.disabled}>{c.label}</option>
					{/each}
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
			{#if canEdit}
				<div class="field">
					<label for="yield-max-{nodeId}">Curve up to (m³)</label>
					<input
						id="yield-max-{nodeId}"
						type="text"
						inputmode="decimal"
						autocomplete="off"
						bind:value={maxText}
						disabled={busy}
						placeholder={noDam ? 'Required' : options ? `${fmtNum(2 * options.damCapacityM3)} (twice the dam)` : 'Twice the dam'}
						aria-required={noDam}
						aria-invalid={maxError !== null}
						aria-describedby="yield-max-hint-{nodeId}"
					/>
					<span class="hint small" class:failed={maxError !== null} id="yield-max-hint-{nodeId}" data-testid="yield-max-hint"
						>{maxError ?? (noDam ? 'Required to size a proposed dam: the largest capacity to try.' : "Empty: twice the dam's capacity.")}</span
					>
				</div>
				<div class="buttons">
					{#if !noDam}<button type="button" class="btn btn-primary" disabled={busy || !!noInflow} onclick={() => start('firm')}>Work out the yield</button>{/if}
					<button type="button" class="btn" class:btn-primary={noDam} disabled={busy || curveBlocked || !!noInflow} onclick={() => start('curve')}>Storage–yield curve</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if source && !noDam && !noInflow}
		<div class="preview" data-testid="yield-preview" data-state={preview?.state ?? 'computing'}>
			<h3>Preview <span class="badge">Not stored</span></h3>
			<div aria-live="polite">
				{#if preview?.state === 'done'}
					{@const p = preview.point}
					<p data-testid="yield-preview-value">
						<strong>{fmtNum(p.yieldM3Day)} m³/day</strong> ({fmtNum(p.yieldM3Year)} m³ a year): historical {assuranceLabel(preview.assurance)} yield, {patternLabel(preview.params, options?.units ?? null)},
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
		<p class="muted" data-loading>Loading results…</p>
	{:else if loadError}
		<div class="alert alert-error" role="alert">
			{loadError}
			<!-- The loading line takes its place: the focus follows (followRetry). -->
			<button
				type="button"
				class="btn btn-sm"
				data-retry
				onclick={(e) => {
					followRetry(e.currentTarget);
					load();
				}}>Try again</button
			>
		</div>
	{:else if !latest.firm && !latest.curve}
		{#if target}<p class="muted" data-testid="yield-empty">No yield worked out for this dam on this {scenarioId ? 'scenario' : 'run'} yet.</p>{/if}
	{:else}
		{#if yieldWithheld(results)}
			<!-- A yield on a cap or full-allocation run, for a viewer kept from each registered volume (#523 I), or a scenario's from before 221 (G1c). -->
			<p class="alert alert-info" role="note" data-testid="yield-withheld">
				A yield worked out on a run that caps use at, or scales demand to, the registered water volumes is withheld, as is a scenario's yield from
				before the app recorded that: this project shows those volumes to its editors and owners only.
			</p>
		{/if}
		{#if latest.firm}
			{@const p = latest.firm.points.point}
			{@const stale = staleNote(latest.firm, scenarioState)}
			{#if stale}<p class="alert alert-warning small" data-testid="yield-firm-stale">{stale}</p>{/if}
			<dl class="firm" data-testid="yield-firm">
				<div>
					<dt>Historical {assuranceLabel(latest.firm.params.assurance)} yield</dt>
					<dd><strong>{fmtNum(p.yieldM3Day)} m³/day</strong> ({fmtNum(p.yieldM3Year)} m³ a year)</dd>
				</div>
				<div><dt>Dam capacity</dt><dd>{fmtNum(p.capacityM3)} m³</dd></div>
				<div><dt>Pattern</dt><dd data-testid="yield-firm-pattern">{patternLabel(latest.firm.params, options?.units ?? null)}</dd></div>
				<div><dt>Dam at the start</dt><dd data-testid="yield-firm-start">{startLabel(latest.firm.engineVersion)}</dd></div>
				<div><dt>Failures at that draft</dt><dd>{p.failureDays} days, in {p.failedYears} water years</dd></div>
				<div><dt>Worked out</dt><dd>{fmtDate(latest.firm.createdAt, true)} by {latest.firm.createdBy ?? 'a former member'} (engine {latest.firm.engineVersion})</dd></div>
			</dl>
		{/if}
		{#if latest.curve && chart}
			{@const c = latest.curve}
			{@const stale = staleNote(c, scenarioState)}
			<h3>Storage–yield curve <HelpTip key="storage-yield-curve" label="About the curve of yield against capacity" /></h3>
			<p class="muted small">
				<span data-testid="yield-curve-range">{assuranceLabel(c.params.assurance)} yield, {patternLabel(c.params, options?.units ?? null)}, {curveRangeText(c)}.</span>
				Each dam starts the record <span data-testid="yield-curve-start">{startLabel(c.engineVersion)}</span>. Worked out {fmtDate(c.createdAt, true)}.
			</p>
			{#if stale}<p class="alert alert-warning small" data-testid="yield-curve-stale">{stale}</p>{/if}
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
							{@const own = c.points.baseCapacityM3 > 0 && p.capacityM3 === c.points.baseCapacityM3}
							<tr class:own>
								<th scope="row" class="num">{fmtNum(p.capacityM3)}{own ? ' (this dam)' : ''}</th>
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
	.no-dam p {
		margin: 0 0 0.35rem;
	}
	.hint.failed {
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
