<script lang="ts">
	// Compare two runs — same project or two projects you can see.
	// URL: /compare?a=<projectId>:<runId>&b=<projectId>:<runId>, or
	// /compare?project=<id> to open on that project's previous vs latest run.
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type ProjectSummary, type RunCompareResponse, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import CompareChart from '$lib/components/compare/CompareChart.svelte';
	import EwrAgreementCompare from '$lib/components/compare/EwrAgreementCompare.svelte';
	import EwrAssuranceCompare from '$lib/components/compare/EwrAssuranceCompare.svelte';
	import FarmDeltaTable from '$lib/components/compare/FarmDeltaTable.svelte';
	import HeadlineDeltas from '$lib/components/compare/HeadlineDeltas.svelte';
	import FitValidationCompare from '$lib/components/compare/FitValidationCompare.svelte';
	import { chirpsFitNote } from '$lib/components/compare/chirpsFit';
	import { asFitRecord } from '$lib/components/compare/fit';
	import RunPicker from '$lib/components/compare/RunPicker.svelte';
	import { compareSearch, defaultPair, defaultRunFor, formatRef, parseRef, type RunRef } from '$lib/components/compare/picker';
	import { compareEvidenceNote } from '$lib/components/runs/evidence';
	import { fmtDate } from '$lib/format/number';

	// Uncertainty bands and the paired band on B − A (issue #4 phase 9): their own chunk.
	const loadPairedUncertainty = () => import('$lib/components/uncertainty/PairedUncertaintyPanel.svelte');
	const runoffModelOf = (s: RunCompareResponse['a']) => (s.run.inputs.settings?.runoffModel as string | undefined) ?? 'legacy';

	type Side = 'a' | 'b';
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	const refA = $derived(parseRef(page.url.searchParams.get('a')));
	const refB = $derived(parseRef(page.url.searchParams.get('b')));
	const projectParam = $derived(page.url.searchParams.get('project'));

	// --- projects -------------------------------------------------------------
	let projects = $state<ProjectSummary[]>([]);
	let projectsLoading = $state(true);
	let projectsError = $state<string | null>(null);
	async function loadProjects() {
		projectsLoading = true;
		projectsError = null;
		try {
			projects = await api.projects.list();
		} catch (e) {
			projectsError = msg(e);
		} finally {
			projectsLoading = false;
		}
	}
	onMount(loadProjects);

	// --- runs per project (cached) ---------------------------------------------
	let runs = $state<Record<string, RunMeta[]>>({});
	let runsLoading = $state<Record<string, boolean>>({});
	let runsError = $state<Record<string, string>>({});
	const inflight = new Map<string, Promise<RunMeta[] | null>>();
	function ensureRuns(projectId: string): Promise<RunMeta[] | null> {
		if (runs[projectId]) return Promise.resolve(runs[projectId]!);
		let p = inflight.get(projectId);
		if (!p) {
			p = fetchRuns(projectId).finally(() => inflight.delete(projectId));
			inflight.set(projectId, p);
		}
		return p;
	}
	async function fetchRuns(projectId: string): Promise<RunMeta[] | null> {
		runsLoading[projectId] = true;
		delete runsError[projectId];
		try {
			const list = await api.runs.list(projectId);
			runs[projectId] = list;
			return list;
		} catch (e) {
			runsError[projectId] = e instanceof ApiError && e.status === 404 ? 'Project not found or not shared with you' : msg(e);
			return null;
		} finally {
			runsLoading[projectId] = false;
		}
	}

	// A project picked on a side before a run is chosen for it.
	let picked = $state<Record<Side, string | null>>({ a: null, b: null });
	const projectFor = (side: Side) => picked[side] ?? (side === 'a' ? refA : refB)?.projectId ?? projectParam ?? null;
	const projectA = $derived(projectFor('a'));
	const projectB = $derived(projectFor('b'));

	$effect(() => {
		for (const p of [projectA, projectB]) if (p) untrack(() => ensureRuns(p));
	});

	function navigate(a: RunRef | null, b: RunRef | null, replace = false) {
		goto(`${base}/compare${compareSearch(a, b, projectParam)}`, { replaceState: replace, keepFocus: true, noScroll: true });
	}

	// Opened with ?project= only: previous vs latest run of that project.
	let resolving = $state(false);
	$effect(() => {
		const p = projectParam;
		if (!p || refA || refB) return;
		untrack(async () => {
			resolving = true;
			const list = await ensureRuns(p);
			resolving = false;
			const pair = list && defaultPair(p, list);
			if (pair && page.url.searchParams.get('project') === p && !page.url.searchParams.get('a')) navigate(pair.a, pair.b, true);
		});
	});

	async function onProject(side: Side, projectId: string) {
		picked[side] = projectId;
		const list = await ensureRuns(projectId);
		if (!list || picked[side] !== projectId) return;
		const other = side === 'a' ? refB : refA;
		const runId = defaultRunFor(list, other, projectId);
		if (!runId) return; // no runs: the picker says so
		const ref = { projectId, runId };
		picked[side] = null;
		navigate(side === 'a' ? ref : refA, side === 'b' ? ref : refB);
	}

	function onRun(side: Side, runId: string) {
		const projectId = projectFor(side);
		if (!projectId || !runId) return;
		const ref = { projectId, runId };
		picked[side] = null;
		navigate(side === 'a' ? ref : refA, side === 'b' ? ref : refB);
	}

	// --- the comparison ----------------------------------------------------------
	let data = $state<RunCompareResponse | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wantKey = '';
	async function loadCompare(a: RunRef, b: RunRef) {
		const key = `${formatRef(a)}|${formatRef(b)}`;
		wantKey = key;
		loading = true;
		error = null;
		try {
			const d = await api.compare.runs(formatRef(a), formatRef(b));
			if (wantKey === key) data = d;
		} catch (e) {
			if (wantKey !== key) return;
			data = null;
			error =
				e instanceof ApiError && e.status === 404
					? "One of these runs doesn't exist any more, or its project isn't shared with you."
					: msg(e);
		} finally {
			if (wantKey === key) loading = false;
		}
	}
	$effect(() => {
		const a = refA;
		const b = refB;
		untrack(() => {
			if (a && b) loadCompare(a, b);
			else {
				wantKey = '';
				data = null;
				error = null;
				loading = false;
			}
		});
	});

	// Only-one-run / no-runs empty state for the project the page was opened on.
	const soloProject = $derived(!refA && !refB && projectParam ? projectParam : null);
	const soloRuns = $derived(soloProject ? runs[soloProject] : undefined);
	const soloName = $derived(projects.find((p) => p.id === soloProject)?.name ?? 'This project');

	const sameRun = $derived(!!refA && !!refB && formatRef(refA) === formatRef(refB));
	const describe = (s: RunCompareResponse['a']) =>
		`${s.run.label || 'Untitled run'} · ${s.project.name} · ${s.run.startDate} → ${s.run.endDate} · run ${fmtDate(s.run.createdAt, true)}`;
</script>

<svelte:head><title>Compare runs · Water Management</title></svelte:head>

<main class="page">
	<div class="head">
		<h1>Compare runs</h1>
		{#if projectA}<a href="{base}/projects/{projectA}?tab=runs">Back to runs</a>{/if}
	</div>
	<p class="muted intro">
		Pick a baseline (A) and a changed run (B) — from the same project, or from a copy of it. Every change is shown as B − A.
	</p>

	<LoadState loading={projectsLoading} error={projectsError} retry={loadProjects} empty={projects.length === 0} emptyText="You don't have any projects yet.">
		<section class="panel pickers" aria-label="Runs to compare">
			<RunPicker
				id="a"
				legend="Run A — baseline"
				{projects}
				projectId={projectA}
				runId={refA?.runId ?? null}
				runs={projectA ? (runs[projectA] ?? null) : null}
				runsLoading={!!(projectA && runsLoading[projectA])}
				runsError={projectA ? (runsError[projectA] ?? null) : null}
				onProject={(p) => onProject('a', p)}
				onRun={(r) => onRun('a', r)}
			/>
			<RunPicker
				id="b"
				legend="Run B — changed"
				{projects}
				projectId={projectB}
				runId={refB?.runId ?? null}
				runs={projectB ? (runs[projectB] ?? null) : null}
				runsLoading={!!(projectB && runsLoading[projectB])}
				runsError={projectB ? (runsError[projectB] ?? null) : null}
				onProject={(p) => onProject('b', p)}
				onRun={(r) => onRun('b', r)}
			/>
		</section>

		{#if soloProject && soloRuns && soloRuns.length < 2}
			<div class="panel empty" role="status">
				{#if soloRuns.length === 0}
					<h2>No runs to compare yet</h2>
					<p>{soloName} hasn't been run. Run the model, change something (raise a dam, change crops, add a transfer), run it again, then compare the two.</p>
				{:else}
					<h2>Only one run so far</h2>
					<p>
						{soloName} has a single run. Change something in the model and run it again to compare — or pick a run from
						another project (for example a copy of this one) as run B above.
					</p>
				{/if}
				<a class="btn" href="{base}/projects/{soloProject}?tab=runs">Go to the project's runs</a>
			</div>
		{:else if !refA || !refB}
			{#if !resolving}
				<div class="panel empty muted" role="status">Choose a run on each side to see what changed.</div>
			{/if}
		{:else}
			<LoadState loading={loading && !data} {error} retry={() => refA && refB && loadCompare(refA, refB)}>
				{#if data}
					<section class="panel" aria-labelledby="sides-h" aria-busy={loading}>
						<h2 id="sides-h" class="visually-hidden">Runs compared</h2>
						<dl class="sides">
							<div>
								<dt>A</dt>
								<dd>
									{describe(data.a)}
									<!-- The modeller's written explanation of the run (007_run_notes). -->
									{#if data.a.run.notes}<span class="run-notes"><span class="lbl">Run notes:</span> {data.a.run.notes}</span>{/if}
								</dd>
							</div>
							<div>
								<dt>B</dt>
								<dd>
									{describe(data.b)}
									<!-- The modeller's written explanation of the run (007_run_notes). -->
									{#if data.b.run.notes}<span class="run-notes"><span class="lbl">Run notes:</span> {data.b.run.notes}</span>{/if}
								</dd>
							</div>
						</dl>
						{#if sameRun}
							<div class="alert alert-info" role="status">Both sides are the same run, so nothing has changed. Pick a different run for A or B.</div>
						{/if}
						{#if !data.comparison.samePeriod}
							<div class="alert alert-warning" role="status">
								The runs cover different periods (A {data.a.run.startDate} → {data.a.run.endDate}, B {data.b.run.startDate} →
								{data.b.run.endDate}). Figures are averages over each run's own period, so part of each change comes from the dates.
							</div>
						{/if}
						{#if data.comparison.engineVersionChanged}
							<div class="alert alert-info" role="status">
								The runs used different model engine versions ({data.a.run.engineVersion} → {data.b.run.engineVersion}), so some
								change may come from the model itself.
							</div>
						{/if}
						{#if data.comparison.chirpsFit?.changed}
							<div class="alert alert-info" role="status" data-testid="chirps-fit-changed">
								{chirpsFitNote(data.comparison.chirpsFit)}
							</div>
						{/if}
						<!-- Either side is, or was, the project's nominated evidence run (010_run_nomination). -->
						{#each [compareEvidenceNote('A', data.a.run.evidence, (iso) => fmtDate(iso, true)), compareEvidenceNote('B', data.b.run.evidence, (iso) => fmtDate(iso, true))] as note, i (i)}
							{#if note}<div class="alert alert-info" role="status" data-testid="evidence-note">{note}</div>{/if}
						{/each}
						{#if data.a.run.legacy || data.b.run.legacy}
							<div class="alert alert-warning" role="status">
								{#if data.a.run.legacy && data.b.run.legacy}Both runs use
								{:else if data.a.run.legacy}Run A uses
								{:else}Run B uses{/if}
								the legacy runoff model (b023 workbook) — it doesn’t conserve water at the event scale (audit H1), so this
								comparison is workbook comparison only, not evidence for a licence, Reserve or compliance assessment.
							</div>
						{/if}
					</section>

					<section class="panel" aria-labelledby="changes-h">
						<div class="panel-head">
							<h2 id="changes-h">What changed</h2>
							<span class="muted small">{data.changes.length} difference{data.changes.length === 1 ? '' : 's'} in the inputs</span>
						</div>
						<ChangesList changes={data.changes} />
					</section>

					<section class="panel" aria-labelledby="headline-h">
						<div class="panel-head"><h2 id="headline-h">Headline results</h2></div>
						<HeadlineDeltas comparison={data.comparison} />
						<FitValidationCompare
							a={asFitRecord(data.a.run.inputs.settings?.fitRecord)}
							b={asFitRecord(data.b.run.inputs.settings?.fitRecord)}
							settingsA={data.a.run.inputs.settings}
							settingsB={data.b.run.inputs.settings}
						/>
					</section>

					<div class="panel">
						<Lazy load={loadPairedUncertainty}>
							{#snippet children(PairedUncertaintyPanel)}
								<PairedUncertaintyPanel
									projectA={data!.a.project.id}
									runA={data!.a.run.id}
									projectB={data!.b.project.id}
									runB={data!.b.run.id}
									modelA={runoffModelOf(data!.a)}
									modelB={runoffModelOf(data!.b)}
									canEdit={(projects.find((p) => p.id === data!.b.project.id)?.role ?? 'viewer') !== 'viewer'}
								/>
							{/snippet}
						</Lazy>
					</div>

					{#if data.comparison.ewrAssurance?.length}
						<section class="panel" aria-labelledby="reserve-h">
							<div class="panel-head"><h2 id="reserve-h">Reserve compliance by month</h2></div>
							<EwrAssuranceCompare sites={data.comparison.ewrAssurance} />
						</section>
					{/if}

					<section class="panel" aria-labelledby="ewr-agreement-h">
						<div class="panel-head"><h2 id="ewr-agreement-h">EWR test against observed flow</h2></div>
						<EwrAgreementCompare {data} />
					</section>

					<section class="panel" aria-labelledby="farms-h">
						<div class="panel-head"><h2 id="farms-h">Farms</h2></div>
						<FarmDeltaTable comparison={data.comparison} />
					</section>

					<section class="panel" aria-labelledby="chart-h">
						<div class="panel-head"><h2 id="chart-h">Hydrograph</h2></div>
						<CompareChart {data} />
					</section>
				{/if}
			</LoadState>
		{/if}
	</LoadState>
</main>

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.intro {
		max-width: 70ch;
	}
	.pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.empty {
		text-align: center;
		padding: 2rem 1rem;
	}
	.empty p {
		max-width: 60ch;
		margin: 0 auto 1rem;
	}
	.sides {
		display: grid;
		gap: 0.3rem;
		margin: 0 0 0.5rem;
	}
	.sides div {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
	}
	.sides dt {
		font-weight: 700;
		min-width: 1.2rem;
	}
	.sides dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.run-notes {
		display: block;
		white-space: pre-wrap;
		font-size: 0.85rem;
		color: var(--text-2);
		max-width: 90ch;
	}
	.run-notes .lbl {
		font-weight: 500;
	}
	.small {
		font-size: 0.8rem;
	}
	.alert:last-child {
		margin-bottom: 0;
	}
</style>
