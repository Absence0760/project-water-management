<script lang="ts">
	// One scenario (docs/ui.md § Scenarios): the "Based on run X" banner, its
	// changes (ops) with their class and the server's check, the red
	// "Baseline assumptions changed" callout, and for an editor on a draft the
	// "Add a change" form, undo, the proposer's nodes, rename, rebase onto
	// another run, run, status and delete. Every edit is a PATCH that answers
	// with the scenario's check against its base, so problems show without
	// running. Viewers get the same page read only.
	import { untrack } from 'svelte';
	import type { ScenarioOp } from '@water-management/engine';
	import { api, scenarioProblems, SCENARIO_STATUS_MOVES, type Run, type RunMeta, type ScenarioStatus, type ScenarioWithCheck } from '$lib/api';
	import { detailCache } from '$lib/components/runs/cache';
	import { fmtDate } from '$lib/format/number';
	import OpForm from './OpForm.svelte';
	import OpList from './OpList.svelte';
	import ScenarioCompare from './ScenarioCompare.svelte';
	import { nameIds, namesOf, opItems, snapshotInput, stepInputs } from './ops';
	import Lazy from '$lib/components/common/Lazy.svelte';

	// The Yield panel (WP-3.6) and its chart load only once a dam is picked.
	const loadYield = () => import('$lib/components/yield/YieldPanel.svelte');

	let {
		projectId,
		data,
		runs,
		canEdit,
		onchange,
		ondeleted,
		onran
	}: {
		projectId: string;
		data: ScenarioWithCheck;
		runs: RunMeta[];
		canEdit: boolean;
		onchange: (d: ScenarioWithCheck) => void;
		ondeleted: () => void;
		onran: (run: Run, removedRunIds: string[]) => void;
	} = $props();

	const s = $derived(data.scenario);
	const editable = $derived(canEdit && s.status === 'draft');
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// --- the base run's model and settings (names, current values) -------------
	let baseRun = $state.raw<Run | null>(null);
	let baseError = $state<string | null>(null);
	async function loadBase(runId: string) {
		baseError = null;
		const hit = detailCache.get(runId);
		if (hit) {
			baseRun = hit.run;
			remember(hit.run);
			return;
		}
		baseRun = null;
		try {
			const d = await api.runs.get(projectId, runId);
			detailCache.set(runId, d);
			remember(d.run);
			if (runId === s.baseRunId) baseRun = d.run;
		} catch (e) {
			if (runId === s.baseRunId) baseError = msg(e);
		}
	}
	$effect(() => {
		const id = s.baseRunId;
		untrack(() => loadBase(id));
	});
	/**
	 * Names of every base this editor has loaded: after a rebase onto a run
	 * without a node, an op on that node still names it (the new base can't).
	 */
	let seenNames = $state.raw(new Map<string, string>());
	function remember(r: Run) {
		seenNames = new Map([...seenNames, ...namesOf([snapshotInput(r.model, r.settings).model])]);
	}
	const baseInput = $derived(baseRun ? snapshotInput(baseRun.model, baseRun.settings) : null);
	const names = $derived(new Map([...seenNames, ...namesOf([baseInput?.model], s.ops)]));
	const list = $derived(opItems(s.ops, data.check?.classified ?? null, data.check, baseInput, names));
	/** What a new op meets: the base with every listed op applied. */
	const effective = $derived(baseInput ? stepInputs(baseInput, s.ops).after : null);

	// --- yield (WP-3.6): a farm or dam of the scenario's own network ---------------
	const yieldFarms = $derived((effective?.model.nodes ?? []).filter((n) => n.kind === 'farm'));
	let yieldNodeId = $state('');
	const yieldNode = $derived(yieldFarms.find((n) => n.id === yieldNodeId) ?? null);
	const problems = $derived(data.check?.problems.length ?? 0);
	const baseMeta = $derived(runs.find((r) => r.id === s.baseRunId));

	// --- editing the ops, with undo ------------------------------------------------
	let past = $state.raw<ScenarioOp[][]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let note = $state('');
	// A different scenario starts a fresh undo history and clears the last run's messages.
	$effect(() => {
		void s.id;
		untrack(() => {
			past = [];
			error = null;
			runProblems = [];
			rebaseTo = '';
			rebaseCheck = null;
			renaming = false;
		});
	});

	async function patch(body: Parameters<typeof api.scenarios.update>[2]): Promise<boolean> {
		saving = true;
		error = null;
		try {
			onchange(await api.scenarios.update(projectId, s.id, body));
			return true;
		} catch (e) {
			error = msg(e);
			return false;
		} finally {
			saving = false;
		}
	}
	async function saveOps(next: ScenarioOp[], what: string): Promise<boolean> {
		const was = s.ops;
		const ok = await patch({ ops: next });
		if (ok) {
			past = [...past, was];
			note = what;
		}
		return ok;
	}
	const add = (op: ScenarioOp) => saveOps([...s.ops, op], `Change ${s.ops.length + 1} added.`);
	const removeAt = (i: number) => saveOps(s.ops.filter((_, j) => j !== i), `Change ${i + 1} removed.`);
	async function undo() {
		const prev = past[past.length - 1];
		if (!prev) return;
		if (await patch({ ops: prev })) {
			past = past.slice(0, -1);
			note = 'Last edit undone.';
		}
	}

	// --- name and description ------------------------------------------------------
	let renaming = $state(false);
	let name = $state('');
	let description = $state('');
	function startRename() {
		name = s.name;
		description = s.description;
		renaming = true;
	}
	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		if (await patch({ name: name.trim(), description: description.trim() })) renaming = false;
	}

	// --- the proposer's nodes --------------------------------------------------------
	const owned = $derived(new Set(s.ownedNodeIds));
	/** Nodes of the base, and nodes the scenario adds (always the proposer's: classifyScenario counts them as owned). */
	const baseNodes = $derived(baseInput?.model.nodes ?? []);
	function toggleOwned(id: string, on: boolean) {
		const next = on ? [...s.ownedNodeIds, id] : s.ownedNodeIds.filter((x) => x !== id);
		patch({ ownedNodeIds: next });
	}

	// --- status ------------------------------------------------------------------------
	const MOVE_LABEL: Record<ScenarioStatus, string> = { draft: 'Back to draft', submitted: 'Submit', withdrawn: 'Withdraw', decided: 'Mark decided' };
	const STATUS_LABEL: Record<ScenarioStatus, string> = { draft: 'Draft', submitted: 'Submitted', withdrawn: 'Withdrawn', decided: 'Decided' };
	async function move(to: ScenarioStatus) {
		if (to === 'submitted' && !confirm(`Submit “${s.name}”? Its changes, base run and nodes are then frozen.`)) return;
		if (await patch({ status: to })) note = `Now ${STATUS_LABEL[to].toLowerCase()}.`;
	}

	// --- run ---------------------------------------------------------------------------
	let running = $state(false);
	let runProblems = $state<string[]>([]);
	async function run() {
		running = true;
		error = null;
		runProblems = [];
		try {
			const r = await api.scenarios.run(projectId, s.id, s.name);
			onran(r.run, r.removedRunIds);
			note = `Ran “${s.name}”.`;
		} catch (e) {
			runProblems = scenarioProblems(e);
			error = runProblems.length ? "The scenario can't run: these changes don't apply to its base run." : msg(e);
		} finally {
			running = false;
		}
	}

	// --- rebase ------------------------------------------------------------------------
	/** Another run of the model to base the scenario on (a scenario run can't be a base). */
	const rebaseChoices = $derived(runs.filter((r) => !r.scenarioId && r.id !== s.baseRunId));
	let rebaseTo = $state('');
	let rebaseCheck = $state<{ runId: string; problems: string[] } | null>(null);
	let rebasing = $state(false);
	async function checkRebase() {
		if (!rebaseTo) return;
		rebasing = true;
		error = null;
		try {
			const r = await api.scenarios.rebase(projectId, s.id, rebaseTo, true);
			rebaseCheck = { runId: rebaseTo, problems: r.problems };
		} catch (e) {
			error = msg(e);
		} finally {
			rebasing = false;
		}
	}
	async function rebase() {
		if (!rebaseCheck) return;
		rebasing = true;
		error = null;
		try {
			await api.scenarios.rebase(projectId, s.id, rebaseCheck.runId, false);
			// The rebase answer has no check against the new base: read the scenario again for it.
			onchange(await api.scenarios.get(projectId, s.id));
			past = [];
			note = 'Rebased onto the new run.';
			rebaseCheck = null;
			rebaseTo = '';
		} catch (e) {
			error = msg(e);
		} finally {
			rebasing = false;
		}
	}
	const runLabel = (r: { label: string | null; createdAt: string }) => `${r.label || 'Untitled run'} · ${fmtDate(r.createdAt, true)}`;

	// --- delete ------------------------------------------------------------------------
	async function remove() {
		if (!confirm(`Delete the scenario “${s.name}”? Its runs stay, as ordinary runs.`)) return;
		saving = true;
		error = null;
		try {
			await api.scenarios.remove(projectId, s.id);
			ondeleted();
		} catch (e) {
			error = msg(e);
		} finally {
			saving = false;
		}
	}
</script>

<section class="panel" aria-labelledby="scenario-h">
	<div class="panel-head">
		<h2 id="scenario-h">{s.name}</h2>
		<span class="status status-{s.status}">{STATUS_LABEL[s.status]}</span>
		{#if canEdit && !renaming}<button type="button" class="btn btn-sm btn-ghost" onclick={startRename}>Rename</button>{/if}
	</div>

	{#if renaming}
		<form class="rename" onsubmit={saveName}>
			<div class="field">
				<label for="scenario-name">Name</label>
				<input id="scenario-name" type="text" maxlength="100" required bind:value={name} />
			</div>
			<div class="field">
				<label for="scenario-desc">Description</label>
				<textarea id="scenario-desc" rows="2" maxlength="2000" bind:value={description}></textarea>
			</div>
			<div class="toolbar">
				<button type="submit" class="btn btn-primary btn-sm" disabled={saving || !name.trim()}>Save</button>
				<button type="button" class="btn btn-sm" onclick={() => (renaming = false)}>Cancel</button>
			</div>
		</form>
	{:else if s.description}
		<p class="desc">{s.description}</p>
	{/if}

	<p class="banner" data-testid="scenario-base">
		Based on run <strong>{s.baseRun.label || 'Untitled run'}</strong> (run {fmtDate(s.baseRun.createdAt, true)}{baseMeta?.published ? ', published' : ''}).
		{#if s.owner}Created by {s.owner}.{/if}
		The base can't be deleted or trimmed while this scenario exists.
	</p>

	{#if data.checkError}
		<div class="alert alert-warning" role="status">These changes can't be checked: {data.checkError}</div>
	{/if}
	{#if baseError}
		<div class="alert alert-warning" role="status">The base run's model couldn't be loaded ({baseError}), so changes are listed without their current values.</div>
	{/if}
	{#if problems}
		<div class="alert alert-warning" role="status" data-testid="scenario-problems">
			{problems === 1 ? "1 change doesn't" : `${problems} changes don't`} apply to the base run, so the scenario can't run until
			{problems === 1 ? 'it is' : 'they are'} removed or the base changes.
		</div>
	{/if}

	<section aria-labelledby="changes-h">
		<div class="changes-head">
			<h3 id="changes-h">Changes</h3>
			{#if editable}<button type="button" class="btn btn-sm" disabled={!past.length || saving} onclick={undo}>Undo</button>{/if}
		</div>
		{#if s.ops.length}
			<OpList items={list.items} other={list.other} label="Changes in {s.name}" onremove={editable ? removeAt : undefined} disabled={saving} />
		{:else}
			<p class="muted">No changes yet. {editable ? 'Add one below: raise a dam, plant a crop, add a transfer…' : ''}</p>
		{/if}
		{#if editable && effective}
			<OpForm input={effective} onadd={add} disabled={saving} />
		{/if}
		<p class="visually-hidden" role="status">{note}</p>
	</section>

	{#if baseNodes.length && (editable || s.ownedNodeIds.length)}
		<fieldset class="owned">
			<legend>The proposer's nodes</legend>
			<p class="hint">
				Changes to these nodes (and nodes the scenario adds) are the proposal; changes to anything else are baseline assumptions.
			</p>
			<div class="owned-list">
				{#each baseNodes as n (n.id)}
					<label><input type="checkbox" checked={owned.has(n.id)} disabled={!editable || saving} onchange={(e) => toggleOwned(n.id, e.currentTarget.checked)} /> {n.name}</label>
				{/each}
			</div>
		</fieldset>
	{/if}

	{#if canEdit}
		<div class="actions">
			<button type="button" class="btn btn-primary" disabled={running || saving || !data.check || problems > 0 || !s.ops.length} onclick={run}
				>{running ? 'Running…' : 'Run scenario'}</button
			>
			{#each SCENARIO_STATUS_MOVES[s.status] as to (to)}
				<button type="button" class="btn" disabled={saving} onclick={() => move(to)}>{MOVE_LABEL[to]}</button>
			{/each}
			{#if s.status === 'draft' || s.status === 'withdrawn'}
				<button type="button" class="btn btn-danger" disabled={saving} onclick={remove}>Delete scenario</button>
			{/if}
		</div>
		{#if !s.ops.length && s.status === 'draft'}<p class="hint">Add a change before running: with none, the scenario is its base run.</p>{/if}
	{/if}
	{#if error}
		<div class="alert alert-error" role="alert">
			{error}
			{#if runProblems.length}
				<ul>
					{#each runProblems as p, i (i)}<li>{nameIds(p, names)}</li>{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if editable}
		<details class="rebase">
			<summary>Rebase onto another run</summary>
			<p class="hint">Apply the same changes to a newer run of the model. The check lists any change that no longer applies (a node removed since, say).</p>
			{#if rebaseChoices.length}
				<div class="form-row">
					<div class="field">
						<label for="rebase-run">New base run</label>
						<select
							id="rebase-run"
							bind:value={rebaseTo}
							onchange={() => {
								rebaseCheck = null;
							}}
						>
							<option value="" disabled>Pick a run</option>
							{#each rebaseChoices as r (r.id)}<option value={r.id}>{runLabel(r)}</option>{/each}
						</select>
					</div>
					<div class="field">
						<button type="button" class="btn" disabled={!rebaseTo || rebasing} onclick={checkRebase}>Check</button>
					</div>
				</div>
				{#if rebaseCheck}
					<div data-testid="rebase-check">
						{#if rebaseCheck.problems.length}
							<p class="warn">
								{rebaseCheck.problems.length === 1 ? "1 change doesn't" : `${rebaseCheck.problems.length} changes don't`} apply to that run:
							</p>
							<ul class="warn">
								{#each rebaseCheck.problems as p, i (i)}<li>{nameIds(p, names)}</li>{/each}
							</ul>
						{:else}
							<p>Every change applies to that run.</p>
						{/if}
						<button type="button" class="btn btn-primary btn-sm" disabled={rebasing} onclick={rebase}>Rebase onto this run</button>
					</div>
				{/if}
			{:else}
				<p class="muted">There's no other run of the model to rebase onto.</p>
			{/if}
		</details>
	{/if}
</section>

<ScenarioCompare {projectId} scenario={s} />

{#if yieldFarms.length}
	<section class="panel" aria-labelledby="scenario-yield-h">
		<div class="panel-head">
			<h2 id="scenario-yield-h">Yield under this scenario</h2>
		</div>
		<div class="field">
			<label for="scenario-yield-node">Dam</label>
			<select id="scenario-yield-node" bind:value={yieldNodeId}>
				<option value="">Pick a farm or dam…</option>
				{#each yieldFarms as n (n.id)}
					<option value={n.id}>{n.name || 'Unnamed'}{n.damCapacityM3 > 0 ? '' : ' (no dam)'}</option>
				{/each}
			</select>
		</div>
	</section>
	{#if yieldNode}
		{#key yieldNode.id}
			<Lazy load={loadYield}>
				{#snippet children(YieldPanel)}
					<YieldPanel {projectId} nodeId={yieldNode.id} nodeName={yieldNode.name} scenarioId={s.id} {canEdit} hasDam={yieldNode.damCapacityM3 > 0} />
				{/snippet}
			</Lazy>
		{/key}
	{/if}
{/if}

<style>
	.panel-head {
		justify-content: flex-start;
	}
	.panel-head h2 {
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.status {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.05rem 0.5rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.status-submitted,
	.status-decided {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.desc {
		white-space: pre-wrap;
		max-width: 80ch;
		margin: 0 0 0.75rem;
	}
	.banner {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--surface-2);
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}
	.changes-head {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		margin: 0.5rem 0;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	.owned {
		margin: 1rem 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.owned legend {
		font-weight: 600;
	}
	.owned-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	.owned-list label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 32px;
	}
	.hint {
		font-size: 0.82rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0.5rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.rebase {
		margin-top: 1rem;
	}
	.rebase summary {
		cursor: pointer;
		font-weight: 500;
		min-height: 32px;
		display: flex;
		align-items: center;
	}
	.warn {
		color: var(--warning);
	}
	.alert ul {
		margin: 0.4rem 0 0;
	}
	@media (max-width: 640px) {
		.owned-list label,
		.rebase summary {
			min-height: var(--tap);
		}
	}
</style>
