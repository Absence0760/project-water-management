<!--
	The mitigation alternatives a scenario cites (docs/ui.md § Scenarios,
	"Alternatives"; docs/scenarios.md § Mitigation alternatives;
	298_scenario_alternatives): up to ALTERNATIVES_MAX runs of the caller's
	own other scenarios on the same base run, each with a label ("smaller
	dam", "winter abstraction only"). The evidence report sets each beside the
	scenario on page 1, a column with its own change against the baseline.
	Whoever may change the scenario picks them (an editor on a team scenario,
	only its applicant on an application), while it is a draft: a submission
	freezes them with the changes. Everyone who reads the scenario reads them.
	A fold of the editor's Application details card, like the WULA reference.
-->
<script lang="ts">
	import { ALTERNATIVES_MAX } from '@water-management/engine';
	import { api, type AlternativeCandidate, type ScenarioAlternative } from '#lib/api/index.js';
	import { guardUnsaved } from '#lib/nav/unsaved.js';
	import Fold from '#lib/components/common/Fold.svelte';
	import { leavesScenario } from './leaves';
	import { ALTERNATIVE_LABEL_MAX, alternativesSummary, cleaned, draftChanged, draftOf, draftProblems, runName, type AlternativeDraft } from './alternatives';

	let {
		projectId,
		scenarioId,
		scenarioName,
		alternatives,
		editable,
		frozen,
		onsaved
	}: {
		projectId: string;
		scenarioId: string;
		scenarioName: string;
		alternatives: ScenarioAlternative[];
		/** The caller may change the scenario and it is a draft. */
		editable: boolean;
		/** Submitted, withdrawn or decided: say why they can't change. */
		frozen: boolean;
		/** The list as saved. */
		onsaved: (list: ScenarioAlternative[]) => void;
	} = $props();

	const uid = $props.id();
	let editing = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let candidates = $state.raw<AlternativeCandidate[]>([]);
	let draft = $state<AlternativeDraft[]>([]);
	let tried = $state(false);
	const dirty = $derived(editing && draftChanged(draft, alternatives));
	const problems = $derived(editing ? draftProblems(draft) : []);
	/** The cited runs stay pickable even if a newer list no longer offers them (a run since trimmed is gone from both). */
	const options = $derived([...candidates, ...alternatives.filter((a) => !candidates.some((c) => c.runId === a.runId))]);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function start() {
		loading = true;
		error = null;
		try {
			candidates = (await api.scenarios.alternatives(projectId, scenarioId)).candidates;
			draft = draftOf(alternatives);
			if (!draft.length) draft = [{ runId: '', label: '' }];
			tried = false;
			editing = true;
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	guardUnsaved({
		dirty: () => dirty,
		what: () => `the alternatives for “${scenarioName}” not yet saved`,
		leaves: leavesScenario
	});
	async function save(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		// A row left empty is no alternative: dropped rather than refused.
		draft = draft.filter((x) => x.runId || x.label.trim());
		if (problems.length) return;
		if (!dirty) {
			editing = false;
			return;
		}
		saving = true;
		error = null;
		try {
			const res = await api.scenarios.setAlternatives(projectId, scenarioId, cleaned(draft));
			candidates = res.candidates;
			onsaved(res.alternatives);
			editing = false;
		} catch (err) {
			error = msg(err);
		} finally {
			saving = false;
		}
	}
</script>

<Fold name="Alternatives:" line={alternativesSummary(alternatives)} change={editable ? 'Change' : 'Show'} problem={false} body="none" class="alternatives" testid="scenario-alternatives" lineTestid="alternatives-summary">
	<section class="fold-stack" aria-labelledby="{uid}-h">
		<div class="alt-head">
			<h4 id="{uid}-h">Mitigation alternatives</h4>
			{#if editable && !editing}
				<button type="button" class="btn btn-sm" disabled={loading} onclick={start}>{alternatives.length ? 'Change the alternatives' : 'Cite alternatives'}</button>
			{/if}
		</div>
		<p class="hint explain">
			The other options you weighed, each a run of another of your scenarios on the same base run, with a label (“smaller dam”, “winter abstraction only”). The
			evidence report sets each beside this one on page 1, with its own change against the baseline. At most {ALTERNATIVES_MAX}.
		</p>
		{#if frozen}<p class="hint" data-testid="alternatives-frozen">Frozen with the changes: the alternatives change only while the scenario is a draft.</p>{/if}
		{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
		{#if editing}
			<form onsubmit={save} aria-label="Mitigation alternatives">
				{#if !options.length}
					<p class="hint" data-testid="alternatives-none">
						None of your other scenarios has a run on this base run yet. Make a scenario for each option, run it, then cite its run here.
					</p>
				{/if}
				{#each draft as a, i (i)}
					<div class="alt-row" role="group" aria-label="Alternative {i + 1}">
						<div class="field run">
							<label for="{uid}-run-{i}">Run</label>
							<select id="{uid}-run-{i}" bind:value={a.runId}>
								<option value="">Pick a run…</option>
								{#each options as c (c.runId)}<option value={c.runId}>{runName(c)}</option>{/each}
							</select>
						</div>
						<div class="field label">
							<label for="{uid}-label-{i}">Label</label>
							<input id="{uid}-label-{i}" type="text" maxlength={ALTERNATIVE_LABEL_MAX} autocomplete="off" bind:value={a.label} />
						</div>
						<button type="button" class="btn btn-sm btn-ghost" aria-label="Remove alternative {i + 1}" onclick={() => draft.splice(i, 1)}>Remove</button>
					</div>
				{/each}
				{#if draft.length < ALTERNATIVES_MAX}<button type="button" class="btn btn-sm add" onclick={() => draft.push({ runId: '', label: '' })}>Add an alternative</button>{/if}
				{#if tried && problems.length}
					<ul class="problems" role="alert">
						{#each problems as p, i (i)}<li>{p}</li>{/each}
					</ul>
				{/if}
				<div class="toolbar">
					<button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save the alternatives'}</button>
					<button type="button" class="btn btn-sm" disabled={saving} onclick={() => (editing = false)}>Cancel</button>
				</div>
			</form>
		{:else if alternatives.length}
			<ol class="alt-list" data-testid="alternatives-list">
				{#each alternatives as a (a.runId)}<li><strong>{a.label}</strong> <span class="muted">{runName(a)}</span></li>{/each}
			</ol>
		{:else}
			<p class="na">None cited</p>
		{/if}
	</section>
</Fold>

<style>
	.alt-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin: 0.5rem 0 0.25rem;
	}
	h4 {
		margin: 0;
		font-size: 0.95rem;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0.5rem;
		max-width: 80ch;
	}
	.field {
		margin-bottom: 0.75rem;
	}
	.field label {
		font-weight: 600;
	}
	.alt-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0 0.75rem;
		max-width: 80ch;
	}
	.alt-row .run {
		flex: 2 1 16rem;
		min-width: 0;
	}
	.alt-row .run select {
		width: 100%;
	}
	.alt-row .label {
		flex: 1 1 12rem;
		min-width: 0;
	}
	.alt-row .label input {
		width: 100%;
	}
	.add {
		margin-bottom: 0.75rem;
	}
	.problems {
		color: var(--warning);
		font-size: 0.85rem;
		margin: 0 0 0.5rem;
	}
	.toolbar {
		display: flex;
		gap: 0.5rem;
	}
	.alt-list {
		margin: 0;
		padding-left: 1.25rem;
		max-width: 80ch;
	}
	.muted {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.na {
		color: var(--text-muted);
		font-style: italic;
		margin: 0;
	}
</style>
