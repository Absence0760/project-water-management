<script lang="ts">
	// The workspace's Scenarios tab (?tab=scenarios, docs/ui.md § Scenarios,
	// docs/scenarios.md): the project's scenarios, a form to start one on a
	// run, and the chosen one (?scenario=<id>) in the editor. Viewers read
	// every scenario; farmers never reach the workspace (their view is the
	// farm page), and the API refuses them scenarios anyway.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, type Run, type RunMeta, type Scenario, type ScenarioWithCheck } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';
	import ScenarioEditor from './ScenarioEditor.svelte';

	let {
		projectId,
		runs,
		canEdit,
		onRunsChange
	}: {
		projectId: string;
		runs: RunMeta[] | null;
		canEdit: boolean;
		onRunsChange: (runs: RunMeta[]) => void;
	} = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// --- the list ---------------------------------------------------------------------
	let scenarios = $state<Scenario[] | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	async function loadList() {
		loading = true;
		error = null;
		try {
			scenarios = await api.scenarios.list(projectId);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(loadList);
	});

	// --- the chosen scenario (?scenario=) ----------------------------------------------
	const selectedId = $derived(page.url.searchParams.get('scenario'));
	let detail = $state<ScenarioWithCheck | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<string | null>(null);
	let wanted = '';
	async function loadDetail(id: string) {
		wanted = id;
		detailLoading = true;
		detailError = null;
		try {
			const d = await api.scenarios.get(projectId, id);
			if (wanted === id) detail = d;
		} catch (e) {
			if (wanted === id) {
				detail = null;
				detailError = msg(e);
			}
		} finally {
			if (wanted === id) detailLoading = false;
		}
	}
	$effect(() => {
		const id = selectedId;
		untrack(() => {
			if (id && detail?.scenario.id !== id) loadDetail(id);
			if (!id) {
				wanted = '';
				detail = null;
				detailError = null;
			}
		});
	});

	function select(id: string | null) {
		const q = new URLSearchParams(page.url.searchParams);
		if (id) q.set('scenario', id);
		else q.delete('scenario');
		goto(`?${q}`, { noScroll: true, keepFocus: true });
	}

	/**
	 * A scenario's base run is cited (kept, no delete or unpin): after one is
	 * created, rebased or deleted, reload the runs so the Runs tab's lock
	 * (RunMeta.citedBy) is current. Best effort, like the page's own list
	 * refresh: on failure the list keeps its values, and the server still
	 * refuses to delete a cited run.
	 */
	async function refreshRuns() {
		try {
			onRunsChange(await api.runs.list(projectId));
		} catch {
			// The lists stay as they were (see above).
		}
	}

	function changed(d: ScenarioWithCheck) {
		const rebased = detail?.scenario.id === d.scenario.id && detail.scenario.baseRunId !== d.scenario.baseRunId;
		detail = d;
		scenarios = (scenarios ?? []).map((x) => (x.id === d.scenario.id ? d.scenario : x));
		if (rebased) refreshRuns();
	}
	async function deleted() {
		const id = detail?.scenario.id;
		scenarios = (scenarios ?? []).filter((x) => x.id !== id);
		detail = null;
		select(null);
		refreshRuns();
	}
	async function ran(run: Run, removedRunIds: string[]) {
		const { summary: _s, ...meta } = run;
		onRunsChange([meta, ...(runs ?? []).filter((x) => x.id !== run.id && !removedRunIds.includes(x.id))]);
		// The scenario's run count and latest run come from the server.
		if (detail) await loadDetail(detail.scenario.id);
		if (detail) changed(detail);
	}

	// --- a new scenario ------------------------------------------------------------------
	/** Runs of the model a scenario can start from: a scenario run can't be a base. */
	const bases = $derived((runs ?? []).filter((r) => !r.scenarioId));
	/** The published run when there is one (what stakeholders see), else the latest. */
	const defaultBase = $derived(bases.find((r) => r.published)?.id ?? bases[0]?.id ?? '');
	let newName = $state('');
	let newBase = $state('');
	let creating = $state(false);
	let createError = $state<string | null>(null);
	async function create(e: SubmitEvent) {
		e.preventDefault();
		const baseRunId = newBase || defaultBase;
		if (!newName.trim() || !baseRunId) return;
		creating = true;
		createError = null;
		try {
			const d = await api.scenarios.create(projectId, { name: newName.trim(), baseRunId });
			scenarios = [d.scenario, ...(scenarios ?? [])];
			detail = d;
			newName = '';
			newBase = '';
			select(d.scenario.id);
			refreshRuns();
		} catch (err) {
			createError = msg(err);
		} finally {
			creating = false;
		}
	}
	const runLabel = (r: RunMeta) => `${r.label || 'Untitled run'} · ${fmtDate(r.createdAt, true)}${r.published ? ' · published' : ''}`;
	const STATUS: Record<Scenario['status'], string> = { draft: 'Draft', submitted: 'Submitted', withdrawn: 'Withdrawn', decided: 'Decided' };
</script>

<div class="layout">
	<section class="panel rail" aria-labelledby="scenarios-h">
		<div class="panel-head"><h2 id="scenarios-h">Scenarios</h2></div>
		<LoadState {loading} {error} retry={loadList}>
			{#if scenarios?.length}
				<ul class="list">
					{#each scenarios as sc (sc.id)}
						<li>
							<button type="button" class="pick" aria-current={sc.id === selectedId || undefined} onclick={() => select(sc.id)}>
								<span class="name">{sc.name}</span>
								<span class="meta">
									{STATUS[sc.status]} · {sc.ops.length} change{sc.ops.length === 1 ? '' : 's'} · on {sc.baseRun.label || 'Untitled run'}{sc.lastRun ? ` · run ${fmtDate(sc.lastRun.createdAt, true)}` : ''}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty" data-testid="scenarios-empty">No scenarios yet. A scenario changes the published baseline without copying it.</p>
			{/if}
		</LoadState>

		{#if canEdit}
			<form class="create" onsubmit={create} aria-labelledby="new-scenario-h">
				<h3 id="new-scenario-h">New scenario</h3>
				{#if bases.length}
					<div class="field">
						<label for="new-scenario-name">Name</label>
						<input id="new-scenario-name" type="text" maxlength="100" placeholder="e.g. Upper dam +20 %" bind:value={newName} />
					</div>
					<div class="field">
						<label for="new-scenario-base">Base run</label>
						<select id="new-scenario-base" value={newBase || defaultBase} onchange={(e) => (newBase = e.currentTarget.value)}>
							{#each bases as r (r.id)}<option value={r.id}>{runLabel(r)}</option>{/each}
						</select>
						<span class="hint">The scenario's changes apply to this run's stored inputs, never to the live model.</span>
					</div>
					<button type="submit" class="btn btn-primary" disabled={creating || !newName.trim()}>{creating ? 'Creating…' : 'Create scenario'}</button>
					{#if createError}<p class="err" role="alert">{createError}</p>{/if}
				{:else}
					<p class="muted">Run the model first: a scenario is a set of changes to a run.</p>
				{/if}
			</form>
		{/if}
	</section>

	<div class="detail">
		{#if selectedId}
			<LoadState loading={detailLoading && !detail} error={detailError} retry={() => selectedId && loadDetail(selectedId)}>
				{#if detail}
					<ScenarioEditor {projectId} data={detail} runs={runs ?? []} {canEdit} onchange={changed} ondeleted={deleted} onran={ran} />
				{/if}
			</LoadState>
		{:else if scenarios?.length}
			<p class="panel muted pick-one">Pick a scenario to see its changes and results.</p>
		{/if}
	</div>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.list {
		list-style: none;
		margin: 0 0 0.5rem;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}
	.pick {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		width: 100%;
		min-height: 44px;
		padding: 0.4rem 0.6rem;
		text-align: left;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.pick:hover {
		background: var(--surface-2);
	}
	.pick[aria-current='true'] {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.empty {
		color: var(--text-2);
	}
	.create {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.create h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.err {
		color: var(--danger);
		margin: 0.5rem 0 0;
	}
	.detail {
		min-width: 0;
		display: grid;
		/* One column no wider than the page: a wide table or select inside scrolls, not the page. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	.pick-one {
		margin: 0;
	}
	/* Phones and narrow screens: the list above the scenario. */
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
