<!--
	A run's uncertainty bands (issue #4 phase 9, docs/ui.md § Uncertainty bands,
	docs/model.md §2.10e). Its own chunk: RunsTab loads it lazily.

	Shows the run's newest stored ensemble: the decision rule next to the
	bands, how many parameter sets passed, the held-out coverage, and 5–95 %
	bands on EWR days not met (total and by month), the shortfall, the MARs,
	Reserve compliance, curtailment per farm, annual volumes and the monthly
	flow-duration curves against the EWR. Every ensemble ever started for the
	run is listed with what differs in its rule. An editor starts a new one
	(the server resolves the options and the database draws the seed, then the
	calibration worker runs it and the server checks it before storing);
	anyone can re-run a stored one in their browser to reproduce it.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		ENSEMBLE_DEFAULTS,
		ENSEMBLE_MEMBERS_MAX,
		ENSEMBLE_MEMBERS_MIN,
		RAIN_SOURCE_LABELS,
		RECORD_LABELS,
		valueDiffs,
		type EnsembleProgress,
		type EnsembleResult,
		type EnsembleSummary,
		type Wr2012FlagLevel
	} from '@water-management/engine';
	import { api, type Ensemble, type EnsembleDetail } from '$lib/api';
	import { FitCancelled, startEnsemble, type EnsembleHandle } from '$lib/calibration/runner';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import BandFdcChart from './BandFdcChart.svelte';
	import { abandonedText, bandCells, coverageText, historyRows, pct, rejectedText, shownEnsemble, sig } from './bands';
	import { FORMER_MEMBER } from '$lib/format/maker';

	let {
		projectId,
		runId,
		runEngineVersion,
		canEdit
	}: { projectId: string; runId: string; runEngineVersion: string; canEdit: boolean } = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let list = $state<Ensemble[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	async function load() {
		loadError = null;
		try {
			list = await api.uncertainty.list(projectId, runId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void runId;
		loading = true;
		load();
	});

	const shown = $derived(shownEnsemble(list));
	const summary = $derived((shown?.summary ?? null) as EnsembleSummary | null);
	const history = $derived(historyRows(list, shown));
	const abandoned = $derived(abandonedText(list));

	// --- the form ------------------------------------------------------------
	let members = $state(ENSEMBLE_DEFAULTS.members);
	let bounds = $state<'' | 'typical' | 'wide'>('');
	let minSkill = $state(ENSEMBLE_DEFAULTS.thresholds.minSkill);
	let lowFlowOn = $state(true);
	let maxLowFlow = $state(ENSEMBLE_DEFAULTS.thresholds.maxLowFlowBiasPct ?? 50);
	let wr2012Level = $state<Wr2012FlagLevel>(ENSEMBLE_DEFAULTS.thresholds.wr2012MaxLevel);
	let panOffset = $state(ENSEMBLE_DEFAULTS.panOffset);

	type Phase = 'idle' | 'starting' | 'running' | 'storing' | 'reproducing';
	let phase = $state<Phase>('idle');
	let progress = $state<EnsembleProgress | null>(null);
	let actionError = $state<string | null>(null);
	let startNotes = $state<string[]>([]);
	let handle: EnsembleHandle<EnsembleResult> | null = null;
	onDestroy(() => handle?.cancel());

	async function run(e: SubmitEvent) {
		e.preventDefault();
		actionError = null;
		startNotes = [];
		phase = 'starting';
		try {
			const { ensemble, notes } = await api.uncertainty.start(projectId, runId, {
				request: {
					members,
					...(bounds ? { bounds } : {}),
					panOffset,
					thresholds: { minSkill, maxLowFlowBiasPct: lowFlowOn ? maxLowFlow : null, wr2012MaxLevel: wr2012Level }
				}
			});
			startNotes = notes;
			list = [ensemble, ...list];
			const input = await api.uncertainty.runInput(projectId, runId);
			phase = 'running';
			progress = { done: 0, total: ensemble.members + 1, accepted: 0 };
			handle = startEnsemble({ kind: 'ensemble', input, options: ensemble.options }, (p) => (progress = p));
			const result = await handle.result;
			handle = null;
			phase = 'storing';
			await api.uncertainty.complete(projectId, runId, ensemble.id, { members: result.members, coverage: result.coverage });
			await load();
		} catch (err) {
			if (!(err instanceof FitCancelled)) actionError = msg(err);
			await load();
		} finally {
			phase = 'idle';
			progress = null;
			handle = null;
		}
	}

	function cancel() {
		handle?.cancel();
	}

	// --- reproduce ---------------------------------------------------------------
	let reproduced = $state<{ id: string; ok: boolean; lines: string[] } | null>(null);
	async function reproduce() {
		if (!shown) return;
		actionError = null;
		reproduced = null;
		phase = 'reproducing';
		try {
			const [detail, input] = await Promise.all([api.uncertainty.get(projectId, runId, shown.id), api.uncertainty.runInput(projectId, runId)]);
			const stored = detail.result as Extract<EnsembleDetail['result'], { coverage: unknown }>;
			progress = { done: 0, total: shown.members + 1, accepted: 0 };
			// The list is reactive state: post the worker a plain copy (a proxy can't be cloned).
			handle = startEnsemble({ kind: 'ensemble', input, options: $state.snapshot(shown.options) }, (p) => (progress = p));
			const r = await handle.result;
			const lines = [...valueDiffs('members', r.members, stored.members), ...valueDiffs('coverage', r.coverage, stored.coverage)];
			reproduced = { id: shown.id, ok: lines.length === 0, lines };
		} catch (err) {
			if (!(err instanceof FitCancelled)) actionError = msg(err);
		} finally {
			phase = 'idle';
			progress = null;
			handle = null;
		}
	}

	const busy = $derived(phase !== 'idle');
	const engineNote = $derived(
		shown && shown.engineVersion !== runEngineVersion
			? `This run was made by engine ${runEngineVersion}; the ensemble ran on engine ${shown.engineVersion}, so member 0 may differ slightly from the run's own figures.`
			: null
	);
	const optionLine = (e: Ensemble) =>
		[
			`${fmtNum(e.members)} sampled sets + the run's own`,
			`seed ${e.seed}`,
			`${e.options.bounds} bounds`,
			e.options.panOffset > 0 ? `pan coefficient ±${e.options.panOffset}` : 'pan coefficient not varied',
			`rain: ${e.options.rainSources.map((r) => RAIN_SOURCE_LABELS[r]).join(' / ')}`,
			`judged on: ${e.options.records.map((r) => RECORD_LABELS[r]).join(' / ')}`
		].join(' · ');
</script>

<section aria-labelledby="{uid}-h" data-testid="uncertainty-panel">
	<h3 id="{uid}-h">Uncertainty bands <HelpTip key="uncertainty-bands" /></h3>
	<p class="muted small">
		How far this run's results move across every parameter set, pan coefficient, rain source and observed record the data can't rule out: a behavioural
		ensemble (GLUE), one runoff model at a time.
	</p>

	{#if loading}
		<p class="muted" role="status">Loading…</p>
	{:else if loadError}
		<div class="alert alert-error" role="alert">{loadError} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></div>
	{:else if summary && shown}
		<p class="rule" data-testid="decision-rule"><strong>Decision rule.</strong> {summary.decisionRule}</p>
		<p class="muted small">{optionLine(shown)} · {shown.runoffModel} · stored {shown.completedAt?.slice(0, 16).replace('T', ' ')} by {shown.createdBy ?? FORMER_MEMBER}</p>
		{#if engineNote}<p class="alert alert-info small">{engineNote}</p>{/if}

		<dl class="stats">
			<div class="stat">
				<dt>Parameter sets kept</dt>
				<dd data-testid="kept">{fmtNum(summary.accepted)} of {fmtNum(summary.total)}</dd>
				<dd class="sub">Rejected: {rejectedText(summary.rejected)}</dd>
			</div>
			<div class="stat">
				<dt>This run's own parameters</dt>
				<dd>{summary.referenceAccepted ? 'Pass the rule' : 'Fail the rule'}</dd>
			</div>
		</dl>
		{#each summary.coverage as c (c.record)}
			<p class={c.warning ? 'alert alert-warning' : 'small'} role={c.warning ? 'alert' : undefined} data-testid="coverage">
				{coverageText(c, shown.options.minMembers)}{#if c.warning}{' '}Below {pct(shown.options.coverageWarning)}: the band is too narrow to trust.{/if}
			</p>
		{/each}
		{#each summary.notes.filter((n) => !/held-out/.test(n)) as n (n)}<p class="alert alert-warning small">{n}</p>{/each}

		{#if !summary.gated}
			{@const b = summary.bands}
			{@const ref = summary.reference}
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-head">
					<caption id="{uid}-head">5–95 % bands of the kept parameter sets (this run's own value beside them)</caption>
					<thead>
						<tr>
							<th scope="col">Result</th>
							<th scope="col" class="num">5 %</th>
							<th scope="col" class="num">Median</th>
							<th scope="col" class="num">95 %</th>
							<th scope="col" class="num">This run</th>
						</tr>
					</thead>
					<tbody>
						<tr data-testid="band-ewr-days">
							<th scope="row">EWR days not met at the outlet</th>
							{#each bandCells(b.ewrDaysNotMet, (v) => fmtNum(v)) as c, i (i)}<td class="num">{c}</td>{/each}
							<td class="num">{ref ? fmtNum(ref.ewrDaysNotMet) : '–'}</td>
						</tr>
						<tr>
							<th scope="row">Shortfall against the EWR <span class="u">Mm³</span></th>
							{#each bandCells(b.shortfallMm3) as c, i (i)}<td class="num">{c}</td>{/each}
							<td class="num">{sig(ref?.shortfallMm3)}</td>
						</tr>
						<tr>
							<th scope="row">Natural MAR <span class="u">Mm³/a</span></th>
							{#each bandCells(b.marNaturalMm3) as c, i (i)}<td class="num">{c}</td>{/each}
							<td class="num">{sig(ref?.marNaturalMm3)}</td>
						</tr>
						<tr>
							<th scope="row">Outflow MAR <span class="u">Mm³/a</span></th>
							{#each bandCells(b.marOutflowMm3) as c, i (i)}<td class="num">{c}</td>{/each}
							<td class="num">{sig(ref?.marOutflowMm3)}</td>
						</tr>
						{#each b.reserve as s (s.key)}
							<tr>
								<th scope="row">Reserve compliance, {s.name} <span class="u">months met</span></th>
								{#each bandCells(s.band, (v) => pct(v)) as c, i (i)}<td class="num">{c}</td>{/each}
								<td class="num">{pct(ref?.reserveRate[s.key])}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-month">
					<caption id="{uid}-month">EWR days not met at the outlet by month, summed over the run's years</caption>
					<thead>
						<tr>
							<th scope="col">Band</th>
							{#each b.ewrDaysNotMetByMonth as _, i (i)}<th scope="col" class="num">{monthName(((i + 9) % 12) + 1)}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each ['5 %', 'Median', '95 %'] as label, k (label)}
							<tr>
								<th scope="row">{label}</th>
								{#each b.ewrDaysNotMetByMonth as m, i (i)}<td class="num">{bandCells(m, (v) => fmtNum(v))[k]}</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if b.curtailment.length}
				<div class="table-wrap">
					<table class="data compact" aria-labelledby="{uid}-farm">
						<caption id="{uid}-farm">Curtailment per hydrological unit: total change in supply over the reporting window, m³/day (negative = cut)</caption>
						<thead>
							<tr>
								<th scope="col">Hydrological unit</th>
								<th scope="col" class="num">5 %</th>
								<th scope="col" class="num">Median</th>
								<th scope="col" class="num">95 %</th>
								<th scope="col" class="num">This run</th>
							</tr>
						</thead>
						<tbody>
							{#each b.curtailment as f (f.nodeId)}
								<tr>
									<th scope="row">{f.name}</th>
									{#each bandCells(f.band) as c, i (i)}<td class="num">{c}</td>{/each}
									<td class="num">{sig(ref?.curtailmentM3Day[f.nodeId])}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			<details>
				<summary>Annual volumes by water year</summary>
				<div class="table-wrap">
					<table class="data compact" aria-labelledby="{uid}-year">
						<caption id="{uid}-year">Natural flow and simulated outflow per water year, Mm³ (5 % – 95 %, median)</caption>
						<thead>
							<tr>
								<th scope="col">Water year</th>
								<th scope="col" class="num">Natural 5–95 %</th>
								<th scope="col" class="num">Natural median</th>
								<th scope="col" class="num">Outflow 5–95 %</th>
								<th scope="col" class="num">Outflow median</th>
							</tr>
						</thead>
						<tbody>
							{#each b.annual as y (y.waterYear)}
								<tr>
									<th scope="row">{y.waterYear}/{String((y.waterYear + 1) % 100).padStart(2, '0')}{#if y.days < 365} <span class="u">({y.days} days)</span>{/if}</th>
									<td class="num">{bandCells(y.natural)[0]} – {bandCells(y.natural)[2]}</td>
									<td class="num">{bandCells(y.natural)[1]}</td>
									<td class="num">{bandCells(y.outflow)[0]} – {bandCells(y.outflow)[2]}</td>
									<td class="num">{bandCells(y.outflow)[1]}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>

			<h4>Monthly flow-duration curves against the EWR</h4>
			<BandFdcChart fdc={b.fdc} points={b.fdcPoints} />
		{/if}

		<div class="actions">
			<button type="button" class="btn btn-sm" onclick={reproduce} disabled={busy}>Reproduce in this browser</button>
			{#if reproduced && reproduced.id === shown.id}
				<span class={reproduced.ok ? 'ok' : 'bad'} role="status" data-testid="reproduced">
					{reproduced.ok
						? `Reproduced: the same ${fmtNum(shown.members + 1)} members, verdicts, outputs and coverage.`
						: `Does not reproduce: ${reproduced.lines.slice(0, 3).join('; ')}`}
				</span>
			{/if}
		</div>
	{:else}
		<p class="empty">No uncertainty ensemble has been stored for this run.{canEdit ? '' : ' An editor can run one.'}</p>
	{/if}

	{#if !loading && !loadError}
		{#if abandoned}<p class="muted small" data-testid="abandoned">{abandoned}</p>{/if}
		{#if history.length > 1}
			<details class="history">
				<summary>Every ensemble of this run ({history.length})</summary>
				<ul>
					{#each history as h (h.id)}
						<li>
							<strong>{h.when}</strong> · {h.by} · {h.status} · seed {h.seed} · {fmtNum(h.members)} sets{#if h.accepted !== null} · {fmtNum(h.accepted)} kept{/if}
							{#if h.shown}<span class="badge">shown</span>{:else if h.changes.length}
								<ul class="changes">
									{#each h.changes as c (c.label)}<li>{c.label}: {c.b} (shown: {c.a})</li>{/each}
								</ul>
							{:else if shown}<span class="muted"> · same rule as the shown one</span>{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}

	{#if canEdit}
		<details class="run" open={!summary}>
			<summary>Run an ensemble</summary>
			<form onsubmit={run} aria-busy={busy}>
				<p class="muted small">
					The server fixes the rule and draws the seed before anything runs, and keeps every ensemble started, so a band can't be chosen after the fact.
					The browser then runs every member (a few hundred model runs; keep this tab open) and the server re-checks it before storing.
				</p>
				<!-- Aligned at the top, so the labels and boxes line up and the low-flow checkbox hangs under its box. -->
				<div class="form-row ensemble-row">
					<div class="field">
						<label for="{uid}-n">Parameter sets</label>
						<input id="{uid}-n" type="number" min={ENSEMBLE_MEMBERS_MIN} max={ENSEMBLE_MEMBERS_MAX} step="1" bind:value={members} disabled={busy} />
					</div>
					<div class="field">
						<label for="{uid}-b">Bounds</label>
						<select id="{uid}-b" bind:value={bounds} disabled={busy}>
							<option value="">The fit's (typical without one)</option>
							<option value="typical">Typical (Perrin et al. 80 %)</option>
							<option value="wide">Wide</option>
						</select>
					</div>
					<div class="field">
						<label for="{uid}-s">Lowest skill kept (KGE′ or the fit's objective)</label>
						<input id="{uid}-s" type="number" min="-10" max="1" step="0.05" bind:value={minSkill} disabled={busy} />
					</div>
					<div class="field">
						<label for="{uid}-w">Worst WR2012 flag kept</label>
						<select id="{uid}-w" bind:value={wr2012Level} disabled={busy}>
							<option value="ok">OK only</option>
							<option value="note">Note</option>
							<option value="query">Query (default)</option>
							<option value="unusable">No WR2012 check</option>
						</select>
					</div>
					<div class="field">
						<label for="{uid}-l">Largest low-flow bias kept (± %)</label>
						<input id="{uid}-l" type="number" min="0" max="10000" step="5" bind:value={maxLowFlow} disabled={busy || !lowFlowOn} />
						<label class="check"><input type="checkbox" bind:checked={lowFlowOn} disabled={busy} /> Check the low-flow bias</label>
					</div>
					<div class="field">
						<label for="{uid}-p">Pan coefficient ± (GR4J)</label>
						<input id="{uid}-p" type="number" min="0" max="0.3" step="0.01" bind:value={panOffset} disabled={busy} />
					</div>
				</div>
				<div class="action-row">
					<button type="submit" class="btn btn-primary" disabled={busy}>{phase === 'starting' ? 'Starting…' : phase === 'storing' ? 'Checking and storing…' : 'Run ensemble'}</button>
					{#if phase === 'running' || phase === 'reproducing'}<button type="button" class="btn" onclick={cancel}>Cancel</button>{/if}
				</div>
			</form>
		</details>
	{:else if phase === 'reproducing'}
		<div class="actions"><button type="button" class="btn" onclick={cancel}>Cancel</button></div>
	{/if}

	{#if progress}
		<p role="status" aria-live="polite" class="small" data-testid="ensemble-progress">
			{phase === 'reproducing' ? 'Reproducing' : 'Running'}: {fmtNum(progress.done)} of {fmtNum(progress.total)} members, {fmtNum(progress.accepted)} kept so far.
		</p>
		<progress max={progress.total} value={progress.done}></progress>
	{/if}
	{#each startNotes as n (n)}<p class="muted small">{n}</p>{/each}
	{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
</section>

<style>
	.small {
		font-size: 0.85rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8em;
	}
	.rule {
		padding: 0.6rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		font-size: 0.9rem;
	}
	.stat .sub {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin: 0.75rem 0;
	}
	.ok {
		color: var(--success);
	}
	.bad {
		color: var(--danger);
	}
	.empty {
		color: var(--text-muted);
	}
	details {
		margin: 0.75rem 0;
	}
	summary {
		cursor: pointer;
		font-weight: 500;
	}
	.history ul {
		margin: 0.5rem 0;
		padding-left: 1.1rem;
		font-size: 0.85rem;
	}
	.changes {
		color: var(--text-2);
	}
	progress {
		width: 100%;
		max-width: 420px;
	}
	h4 {
		margin: 1rem 0 0.5rem;
	}
	.check {
		display: flex;
		gap: 0.35rem;
		align-items: center;
		font-weight: 400;
		font-size: 0.85rem;
	}
	.ensemble-row {
		align-items: flex-start;
	}
</style>
