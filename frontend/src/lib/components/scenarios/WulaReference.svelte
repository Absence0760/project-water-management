<!--
	The water-use licence application (WULA) a scenario models (docs/ui.md
	§ Scenarios, "WULA reference"; docs/scenarios.md § The WULA reference;
	294_wula_reference): its number, as the authority gave it, and the works
	as applied for, each a short reference the changes name (the works select
	on each change in the list) and the works in words. Whoever may change the
	scenario writes it (an editor on a team scenario, only its applicant on an
	application), while it is a draft: a submission freezes it with the
	changes. Everyone who reads the scenario reads it. The evidence report
	prints it on page 1 and in Appendix A.2. A fold of the editor's
	Application details card, like the statement.
-->
<script lang="ts">
	import { WULA_NUMBER_MAX, WULA_WORK_REF_MAX, WULA_WORK_TEXT_MAX, WULA_WORKS_MAX, type WulaReference, type WulaWork } from '@water-management/engine';
	import { guardUnsaved } from '#lib/nav/unsaved.js';
	import Fold from '#lib/components/common/Fold.svelte';
	import { leavesScenario } from './leaves';
	import { draftOf, draftProblems, wulaPatch, wulaSummary, type WulaDraft } from './wula';

	let {
		scenarioName,
		wula,
		editable,
		frozen,
		saving,
		onsave
	}: {
		scenarioName: string;
		wula: WulaReference;
		/** The caller may change the scenario and it is a draft. */
		editable: boolean;
		/** Submitted, withdrawn or decided: say why it can't change. */
		frozen: boolean;
		/** A save of the scenario is in flight. */
		saving: boolean;
		/** PATCH what changed; true when saved. */
		onsave: (patch: { wulaNumber?: string | null; wulaWorks?: WulaWork[] }) => Promise<boolean>;
	} = $props();

	const uid = $props.id();
	let editing = $state(false);
	let draft = $state<WulaDraft>({ number: '', works: [] });
	const changes = $derived(wulaPatch(draft, wula));
	const dirty = $derived(editing && Object.keys(changes).length > 0);
	const problems = $derived(editing ? draftProblems(draft) : []);
	let tried = $state(false);

	function start() {
		draft = draftOf(wula);
		if (!draft.works.length) draft.works = [{ ref: 'W1', text: '' }];
		tried = false;
		editing = true;
	}
	function addWorks() {
		draft.works.push({ ref: `W${draft.works.length + 1}`, text: '' });
	}
	function removeWorks(i: number) {
		draft.works.splice(i, 1);
	}
	guardUnsaved({
		dirty: () => dirty,
		what: () => `the WULA reference for “${scenarioName}” not yet saved`,
		leaves: leavesScenario
	});
	async function save(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		if (problems.length) return;
		if (!dirty) {
			editing = false;
			return;
		}
		if (await onsave(changes)) editing = false;
	}
</script>

<Fold name="WULA:" line={wulaSummary(wula)} change={editable ? 'Change' : 'Show'} problem={false} body="none" class="wula" testid="scenario-wula" lineTestid="wula-summary">
	<section class="fold-stack" aria-labelledby="{uid}-h">
		<div class="wula-head">
			<h4 id="{uid}-h">Water-use licence application</h4>
			{#if editable && !editing}
				<button type="button" class="btn btn-sm" disabled={saving} onclick={start}>{wula.number === null && !wula.works.length ? 'Add the WULA reference' : 'Edit the WULA reference'}</button>
			{/if}
		</div>
		<p class="hint explain">
			The application this scenario models, as submitted to the authority: its number and the works it applies for. Name the works each change models in the list
			of changes. The evidence report prints these on page 1 and in Appendix A.2.
		</p>
		{#if frozen}<p class="hint" data-testid="wula-frozen">Frozen with the changes: the reference changes only while the scenario is a draft.</p>{/if}
		{#if editing}
			<form onsubmit={save} aria-label="WULA reference">
				<div class="field">
					<label for="{uid}-number">Application number</label>
					<input id="{uid}-number" type="text" maxlength={WULA_NUMBER_MAX} autocomplete="off" bind:value={draft.number} />
				</div>
				<fieldset>
					<legend>Works as applied for</legend>
					{#each draft.works as w, i (i)}
						<div class="works-row" role="group" aria-label="Works {i + 1}">
							<div class="field ref">
								<label for="{uid}-ref-{i}">Reference</label>
								<input id="{uid}-ref-{i}" type="text" maxlength={WULA_WORK_REF_MAX} autocomplete="off" bind:value={w.ref} />
							</div>
							<div class="field text">
								<label for="{uid}-text-{i}">The works</label>
								<textarea id="{uid}-text-{i}" rows="2" maxlength={WULA_WORK_TEXT_MAX} bind:value={w.text}></textarea>
							</div>
							<button type="button" class="btn btn-sm btn-ghost" aria-label="Remove works {i + 1}" onclick={() => removeWorks(i)}>Remove</button>
						</div>
					{/each}
					{#if draft.works.length < WULA_WORKS_MAX}<button type="button" class="btn btn-sm" onclick={addWorks}>Add works</button>{/if}
				</fieldset>
				{#if tried && problems.length}
					<ul class="problems" role="alert">
						{#each problems as p, i (i)}<li>{p}</li>{/each}
					</ul>
				{/if}
				<div class="toolbar">
					<button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save the WULA reference'}</button>
					<button type="button" class="btn btn-sm" disabled={saving} onclick={() => (editing = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<dl class="wula-view">
				<div data-testid="wula-number">
					<dt>Application number</dt>
					{#if wula.number}<dd>{wula.number}</dd>{:else}<dd class="na">Not given</dd>{/if}
				</div>
				<div data-testid="wula-works">
					<dt>Works as applied for</dt>
					{#if wula.works.length}
						<dd>
							<ul class="works">
								{#each wula.works as w (w.ref)}<li><strong>{w.ref}</strong> <span class="text">{w.text}</span></li>{/each}
							</ul>
						</dd>
					{:else}
						<dd class="na">None listed</dd>
					{/if}
				</div>
			</dl>
		{/if}
	</section>
</Fold>

<style>
	.wula-head {
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
	fieldset {
		border: 0;
		padding: 0;
		margin: 0 0 0.75rem;
		max-width: 80ch;
	}
	legend {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.works-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0 0.75rem;
	}
	.works-row .ref {
		flex: 0 0 8rem;
	}
	.works-row .ref input {
		width: 100%;
	}
	.works-row .text {
		flex: 1 1 16rem;
		min-width: 0;
	}
	textarea {
		width: 100%;
		font: inherit;
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
	.wula-view {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		max-width: 80ch;
	}
	.wula-view dt {
		font-weight: 600;
	}
	.wula-view dd {
		margin: 0.1rem 0 0;
	}
	.works {
		margin: 0;
		padding-left: 1.1rem;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.na {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
