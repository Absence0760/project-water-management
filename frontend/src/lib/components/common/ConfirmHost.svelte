<script lang="ts">
	// The one place the app's confirmation questions are shown (confirm.svelte.ts,
	// issue #162 item 21): mounted once in the root layout, so a question can be
	// asked from any page, the farm view included (its callers pass their words
	// translated). One at a time, in the order asked. Cancel comes first and
	// takes the focus, so Enter on a question that destroys something keeps it.
	// Escape answers Cancel. Closing returns focus to what had it (the native
	// dialog does that), usually the button that asked.
	import Dialog from './Dialog.svelte';
	import { answerConfirm, confirmQueue, type ConfirmRequest } from './confirm.svelte';

	let open = $state(false);
	let shown = $state.raw<ConfirmRequest | null>(null);

	$effect(() => {
		const next = confirmQueue.items[0];
		if (next && !shown) {
			shown = next;
			open = true;
		}
	});

	function reply(ok: boolean) {
		const req = shown;
		if (!req) return;
		open = false;
		shown = null;
		answerConfirm(req.id, ok);
	}
</script>

<!-- Always mounted: closing (not removing) the native dialog is what hands focus back. -->
<Dialog bind:open title={shown?.title ?? ''} closeButton={false} alert beforeclose={() => (reply(false), false)}>
	{#if shown?.message}<p class="message" data-testid="confirm-message">{shown.message}</p>{/if}
	{#snippet actions()}
		<button type="button" class="btn" data-testid="confirm-cancel" onclick={() => reply(false)}>{shown?.cancelLabel ?? 'Cancel'}</button>
		<button type="button" class="btn {shown?.danger ? 'btn-danger' : 'btn-primary'}" data-testid="confirm-ok" onclick={() => reply(true)}
			>{shown?.confirmLabel ?? 'OK'}</button
		>
	{/snippet}
</Dialog>

<style>
	.message {
		margin: 0;
		white-space: pre-line;
	}
</style>
