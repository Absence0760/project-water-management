<script lang="ts">
	// The terms a licence is granted on, as the authority's licence gives them
	// (227_licence_terms, issue #523 G3; docs/ui.md § Applications): as applied
	// for, or with changes (the application's changes revised: a smaller
	// volume, an added release rule), and its conditions in words. Used by
	// "Record the authority's decision" and by a variation on appeal
	// (228_decision_events). The server checks the changes against the base
	// run, as an application's own.
	import type { ModelInput, ScenarioOp } from '@water-management/engine';
	import OpForm from './OpForm.svelte';
	import OpList from './OpList.svelte';
	import { opItems, stepInputs } from './ops';

	let {
		idPrefix,
		applied,
		base = null,
		names = new Map(),
		projectId,
		mode = $bindable('as_applied'),
		ops = $bindable([]),
		conditions = $bindable(''),
		disabled = false
	}: {
		/** Unique per form, for the fields' ids. */
		idPrefix: string;
		/** The changes applied for: where "With changes" starts. */
		applied: ScenarioOp[];
		/** The base run's input (to add a change); null when it can't be read. */
		base?: ModelInput | null;
		names?: ReadonlyMap<string, string>;
		projectId: string;
		mode?: 'as_applied' | 'changed';
		/** The changes as licensed, while `mode` is `changed`. */
		ops?: ScenarioOp[];
		conditions?: string;
		disabled?: boolean;
	} = $props();

	const list = $derived(opItems(ops, null, null, base, names));
	const effective = $derived(base ? stepInputs(base, ops).after : null);
	function pick(next: 'as_applied' | 'changed') {
		mode = next;
		if (next === 'changed' && !ops.length) ops = [...applied];
	}
	const add = async (op: ScenarioOp) => {
		ops = [...ops, op];
		return true;
	};
	const removeAt = (i: number) => (ops = ops.filter((_, j) => j !== i));
</script>

<fieldset class="terms" data-testid="{idPrefix}-terms">
	<legend>Granted terms</legend>
	<label><input type="radio" name="{idPrefix}-mode" value="as_applied" checked={mode === 'as_applied'} onchange={() => pick('as_applied')} {disabled} /> As applied for</label>
	<label><input type="radio" name="{idPrefix}-mode" value="changed" checked={mode === 'changed'} onchange={() => pick('changed')} {disabled} /> With changes</label>
	<p class="hint">
		These terms, not the changes applied for, count among the other applications in later cumulative assessments, so the next applicant is assessed against
		the water actually licensed.
	</p>
	{#if mode === 'changed'}
		<div class="changed">
			<p class="hint">Start from the changes applied for: remove what wasn’t granted and add the licence’s own (a smaller volume, a release rule).</p>
			{#if ops.length}
				<OpList items={list.items} other={list.other} label="Granted changes" onremove={removeAt} {disabled} />
			{:else}
				<p class="muted">No changes: the licence grants nothing that changes the model.</p>
			{/if}
			<button type="button" class="btn btn-sm" {disabled} onclick={() => (ops = [...applied])}>Start again from the changes applied for</button>
			{#if effective}
				<!-- A licence's terms are the application's changes revised: the climate is never one of them. -->
				<OpForm input={effective} onadd={add} {disabled} {projectId} futureClimate={false} />
			{:else}
				<p class="muted">The base run can’t be read here, so no change can be added.</p>
			{/if}
		</div>
	{/if}
	<div class="field">
		<label for="{idPrefix}-conditions">Licence conditions <span class="muted">(as the licence words them; optional)</span></label>
		<textarea id="{idPrefix}-conditions" rows="3" maxlength="4000" bind:value={conditions} {disabled}></textarea>
	</div>
</fieldset>

<style>
	.terms {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.75rem;
		display: grid;
		gap: 0.25rem;
	}
	legend {
		font-weight: 500;
		padding: 0 0.25rem;
	}
	.terms > label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: var(--tap, 44px);
	}
	.changed {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.changed :global(ol),
	.changed :global(form) {
		justify-self: stretch;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0;
	}
	textarea {
		width: 100%;
		max-width: 60ch;
		font: inherit;
	}
</style>
