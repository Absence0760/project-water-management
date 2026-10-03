<script lang="ts">
	import { isScenarioRun } from '$lib/components/runs/scenarioRun';
	// One scenario (docs/ui.md § Scenarios): the "Based on run X" banner, its
	// changes (ops) with their class and the server's check, the red
	// "Baseline assumptions changed" callout, and for an editor on a draft the
	// "Add a change" form or override mode (the model tables, OverrideEditor),
	// undo, the proposer's nodes, rename, rebase onto another run, and in the
	// head row beside the name (issue #17): run, status and delete. Every edit is a PATCH that answers
	// with the scenario's check against its base, so problems show without
	// running. Viewers get the same page read only.
	//
	// An application (origin 'applicant', WP-3.3, docs/ui.md § Applications):
	// only its owner changes it, and moves it with Submit / Withdraw / Reopen;
	// an editor who isn't its owner decides a submitted one (DecideForm). An
	// applicant (`applicant`) reads the base through the applicant projection
	// (api.scenarios.base: other farms anonymised) and, instead of the
	// comparison, their own view of the results (ApplicantResults: the
	// server's projection of the run against its base), and a Yield panel for
	// their own units and the ones their changes add.
	import { untrack } from 'svelte';
	import type { ScenarioOp } from '@water-management/engine';
	import { api, scenarioProblems, SCENARIO_STATUS_MOVES, type Run, type RunMeta, type ScenarioStatus, type ScenarioWithCheck } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { detailCache } from '$lib/components/runs/cache';
	import { fmtDate } from '$lib/format/number';
	import ApplicationPanel from './ApplicationPanel.svelte';
	import OpForm from './OpForm.svelte';
	import OpList from './OpList.svelte';
	import ScenarioCompare from './ScenarioCompare.svelte';
	import ApplicantResults from './ApplicantResults.svelte';
	import ScenarioStatement from './ScenarioStatement.svelte';
	import AskAssessors from './AskAssessors.svelte';
	import { nameIds, namesOf, opItems, snapshotInput, stepInputs } from './ops';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { guardUnsaved } from '$lib/nav/unsaved';
	import { leavesScenario } from './leaves';
	import { FORMER_MEMBER } from '$lib/format/maker';

	// The Yield panel (WP-3.6) and its chart load only once a dam is picked.
	const loadYield = () => import('$lib/components/yield/YieldPanel.svelte');
	// Override mode (the model tables recording changes) loads when opened.
	const loadOverride = () => import('./OverrideEditor.svelte');

	let {
		projectId,
		data,
		runs,
		canEdit,
		actsForAuthority = false,
		applicant = false,
		onchange,
		ondeleted,
		onran
	}: {
		projectId: string;
		data: ScenarioWithCheck;
		runs: RunMeta[];
		/** An editor or owner of the project. */
		canEdit: boolean;
		/** The caller acts for the responsible authority (163): with canEdit, they record its decision. */
		actsForAuthority?: boolean;
		/** The caller is an applicant (the contributor role): the applicant projection of the base, no comparison. */
		applicant?: boolean;
		onchange: (d: ScenarioWithCheck) => void;
		ondeleted: () => void;
		onran: (run: Run, removedRunIds: string[]) => void;
	} = $props();

	const s = $derived(data.scenario);
	const isApplication = $derived(s.origin === 'applicant');
	const isOwner = $derived(!!session.user && session.user.id === s.ownerUserId);
	/** Who changes it: an editor on a team scenario, only its owner on an application. */
	const canChange = $derived(isApplication ? isOwner : canEdit);
	/** Who runs it: an editor; on an application also its owner and the people it's shared with. */
	const canRun = $derived(canEdit || (isApplication && applicant));
	const editable = $derived(canChange && s.status === 'draft');
	/** Nodes the applicant sees only by kind and an anonymous name: their values are blank, not the base's. */
	let anonymised = $state.raw(new Set<string>());
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// --- the base run's model and settings (names, current values) -------------
	let baseRun = $state.raw<Run | null>(null);
	let baseError = $state<string | null>(null);
	async function loadBase(runId: string) {
		baseError = null;
		if (applicant) {
			// The applicant projection of the published base (a contributor can't read the run).
			baseRun = null;
			try {
				const b = await api.scenarios.base(projectId, s.id);
				if (runId !== s.baseRunId) return;
				anonymised = new Set(b.anonymisedNodeIds);
				baseRun = { id: b.baseRunId, model: b.model, settings: b.settings } as unknown as Run;
			} catch (e) {
				if (runId === s.baseRunId) baseError = msg(e);
			}
			return;
		}
		const hit = detailCache.get(runId);
		if (hit) {
			baseRun = hit.run;
			return;
		}
		baseRun = null;
		try {
			const d = await api.runs.get(projectId, runId);
			detailCache.set(runId, d);
			if (runId === s.baseRunId) baseRun = d.run;
		} catch (e) {
			if (runId === s.baseRunId) baseError = msg(e);
		}
	}
	$effect(() => {
		const id = s.baseRunId;
		untrack(() => loadBase(id));
	});
	const baseInput = $derived(baseRun ? snapshotInput(baseRun.model, baseRun.settings) : null);
	/**
	 * The names the server kept with the ops (from the base each op was made
	 * on), so an op on a node a rebase dropped still reads by name after a
	 * reload; the current base and the ops' own new nodes and crops win. An
	 * applicant gets only their own nodes' names (the server filters them).
	 */
	const names = $derived(new Map([...s.opNames.map((x) => [x.id, x.name] as const), ...namesOf([baseInput?.model], s.ops)]));
	// An anonymised node's values are blanks, so an op on one isn't shown "from" them.
	const list = $derived(opItems(s.ops, data.check?.classified ?? null, data.check, anonymised.size ? null : baseInput, names));
	/** What a new op meets: the base with every listed op applied. */
	const effective = $derived(baseInput ? stepInputs(baseInput, s.ops).after : null);

	// --- yield (WP-3.6): a farm or dam of the scenario's own network ---------------
	// An applicant only their own units and the ones their node.add ops add
	// (096_contributor_yield): the anonymous others have blank values and no yield of theirs.
	const addedNodeIds = $derived(new Set(s.ops.flatMap((o) => (o.op === 'node.add' ? [o.node.id] : []))));
	const yieldFarms = $derived(
		(effective?.model.nodes ?? []).filter((n) => n.kind === 'farm' && (!applicant || s.ownedNodeIds.includes(n.id) || addedNodeIds.has(n.id)))
	);
	/** Who queues a yield: an editor; on an application its applicant (not the people it's shared with, 096). */
	const canYield = $derived(applicant ? isOwner : canEdit);
	let yieldNodeId = $state('');
	const yieldNode = $derived(yieldFarms.find((n) => n.id === yieldNodeId) ?? null);
	/** Changes that don't apply: an edit group's one problem line counts each of its ops. */
	const problems = $derived(data.check ? s.ops.length - data.check.applied.length : 0);
	const baseMeta = $derived(runs.find((r) => r.id === s.baseRunId));
	/** The assessors' words for the lines a hidden rule masked (164): editors only, and only where they differ from what the applicant reads. */
	const unmasked = $derived(
		(data.check?.assessorProblems ?? []).map((text, i) => ({ text, masked: data.check?.problems[i] })).filter((x) => x.masked !== undefined && x.masked !== x.text)
	);

	// --- editing the ops, with undo ------------------------------------------------
	let past = $state.raw<ScenarioOp[][]>([]);
	let saving = $state(false);
	let running = $state(false);
	let error = $state<string | null>(null);
	let note = $state('');
	// A different scenario starts a fresh undo history, closes override mode and
	// clears the last run's messages. Keyed on the id alone: `s` is a new object
	// after every PATCH, and an effect on it would reset all this on every edit.
	const scenarioKey = $derived(s.id);
	$effect(() => {
		void scenarioKey;
		untrack(() => {
			past = [];
			error = null;
			overriding = false;
			overrideDirty = false;
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
	/** Override mode's edits, appended as one edit (one undo step). */
	const addMany = (ops: ScenarioOp[]) => saveOps([...s.ops, ...ops], `${ops.length === 1 ? '1 change' : `${ops.length} changes`} added from the model tables.`);

	// --- override mode: the Network, Crops and Transfers tables on the scenario's model ---
	let overriding = $state(false);
	/** Override mode has edits not yet recorded: the list, undo, run, status moves and delete wait for them. */
	let overrideDirty = $state(false);
	/**
	 * Saving, unrecorded override edits, or a run in flight. A status move waits
	 * for a run too: the run's re-read of the scenario (ScenariosTab `ran`) could
	 * otherwise land after a submit and put the draft status back on screen.
	 */
	const busy = $derived(saving || overrideDirty || running);
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
	// A rename typed but not saved: leaving the scenario asks first (lib/nav/leaveGuard.ts).
	guardUnsaved({
		dirty: () => renaming && (name.trim() !== s.name || description.trim() !== s.description),
		what: () => `a new name for “${s.name}” not yet saved`,
		leaves: leavesScenario
	});
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
		if (
			to === 'submitted' &&
			!(await confirmDialog({
				title: `Submit “${s.name}”?`,
				message: 'Its changes, base run and nodes are then frozen.',
				confirmLabel: 'Submit'
			}))
		)
			return;
		if (await patch({ status: to })) note = `Now ${STATUS_LABEL[to].toLowerCase()}.`;
	}

	// --- run ---------------------------------------------------------------------------
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
	const rebaseChoices = $derived(runs.filter((r) => !isScenarioRun(r) && r.id !== s.baseRunId));
	let rebaseTo = $state('');
	let rebaseCheck = $state<{ runId: string; problems: string[]; skipped: number } | null>(null);
	let rebasing = $state(false);
	async function checkRebase() {
		if (!rebaseTo) return;
		rebasing = true;
		error = null;
		try {
			const r = await api.scenarios.rebase(projectId, s.id, rebaseTo, true);
			rebaseCheck = { runId: rebaseTo, problems: r.problems, skipped: s.ops.length - r.applied.length };
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
		if (
			!(await confirmDialog({
				title: `Delete the scenario “${s.name}”?`,
				message: 'Its runs stay, as ordinary runs.',
				confirmLabel: 'Delete scenario',
				danger: true
			}))
		)
			return;
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
	<!-- The scenario's name and status, with what to do with it on the right (issue #17): Run stays on the first
	     screen however long the changes and the node list below get. -->
	<div class="sc-head">
		<div class="sc-title">
			<h2 id="scenario-h">{s.name}</h2>
			<span class="status status-{s.status}">{STATUS_LABEL[s.status]}</span>
			{#if isApplication}<span class="status">Application</span>{/if}
			{#if canChange && !renaming}<button type="button" class="btn btn-sm btn-ghost" onclick={startRename}>Rename</button>{/if}
		</div>
		{#if canRun || canChange}
			<div class="actions" data-testid="scenario-actions">
				{#if canRun}
					<button type="button" class="btn btn-primary" disabled={running || busy || !data.check || problems > 0 || !s.ops.length} onclick={run}
						>{running ? 'Running…' : 'Run scenario'}</button
					>
				{/if}
				{#if canChange && !isApplication}
					{#each SCENARIO_STATUS_MOVES[s.status] as to (to)}
						<button type="button" class="btn" disabled={busy} onclick={() => move(to)}>{MOVE_LABEL[to]}</button>
					{/each}
				{/if}
				{#if canChange && (s.status === 'draft' || s.status === 'withdrawn')}
					<button type="button" class="btn btn-danger" disabled={busy} onclick={remove}>Delete {isApplication ? 'application' : 'scenario'}</button>
				{/if}
			</div>
		{/if}
	</div>
	{#if canRun && !s.ops.length && s.status === 'draft'}<p class="hint run-hint">Add a change before running: with none, the scenario is its base run.</p>{/if}

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
		Based on run <strong>{s.baseRun.label || 'Untitled run'}</strong>{#if s.baseRun.createdAt}{' '}(run {fmtDate(s.baseRun.createdAt, true)}{baseMeta?.published || isApplication ? ', published' : ''}){/if}.
		Created by {s.owner ?? FORMER_MEMBER}.
		The base can't be deleted or trimmed while this scenario exists.
	</p>
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
	{#if isApplication && applicant && data.check}
		<AskAssessors {projectId} scenarioId={s.id} problems={data.check.problems} maskedRules={data.check.maskedRules} canAsk={applicant} />
	{/if}
	{#if unmasked.length}
		<!-- The assessors only (164): the rules the applicant reads as "doesn't apply to the catchment as modelled", in their own words. -->
		<div class="alert alert-info" role="status" data-testid="scenario-unmasked">
			The applicant reads {unmasked.length === 1 ? 'this rule' : 'these rules'} without the other units’ figures. In {unmasked.length === 1 ? 'its' : 'their'} own words:
			<ul>
				{#each unmasked as u, i (i)}<li>{u.text}</li>{/each}
			</ul>
		</div>
	{/if}
	{#if data.check?.renamed?.length}
		<!-- The assessors only (the applicant never learns a hidden name): what the application's names displaced. -->
		<p class="alert alert-info" role="status" data-testid="scenario-renamed">
			The applicant gave a name already used by a hydrological unit or crop they can't see; in this application's runs
			{data.check.renamed.map((r) => `${r.name} is called “${r.as}”`).join(', ')}.
		</p>
	{/if}
	{#if data.check?.reIds?.length}
		<!-- The assessors only: an id the applicant gave a new item was a hidden item's, so the new item runs under a fresh one. -->
		<p class="alert alert-info" role="status" data-testid="scenario-reids">
			The applicant gave a new item an id already used by one they can't see; in this application's runs
			{data.check.reIds.map((r) => `their ${r.kind === 'landCover' ? 'land-cover patch' : r.kind} ${r.id} is ${r.as}`).join(', ')}.
		</p>
	{/if}

	<section aria-labelledby="changes-h">
		<div class="changes-head">
			<h3 id="changes-h">Changes</h3>
			{#if editable}<button type="button" class="btn btn-sm" disabled={!past.length || busy} onclick={undo}>Undo</button>{/if}
		</div>
		{#if s.ops.length}
			<OpList items={list.items} other={list.other} label="Changes in {s.name}" onremove={editable ? removeAt : undefined} disabled={busy} />
		{:else}
			<p class="muted">No changes yet. {editable ? 'Add one below, or edit the model tables: raise a dam, plant a crop, add a transfer…' : ''}</p>
		{/if}
		{#if editable && effective}
			{#if overriding}
				<p class="hint">Editing in the model tables below. Close override mode to add a change with the form instead.</p>
			{:else}
				<div class="override-open">
					<button type="button" class="btn" onclick={() => (overriding = true)}>Edit in the model tables</button>
					<span class="hint">The Network, Crops and Transfers tables on this scenario's model; each edit is recorded as a change.</span>
				</div>
				<OpForm input={effective} onadd={add} disabled={saving} {projectId} />
			{/if}
		{/if}
		<p class="visually-hidden" role="status">{note}</p>
	</section>

	{#if baseNodes.length && !isApplication && (editable || s.ownedNodeIds.length)}
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

	<!-- Appendix C's fixed prompts (129_scenario_statement): changed on the description's terms, so not frozen by a submission. -->
	{#key s.id}
		<ScenarioStatement scenarioName={s.name} answers={s} {canChange} {saving} onsave={(p) => patch(p)} />
	{/key}

	{#if isApplication}
		<ApplicationPanel {projectId} scenario={s} {isOwner} canDecide={canEdit && actsForAuthority && !isOwner} {canEdit} {problems} unverifiedRuns={data.unverifiedRunIds?.length ?? 0} locked={busy} canReadPacks={!applicant} onchange={(d) => onchange(d)} onleft={ondeleted} />
	{/if}

	{#if editable && !isApplication && !overriding}
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
								{rebaseCheck.skipped === 1 ? "1 change doesn't" : `${rebaseCheck.skipped} changes don't`} apply to that run:
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

{#if editable && overriding && effective}
	<Lazy load={loadOverride}>
		{#snippet children(OverrideEditor)}
			<OverrideEditor
				scenarioName={s.name}
				input={effective}
				loadKey="{s.baseRunId} {s.opsSha256}"
				{saving}
				anonymisedCount={anonymised.size}
				onrecord={addMany}
				onclose={() => {
					overriding = false;
					overrideDirty = false;
				}}
				bind:dirty={overrideDirty}
			/>
		{/snippet}
	</Lazy>
{/if}

{#if applicant}
	<ApplicantResults {projectId} scenarioId={s.id} lastRunId={s.lastRun?.id ?? null} opsSha256={s.opsSha256} />
{:else}
	<ScenarioCompare {projectId} scenario={s} />
{/if}

{#if yieldFarms.length}
	<section class="panel" aria-labelledby="scenario-yield-h">
		<div class="panel-head">
			<h2 id="scenario-yield-h">Yield under this scenario</h2>
		</div>
		<div class="field">
			<label for="scenario-yield-node">Dam</label>
			<select id="scenario-yield-node" bind:value={yieldNodeId}>
				<option value="">Pick a hydrological unit or dam…</option>
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
					<YieldPanel
						{projectId}
						nodeId={yieldNode.id}
						nodeName={yieldNode.name}
						scenarioId={s.id}
						scenario={isApplication || applicant ? null : { baseRunId: s.baseRunId, ops: s.ops, opsSha256: s.opsSha256 }}
						canEdit={canYield}
						hasDam={yieldNode.damCapacityM3 > 0}
					/>
				{/snippet}
			</Lazy>
		{/key}
	{/if}
{/if}

<style>
	.sc-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		margin-bottom: 0.75rem;
	}
	.sc-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
		flex: 1 1 18rem;
		min-width: 0;
	}
	.sc-title h2 {
		margin: 0;
		font-size: 1.15rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	/* The Yield panel keeps the plain panel head. */
	.panel-head {
		justify-content: flex-start;
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
	.override-open {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin: 0.75rem 0;
	}
	.override-open .hint {
		margin: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.run-hint {
		margin-top: -0.4rem;
		text-align: right;
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
		.run-hint {
			text-align: left;
		}
		.owned-list label,
		.rebase summary {
			min-height: var(--tap);
		}
	}
</style>
