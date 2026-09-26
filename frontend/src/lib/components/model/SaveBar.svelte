<script lang="ts">
	// Sticky footer shared by the Network, Crops and Transfers tabs: unsaved
	// indicator, validation summary, the optional reason for the change (kept
	// with it in the History tab), Save / Discard.
	import type { ModelEditor } from '$lib/model/editor.svelte';

	let {
		editor,
		onsave,
		readonly,
		height = $bindable(0),
		reason = $bindable('')
	}: {
		editor: ModelEditor;
		onsave: () => void;
		readonly: boolean;
		/** Rendered height (0 when hidden), so the page can keep content clear of it. */
		height?: number;
		/** The optional "why" sent with the save (at most 500 characters). */
		reason?: string;
	} = $props();

	const shown = $derived(!readonly && (editor.dirty || !!editor.saveError));
	let measured = $state(0);
	$effect(() => {
		height = shown ? measured : 0;
	});

	const blocking = $derived(editor.issues.length);
</script>

{#if shown}
	<div class="savebar" role="region" aria-label="Unsaved model changes" bind:offsetHeight={measured}>
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
					Unsaved changes to the model <span class="muted where">(network, crops and transfers)</span>
				{/if}
			</span>
			<div class="spacer"></div>
			<label class="reason">
				<span class="visually-hidden">Reason for this change (optional)</span>
				<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={editor.saving} />
			</label>
			<button type="button" class="btn" onclick={() => { editor.revert(); reason = ''; }} disabled={editor.saving || !editor.dirty}>
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
	.where {
		font-weight: 400;
	}
	.reason {
		flex: 0 1 22rem;
		min-width: 12rem;
	}
	.reason input {
		width: 100%;
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
		.where {
			display: none;
		}
		.reason {
			flex-basis: 100%;
		}
		.reason input {
			min-height: 44px;
		}
	}
</style>
