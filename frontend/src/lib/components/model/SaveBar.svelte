<script lang="ts">
	// The workspace's one sticky footer for unsaved edits: the model's (the
	// Network, Crops and Transfers tabs, the farm drawer, a grid) and the
	// project details (the Project page, issue #162 item 12). Unsaved
	// indicator, validation summary, the optional reason for a model change
	// (kept with it in the History tab), Preview of the model's edits against
	// the last run (issue #284), Save / Discard for everything unsaved.
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import type { ProjectDetailsDraft } from '$lib/components/project/detailsDraft.svelte';

	let {
		editor,
		details = null,
		onsave,
		readonly,
		height = $bindable(0),
		reason = $bindable(''),
		onpreview = null
	}: {
		editor: ModelEditor;
		/** The project details being edited, saved and discarded with the model's edits. */
		details?: ProjectDetailsDraft | null;
		/** Save everything unsaved. */
		onsave: () => void;
		readonly: boolean;
		/** Rendered height (0 when hidden), so the page can keep content clear of it. */
		height?: number;
		/** The optional "why" sent with a model save (at most 500 characters). */
		reason?: string;
		/** Preview what the unsaved model edits do to the last run (issue #284); null hides the button. */
		onpreview?: (() => void) | null;
	} = $props();

	const detailsDirty = $derived(!!details?.dirty);
	const dirty = $derived(editor.dirty || detailsDirty);
	const saving = $derived(editor.saving || !!details?.saving);
	const saveError = $derived(editor.saveError ?? details?.saveError ?? null);
	const shown = $derived(!readonly && (dirty || !!saveError));
	let measured = $state(0);
	$effect(() => {
		height = shown ? measured : 0;
	});

	const detailProblems = $derived(detailsDirty ? (details?.problems ?? []) : []);
	const blocking = $derived((editor.dirty ? editor.issues.length : 0) + detailProblems.length);
	/** What the unsaved edits are to. */
	const what = $derived(editor.dirty && detailsDirty ? 'the model and the project details' : detailsDirty ? 'the project details' : 'the model');
	function discard() {
		editor.revert();
		details?.revert();
		reason = '';
	}
</script>

{#if shown}
	<div class="savebar" role="region" aria-label={editor.dirty || !detailsDirty ? 'Unsaved model changes' : 'Unsaved project details'} bind:offsetHeight={measured}>
		<div class="inner">
			<span class="dot" aria-hidden="true"></span>
			<span class="status" aria-live="polite">
				{#if saving}
					Saving…
				{:else if saveError}
					<span class="err">Save failed: {saveError}</span>
				{:else if detailProblems.length === 1 && blocking === 1}
					Unsaved changes · <span class="err">{detailProblems[0]}</span>
				{:else if blocking}
					Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>
				{:else}
					Unsaved changes to {what}{#if editor.dirty && !detailsDirty}{' '}<span class="muted where">(network, crops and transfers)</span>{/if}
				{/if}
			</span>
			<div class="spacer"></div>
			<!-- The reason goes with the model's save (the History tab keeps it). -->
			{#if editor.dirty}
				<label class="reason">
					<span class="visually-hidden">Reason for this change (optional)</span>
					<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={saving} />
				</label>
			{/if}
			<!-- The model's edits only, so it waits until they have no problems the engine would refuse. -->
			{#if editor.dirty && onpreview}
				<button type="button" class="btn" onclick={onpreview} disabled={saving || editor.issues.length > 0}>Preview</button>
			{/if}
			<button type="button" class="btn" onclick={discard} disabled={saving || !dirty}>Discard</button>
			<button type="button" class="btn btn-primary" onclick={onsave} disabled={saving || blocking > 0 || !dirty}>Save changes</button>
		</div>
	</div>
{/if}

<style>
	.savebar {
		position: fixed;
		/* Beside the app sidebar, not over its foot (the account menu); 0 on a phone (AppShell's --sidebar-w). */
		left: var(--sidebar-w, 0px);
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
