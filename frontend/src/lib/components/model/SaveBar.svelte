<script lang="ts">
	// Sticky footer shared by the Network, Crops and Transfers tabs: unsaved
	// indicator, validation summary, Save / Discard.
	import type { ModelEditor } from '$lib/model/editor.svelte';

	let { editor, onsave, readonly }: { editor: ModelEditor; onsave: () => void; readonly: boolean } = $props();

	const blocking = $derived(editor.issues.length);
</script>

{#if !readonly && (editor.dirty || editor.saveError)}
	<div class="savebar" role="region" aria-label="Unsaved model changes">
		<div class="inner">
			<span class="dot" aria-hidden="true"></span>
			<span class="status" aria-live="polite">
				{#if editor.saving}
					Saving…
				{:else if editor.saveError}
					<span class="err">Save failed: {editor.saveError}</span>
				{:else if blocking}
					Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>
				{:else}
					Unsaved changes to the model
				{/if}
			</span>
			<div class="spacer"></div>
			<button type="button" class="btn" onclick={() => editor.revert()} disabled={editor.saving || !editor.dirty}>
				Discard
			</button>
			<button type="button" class="btn btn-primary" onclick={onsave} disabled={editor.saving || blocking > 0 || !editor.dirty}>
				Save changes
			</button>
		</div>
	</div>
{/if}

<style>
	.savebar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 30;
		background: var(--surface);
		border-top: 1px solid var(--border-strong);
		box-shadow: 0 -2px 8px rgb(0 0 0 / 0.08);
	}
	.inner {
		max-width: 1480px;
		margin: 0 auto;
		padding: 0.6rem var(--gutter);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warning);
	}
	.status {
		font-weight: 500;
	}
	.err {
		color: var(--danger);
	}
	.spacer {
		flex: 1;
	}
</style>
