<script lang="ts">
	// The one place the app's confirmation questions are shown (confirm.svelte.ts,
	// issue #162 item 21): mounted once in the root layout, so a question can be
	// asked from any page, the farm view included (its callers pass their words
	// translated). One at a time, in the order asked. Cancel comes first and
	// takes the focus, so Enter on a question that destroys something keeps it.
	// Escape answers Cancel. Closing returns focus to what had it (the native
	// dialog does that), usually the button that asked. A question with an
	// `option` shows its checkbox, unticked each time, with its list and note.
	import Dialog from './Dialog.svelte';
	import { answerConfirm, confirmQueue, type ConfirmRequest } from './confirm.svelte';

	let open = $state(false);
	let shown = $state.raw<ConfirmRequest | null>(null);
	let ticked = $state(false);
	const uid = $props.id();

	$effect(() => {
		const next = confirmQueue.items[0];
		if (next && !shown) {
			shown = next;
			ticked = false;
			open = true;
		}
	});

	function reply(ok: boolean) {
		const req = shown;
		if (!req) return;
		open = false;
		shown = null;
		answerConfirm(req.id, ok, ticked);
	}
</script>

<!-- Always mounted: closing (not removing) the native dialog is what hands focus back. -->
<Dialog bind:open title={shown?.title ?? ''} closeButton={false} alert beforeclose={() => (reply(false), false)}>
	{#if shown?.message}<p class="message" data-testid="confirm-message">{shown.message}</p>{/if}
	{#if shown?.option}
		{@const opt = shown.option}
		<div class="option" data-testid="confirm-option">
			<label>
				<input type="checkbox" bind:checked={ticked} aria-describedby={opt.items?.length || opt.note ? `${uid}-opt` : undefined} />
				<span>{opt.label}</span>
			</label>
			{#if opt.items?.length || opt.note}
				<div id="{uid}-opt" class="detail">
					{#if opt.items?.length}<ul>{#each opt.items as item, i (i)}<li>{item}</li>{/each}</ul>{/if}
					{#if opt.note}<p>{opt.note}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}
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
	.option {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.75rem;
	}
	.option label {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		font-weight: 500;
	}
	.detail {
		margin-left: 1.5rem;
		font-size: 0.9rem;
		color: var(--text-2);
	}
	.detail ul {
		margin: 0;
		padding-left: 1.1rem;
		font-variant-numeric: tabular-nums;
	}
	.detail p {
		margin: 0.35rem 0 0;
	}
</style>
