<script lang="ts">
	// The save row of a modal over the workspace (the farm drawer, the grid
	// modal, the node and crop sheets): a modal makes the page's fixed save bar
	// unreachable, so it carries the model's part of it. Status, the problems
	// that block the save as links to where they are fixed (a sheet's own list
	// can't show them: the page's is behind the modal), the optional reason
	// (the save bar's own value, bound through), Discard model changes (every
	// unsaved model edit, on any page, not only this modal's: it asks first,
	// naming them), Save changes (the page's model save) and Done, which
	// closes and leaves any edit for the save bar. The project details stay
	// with the save bar, which saves and discards them.
	import { tick } from 'svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { useInvalidFields } from '$lib/components/common/invalidFields.svelte';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { issueHref, type ModelIssue } from '$lib/model/validate';
	import { listAnd } from '$lib/nav/unsaved';
	import { AREA_WORDS, changedAreas } from './changedAreas';
	import ProblemLinks from './ProblemLinks.svelte';

	let {
		editor,
		onsave,
		ondone,
		reason = $bindable(''),
		listed = null
	}: {
		editor: ModelEditor;
		onsave: () => unknown;
		ondone: () => void;
		reason?: string;
		/** An area whose problems the modal already lists above the row (the grid modal's IssueList): the row links the rest. */
		listed?: ModelIssue['area'] | null;
	} = $props();
	// The nearest owner's registry of invalid fields (the workspace page, or a scenario's override mode).
	const invalidFields = useInvalidFields();

	const uid = $props.id();
	// Number fields holding text they can't take (common/invalidFields) block the save too, and Discard puts them back.
	const invalid = $derived(invalidFields.fields);
	const dirty = $derived(editor.dirty || invalid.length > 0);
	const blocking = $derived(editor.issues.length + invalid.length);
	const linked = $derived([
		...editor.issues.filter((i) => i.area !== listed).map((i) => ({ message: i.message, href: issueHref(i) })),
		...invalid.map((f) => ({ message: f.label ? `${f.label}: ${f.message}` : f.message, href: `#${f.id}` }))
	]);
	const areas = $derived(editor.dirty ? changedAreas(editor.savedModel(), editor.model) : []);
	/** Set after this row's save or discard, until the next edit: the status says so. */
	let settled = $state<string | null>(null);
	$effect(() => {
		if (dirty) settled = null;
	});
	let doneBtn: HTMLButtonElement | undefined = $state();

	async function save() {
		await onsave();
		if (editor.dirty || editor.saveError) return;
		invalidFields.reset();
		settled = 'Changes saved.';
		// Save changes is disabled now, and a disabled button drops the keyboard's focus: keep it in the row.
		await tick();
		doneBtn?.focus();
	}

	async function discard() {
		const ok = await confirmDialog({
			title: 'Discard all unsaved model changes?',
			message: `Your unsaved changes to ${listAnd([...(areas.length ? areas.map((a) => AREA_WORDS[a]) : editor.dirty ? ['the model'] : []), ...(invalid.length ? ['the numbers that need fixing'] : [])])} will be lost, including any made on other pages before this one opened. This can’t be undone.`,
			confirmLabel: 'Discard changes',
			danger: true
		});
		if (!ok) return;
		editor.revert();
		invalidFields.reset();
		reason = '';
		settled = 'Changes discarded.';
		await tick();
		doneBtn?.focus();
	}
</script>

<div class="save">
	<p class="status small" aria-live="polite">
		{#if editor.saving}
			Saving…
		{:else if editor.saveError}
			<span class="err">Save failed: {editor.saveError}</span>
		{:else if dirty && blocking}
			Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>{#if listed && linked.length < blocking}{' '}<span class="muted">(listed above{linked.length ? ' and below' : ''})</span>{/if}
		{:else if editor.dirty}
			Unsaved changes to the model{#if areas.length}{' '}<span class="muted">({listAnd(areas)})</span>{/if}
		{:else}
			{#if settled}{settled}{' '}{/if}<span class="muted">No unsaved changes</span>
		{/if}
	</p>
	{#if dirty && blocking && !editor.saving}
		<ProblemLinks problems={linked} id="{uid}-problems" />
	{/if}
	{#if editor.dirty}
		<label class="reason">
			<span class="visually-hidden">Reason for this change (optional)</span>
			<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={editor.saving} />
		</label>
	{/if}
	<div class="buttons">
		<button type="button" class="btn" onclick={discard} disabled={editor.saving || !dirty}>Discard model changes</button>
		<button type="button" class="btn" onclick={ondone} bind:this={doneBtn}>Done</button>
		<button
			type="button"
			class="btn btn-primary"
			onclick={save}
			disabled={editor.saving || blocking > 0 || !editor.dirty}
			aria-describedby={dirty && blocking && linked.length ? `${uid}-problems` : undefined}>Save changes</button
		>
	</div>
</div>

<style>
	.save {
		display: grid;
		gap: 0.5rem;
		width: 100%;
	}
	.status {
		margin: 0;
	}
	.err {
		color: var(--danger);
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
