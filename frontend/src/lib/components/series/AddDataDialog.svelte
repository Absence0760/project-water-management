<script lang="ts">
	// "Add data" from anywhere in the project: the upload form in the app's
	// modal Dialog (focus trapped, Escape closes, focus back on the opener),
	// with the form's buttons in the dialog's action row. While a file is read
	// but not uploaded yet, Escape, the close button and Cancel ask before
	// discarding it, and so does a second file dropped on the page. While it
	// uploads they do nothing (Cancel is disabled): the request would finish
	// anyway, and the page reports it.
	import { untrack } from 'svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
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
	const uploading = $derived(!!submit?.uploading);

	const mayClose = async () =>
		!uploading &&
		(!pending ||
			(await confirmDialog({
				title: 'Discard the file?',
				message: "You haven't uploaded it yet.",
				confirmLabel: 'Discard file',
				cancelLabel: 'Keep it',
				danger: true
			})));

	// The file the form reads. A file dropped while another is read but not uploaded asks first, as
	// closing does; one dropped while uploading is ignored (the upload is the file's answer).
	let formFile = $state.raw<File | null>(untrack(() => file));
	$effect(() => {
		const f = file;
		untrack(() => void offer(f));
	});
	async function offer(f: File | null) {
		if (f === formFile) return;
		if (f && open && (uploading || (pending && !(await askReplace())))) return;
		formFile = f;
	}
	const askReplace = () =>
		confirmDialog({
			title: 'Replace the file?',
			message: "The file you picked first hasn't been uploaded yet.",
			confirmLabel: 'Use the new file',
			cancelLabel: 'Keep the first',
			danger: true
		});
	// Closed, nothing is pending: the form goes, and the next opening starts empty.
	$effect(() => {
		if (!open) untrack(() => (pending = false));
	});
</script>

<Dialog bind:open title="Add data" wide beforeclose={mayClose}>
	<p class="muted lead">
		Upload a CSV (or a DWS export) of daily rainfall, flow or evaporation. New days are appended to the matching series; days already stored are
		corrected where the file differs.
	</p>
	{#if open}
		<UploadForm
			bind:this={form}
			{projectId}
			{list}
			file={formFile}
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
			disabled={uploading || (submit?.confirming && submit.disabled)}
			onclick={async () => (submit?.confirming ? form?.back() : (await mayClose()) && (open = false))}>{submit?.confirming ? 'Back' : 'Cancel'}</button
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
