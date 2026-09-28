<script lang="ts">
	// The save row of a modal over the workspace (the farm drawer, the grid
	// modal): a modal makes the page's fixed save bar unreachable, so it carries
	// the same controls. Status, the optional reason (the save bar's own value,
	// bound through), Discard (as the save bar's), Save changes (the page's
	// save) and Done, which closes and leaves any edit for the save bar.
	import type { ModelEditor } from '$lib/model/editor.svelte';

	let {
		editor,
		onsave,
		ondone,
		reason = $bindable('')
	}: {
		editor: ModelEditor;
		onsave: () => void;
		ondone: () => void;
		reason?: string;
	} = $props();

	const blocking = $derived(editor.issues.length);
</script>

<div class="save">
	<p class="status small" aria-live="polite">
		{#if editor.saving}
			Saving…
		{:else if editor.saveError}
			<span class="err">Save failed: {editor.saveError}</span>
		{:else if editor.dirty && blocking}
			Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>
		{:else if editor.dirty}
			Unsaved changes to the model
		{:else}
			<span class="muted">No unsaved changes</span>
		{/if}
	</p>
	{#if editor.dirty}
		<label class="reason">
			<span class="visually-hidden">Reason for this change (optional)</span>
			<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={editor.saving} />
		</label>
	{/if}
	<div class="buttons">
		<button type="button" class="btn" onclick={() => { editor.revert(); reason = ''; }} disabled={editor.saving || !editor.dirty}>Discard</button>
		<button type="button" class="btn" onclick={ondone}>Done</button>
		<button type="button" class="btn btn-primary" onclick={onsave} disabled={editor.saving || blocking > 0 || !editor.dirty}>Save changes</button>
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
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
