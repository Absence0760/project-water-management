<script lang="ts">
	// "Add data" from anywhere in the project: the upload form in the app's
	// modal Dialog (focus trapped, Escape closes, focus back on the opener),
	// with the form's buttons in the dialog's action row. While a file is read
	// but not uploaded yet (or uploading), Escape, the close button and Cancel
	// ask before discarding it.
	import type { SeriesMeta } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import UploadForm from './UploadForm.svelte';
	import type { UploadResult, UploadSubmit } from './upload';

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

	let pending = $state(false);
	let submit = $state<UploadSubmit | null>(null);
	let form: { back: () => void } | undefined = $state();

	const DISCARD = 'Discard the file you haven\'t uploaded yet?';
	const mayClose = () => !pending || confirm(DISCARD);
</script>

<Dialog bind:open title="Add data" wide beforeclose={mayClose}>
	<p class="muted lead">
		Upload a CSV of daily rainfall or flow. New days are appended to the matching series; days already stored are corrected where the file
		differs.
	</p>
	{#if open}
		<UploadForm
			bind:this={form}
			{projectId}
			{list}
			{file}
			idPrefix="dlg"
			external
			bind:pending
			bind:submit
			onuploaded={async (r) => {
				await onuploaded?.(r);
				open = false;
			}}
		/>
	{/if}
	{#snippet actions()}
		<!-- One button that turns into Back while the overwrite question shows, so focus stays on it when Back is pressed. -->
		<button
			type="button"
			class="btn"
			disabled={submit?.confirming && submit.disabled}
			onclick={() => (submit?.confirming ? form?.back() : mayClose() && (open = false))}>{submit?.confirming ? 'Back' : 'Cancel'}</button
		>
		<button type="submit" form="dlg-form" class="btn btn-primary" disabled={!submit || submit.disabled}>{submit?.label ?? 'Upload'}</button>
	{/snippet}
</Dialog>

<style>
	.lead {
		font-size: 0.85rem;
		margin: 0 0 0.75rem;
	}
</style>
