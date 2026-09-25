<script lang="ts">
	// "Add data" from anywhere in the project: the upload form in a modal
	// <dialog> (focus trapped, Escape closes, focus returns to the opener).
	// While a file is read but not uploaded yet (or uploading), Escape and ✕
	// ask before discarding it.
	import type { SeriesMeta } from '@water-management/engine';
	import UploadForm from './UploadForm.svelte';
	import type { UploadResult } from './upload';

	let {
		open = $bindable(false),
		projectId,
		list,
		file = null,
		onuploaded
	}: {
		open?: boolean;
		projectId: string;
		list: SeriesMeta[];
		file?: File | null;
		onuploaded?: (r: UploadResult) => void | Promise<void>;
	} = $props();

	let el: HTMLDialogElement | undefined = $state();
	let opener: Element | null = null;
	let pending = $state(false);

	const DISCARD = 'Discard the file you haven\'t uploaded yet?';

	function requestClose() {
		if (!pending || confirm(DISCARD)) open = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		// Handle Escape ourselves so the native cancel can't skip the check.
		e.preventDefault();
		requestClose();
	}

	$effect(() => {
		if (!el) return;
		if (open && !el.open) {
			opener = document.activeElement;
			el.showModal();
		} else if (!open && el.open) el.close();
	});

	function onClose() {
		open = false;
		(opener as HTMLElement | null)?.focus?.();
	}
</script>

<dialog bind:this={el} aria-labelledby="add-data-h" onclose={onClose} onkeydown={onKeydown}>
	<div class="head">
		<h2 id="add-data-h">Add data</h2>
		<button type="button" class="btn btn-ghost close" aria-label="Close" onclick={requestClose}>✕</button>
	</div>
	<p class="muted lead">
		Upload a CSV of daily rainfall or flow. New days are appended to the matching series; days already stored are corrected
		where the file differs.
	</p>
	{#if open}
		<UploadForm
			{projectId}
			{list}
			{file}
			idPrefix="dlg"
			bind:pending
			onuploaded={async (r) => {
				await onuploaded?.(r);
				open = false;
			}}
		/>
	{/if}
</dialog>

<style>
	dialog {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 1.1rem 1.25rem 1.25rem;
		/* As Dialog.svelte: 100 % of the viewport, not 100vw (a classic scrollbar), and no browser cap. */
		max-width: none;
		width: min(560px, calc(100% - 2 * var(--gutter)));
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.4);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.head h2 {
		margin: 0;
	}
	.close {
		min-width: 40px;
		min-height: 40px;
		justify-content: center;
	}
	.lead {
		font-size: 0.85rem;
		margin: 0.4rem 0 0.75rem;
	}
</style>
