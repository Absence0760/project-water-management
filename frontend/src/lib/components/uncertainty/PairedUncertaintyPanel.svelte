<!--
	Run comparison's uncertainty (issue #4 phase 9, docs/run-comparison.md §
	Uncertainty): each run's newest stored band side by side, with what differs
	between their rules (stored thresholds, diffed), and the **paired** band on
	B − A: the baseline A's kept parameter sets run again on B's inputs, the
	difference taken set by set. Part of Compare runs' chunk (CompareView.svelte
	renders it for every comparison). Two runs of one project and one runoff
	model only; bands of two models are never pooled.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onDestroy } from 'svelte';
	import { diffEnsembleOptions, type EnsembleSummary, type PairedResult, type PairedSummary } from '@water-management/engine';
	import { api, type Ensemble, type EnsembleDetail } from '$lib/api';
	import { FitCancelled, startEnsemble, type EnsembleHandle } from '$lib/calibration/runner';
	import { fmtNum } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import { bandCells, pct, rangeText, shownEnsemble, sig } from './bands';

	let {
		projectA,
		runA,
		projectB,
		runB,
		modelA,
		modelB,
		canEdit
	}: { projectA: string; runA: string; projectB: string; runB: string; modelA: string; modelB: string; canEdit: boolean } = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const sameProject = $derived(projectA === projectB && runA !== runB);
	const sameModel = $derived(modelA === modelB);

	let listA = $state<Ensemble[]>([]);
	let listB = $state<Ensemble[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load() {
		error = null;
		try {
			[listA, listB] = await Promise.all([api.uncertainty.list(projectA, runA), api.uncertainty.list(projectB, runB)]);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void [projectA, runA, projectB, runB];
		loading = true;
		load();
	});

	const bandA = $derived(shownEnsemble(listA));
	const bandB = $derived(shownEnsemble(listB));
	const sumA = $derived((bandA?.summary ?? null) as EnsembleSummary | null);
	const sumB = $derived((bandB?.summary ?? null) as EnsembleSummary | null);
	const ruleChanges = $derived(bandA && bandB ? diffEnsembleOptions(bandA.options, bandB.options) : []);
	// The newest stored paired band on B whose baseline is A's shown ensemble.
	const paired = $derived(bandA ? (listB.find((e) => e.baselineId === bandA.id && e.status === 'complete') ?? null) : null);
	const ps = $derived((paired?.summary ?? null) as PairedSummary | null);

	let progress = $state<{ done: number; total: number } | null>(null);
	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let handle: EnsembleHandle<PairedResult> | null = null;
	onDestroy(() => handle?.cancel());

	async function computePaired() {
		if (!bandA) return;
		busy = true;
		actionError = null;
		try {
			const { ensemble } = await api.uncertainty.start(projectB, runB, { baselineId: bandA.id });
			listB = [ensemble, ...listB];
			const [base, input] = await Promise.all([api.uncertainty.get(projectA, runA, bandA.id), api.uncertainty.runInput(projectB, runB)]);
			const r = base.result as Extract<EnsembleDetail['result'], { coverage: unknown }>;
			progress = { done: 0, total: bandA.accepted ?? 0 };
			// bandA is reactive state: post the worker a plain copy (a proxy can't be cloned).
			handle = startEnsemble({ kind: 'paired', input, baseline: { options: $state.snapshot(bandA.options), header: r.header, members: r.members } }, (p) => (progress = p));
			const result = await handle.result;
			await api.uncertainty.complete(projectB, runB, ensemble.id, { members: result.members });
		} catch (err) {
			if (!(err instanceof FitCancelled)) actionError = msg(err);
		} finally {
			handle = null;
			progress = null;
			busy = false;
			await load();
		}
	}

	const headline = (s: EnsembleSummary) => [
		['EWR days not met', rangeText(s.bands.ewrDaysNotMet, (v) => fmtNum(v))],
		['Shortfall (Mm³)', rangeText(s.bands.shortfallMm3)],
		['Outflow MAR (Mm³/a)', rangeText(s.bands.marOutflowMm3)]
	];
</script>

<section aria-labelledby="{uid}-h-t" data-testid="paired-uncertainty">
	<h2 id="{uid}-h"><span id="{uid}-h-t">Uncertainty</span> <HelpTip key="uncertainty-bands" /></h2>
	{#if !sameProject}
		<p class="muted">Paired bands need two different runs of one project: the parameter sets describe one catchment.</p>
	{:else if loading}
		<p class="muted" role="status">Loading…</p>
	{:else if error}
		<div class="alert alert-error" role="alert">{error} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></div>
	{:else}
		{#if sumA || sumB}
			<div class="table-wrap">
				<table class="data compact" aria-labelledby="{uid}-sides">
					<caption id="{uid}-sides">Each run's own 5–95 % band (its newest stored ensemble)</caption>
					<thead>
						<tr><th scope="col">Result</th><th scope="col" class="num">A</th><th scope="col" class="num">B</th></tr>
					</thead>
					<tbody>
						{#each [0, 1, 2] as i (i)}
							<tr>
								<th scope="row">{(sumA ? headline(sumA) : headline(sumB!))[i]![0]}</th>
								<td class="num">{sumA ? headline(sumA)[i]![1] : 'no band'}</td>
								<td class="num">{sumB ? headline(sumB)[i]![1] : 'no band'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if bandA && bandB}
				<p class="small" data-testid="rule-diff">
					{#if ruleChanges.length}
						<strong>The two bands use different rules:</strong>
						{ruleChanges.map((c) => `${c.label} ${c.a} (A) vs ${c.b} (B)`).join('; ')}.
					{:else}
						Both bands use the same rule and sample (seeds aside).
					{/if}
				</p>
			{/if}
		{/if}

		<h3>Paired band on B − A <HelpTip key="paired-band" /></h3>
		{#if !sameModel}
			<p class="muted">The runs use different runoff models ({modelA}, {modelB}): bands of two models are never pooled, so there is no paired band.</p>
		{:else if !bandA}
			<p class="muted">Run A has no stored uncertainty ensemble. Run one in A's Runs tab first; its kept parameter sets are then run on B.</p>
		{:else}
			{#if ps}
				<p class="rule" data-testid="paired-rule"><strong>Decision rule.</strong> {ps.decisionRule}</p>
				{#if ps.gated}
					<p class="alert alert-warning">Only {fmtNum(ps.members)} pairs, fewer than {bandA.options.minMembers}: no percentiles are shown.</p>
				{:else}
					<div class="table-wrap">
						<table class="data compact" aria-labelledby="{uid}-pair">
							<caption id="{uid}-pair">B − A for the same parameter sets: 5 %, median, 95 % of the differences</caption>
							<thead>
								<tr>
									<th scope="col">Change</th>
									<th scope="col" class="num">5 %</th>
									<th scope="col" class="num">Median</th>
									<th scope="col" class="num">95 %</th>
									<th scope="col" class="num">Sets where B is worse</th>
								</tr>
							</thead>
							<tbody>
								<tr data-testid="paired-ewr-days">
									<th scope="row">EWR days not met</th>
									{#each bandCells(ps.ewrDaysNotMet, (v) => fmtNum(v)) as c, i (i)}<td class="num">{c}</td>{/each}
									<td class="num">{pct(ps.ewrDaysNotMetWorse)}</td>
								</tr>
								<tr>
									<th scope="row">Shortfall against the EWR <span class="u">Mm³</span></th>
									{#each bandCells(ps.shortfallMm3) as c, i (i)}<td class="num">{c}</td>{/each}
									<td class="num">{pct(ps.shortfallWorse)}</td>
								</tr>
								<tr>
									<th scope="row">Outflow MAR <span class="u">Mm³/a</span></th>
									{#each bandCells(ps.marOutflowMm3) as c, i (i)}<td class="num">{c}</td>{/each}
									<td></td>
								</tr>
								{#each ps.reserve as s (s.key)}
									<tr>
										<th scope="row">Reserve compliance, {s.name}</th>
										{#each bandCells(s.band, (v) => `${fmtNum(v * 100, 0)} pts`) as c, i (i)}<td class="num">{c}</td>{/each}
										<td></td>
									</tr>
								{/each}
								{#each ps.curtailment as f (f.nodeId)}
									<tr>
										<th scope="row">Curtailment, {f.name} <span class="u">m³/day</span></th>
										{#each bandCells(f.band) as c, i (i)}<td class="num">{c}</td>{/each}
										<td></td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="table-wrap">
						<table class="data compact" aria-labelledby="{uid}-pm">
							<caption id="{uid}-pm">B − A in EWR days not met by month (median, with the 5–95 % range)</caption>
							<thead>
								<tr>{#each ps.ewrDaysNotMetByMonth as _, i (i)}<th scope="col" class="num">{monthName(((i + 9) % 12) + 1)}</th>{/each}</tr>
							</thead>
							<tbody>
								<tr>{#each ps.ewrDaysNotMetByMonth as m, i (i)}<td class="num">{sig(m.p50)}<br /><span class="u">{rangeText(m, (v) => fmtNum(v))}</span></td>{/each}</tr>
							</tbody>
						</table>
					</div>
					{#if ps.unpaired.length}<p class="muted small">Only in one run, so not paired: {ps.unpaired.join(', ')}.</p>{/if}
				{/if}
			{:else}
				<p class="muted">No paired band yet for A's newest ensemble.</p>
			{/if}
			{#if canEdit}
				<div class="actions">
					<button type="button" class="btn" onclick={computePaired} disabled={busy}>{ps ? 'Compute the paired band again' : 'Compute the paired band'}</button>
					{#if busy && progress}<button type="button" class="btn" onclick={() => handle?.cancel()}>Cancel</button>{/if}
				</div>
			{/if}
			{#if progress}
				<p role="status" aria-live="polite" class="small">Running A's kept sets on B: {fmtNum(progress.done)} of {fmtNum(progress.total)}.</p>
				<progress max={progress.total} value={progress.done}></progress>
			{/if}
			{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}
		{/if}
	{/if}
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
	.actions {
		display: flex;
		gap: 0.75rem;
		margin: 0.75rem 0;
	}
	h3 {
		margin: 1rem 0 0.5rem;
	}
	progress {
		width: 100%;
		max-width: 420px;
	}
</style>
