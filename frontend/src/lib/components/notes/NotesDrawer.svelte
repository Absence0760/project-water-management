<!--
	A notes button with its count badge, opening the notes on one target in a
	side sheet (WP-2.7; docs/ui.md § Notes): on a Network node row, a run's
	Record group and each settings group. The add form sits on top and the
	notes scroll under it, with Close pinned at the foot, so thirty notes never
	push either off the screen. Counts come from the project's shared
	noteCounts, refreshed after any change.
-->
<script lang="ts">
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { noteCounts } from './counts.svelte';
	import NotesList from './NotesList.svelte';
	import { countFor, notesButtonLabel, targetTitle, type NoteTarget } from './notes';

	let {
		projectId,
		target,
		canWrite = true,
		/** Icon and number only (a table row); otherwise "Notes" and the number. */
		compact = false
	}: { projectId: string; target: NoteTarget; canWrite?: boolean; compact?: boolean } = $props();

	let open = $state(false);
	const counts = $derived(noteCounts(projectId));
	const count = $derived(countFor(counts.counts, target));
	const about = $derived(
		target.kind === 'project'
			? 'the project'
			: target.kind === 'node'
				? target.name || 'this node'
				: target.kind === 'run'
					? 'this run'
					: target.kind === 'scenario'
						? `“${target.name}”`
						: target.kind === 'pack'
							? target.name
						: target.label
	);

	$effect(() => {
		counts.ensure();
	});

	// A half-typed note (or an unsaved edit) is lost when the sheet closes:
	// Escape, the close button and Close ask first.
	let unsaved = $state(false);
	const mayClose = async () =>
		!unsaved ||
		(await confirmDialog({
			title: 'Discard your note?',
			message: 'What you typed hasn’t been saved.',
			confirmLabel: 'Discard note',
			cancelLabel: 'Keep editing',
			danger: true
		}));
	async function close() {
		if (await mayClose()) open = false;
	}
</script>

<button
	type="button"
	class="btn btn-sm notes-btn"
	class:compact
	class:empty={count === 0}
	aria-label={notesButtonLabel(count, about)}
	title={notesButtonLabel(count, about)}
	data-note-count={count}
	onclick={() => (open = true)}
>
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
		><path d="M3 2.5h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-3 2.5V11.5H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg
	>
	{#if !compact}<span aria-hidden="true">Notes</span>{/if}
	{#if count > 0}<span class="count" aria-hidden="true">{count}</span>{/if}
</button>

<Dialog bind:open title={targetTitle(target)} side beforeclose={mayClose}>
	{#if open}
		<NotesList {projectId} {target} {canWrite} formFirst bind:unsaved onChanged={() => counts.refresh()} />
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={close}>Close</button>
	{/snippet}
</Dialog>

<style>
	.notes-btn {
		gap: 0.3rem;
	}
	/* A fixed 24 × 24 target in a table row (WCAG 2.5.8); the count sits over
	   its corner so a row with notes is no wider than one without. */
	.notes-btn.compact {
		position: relative;
		flex: none;
		width: 24px;
		min-width: 24px;
		height: 24px;
		min-height: 24px;
		padding: 0;
		justify-content: center;
		border-color: transparent;
		background: transparent;
		color: var(--text-muted);
	}
	.notes-btn.compact:not(.empty) {
		color: var(--accent);
	}
	.count {
		display: inline-block;
		min-width: 1.2em;
		padding: 0 0.3rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.75rem;
		font-weight: 600;
		text-align: center;
	}
	.compact .count {
		position: absolute;
		top: -5px;
		right: -7px;
		min-width: 1.1em;
		padding: 0 0.2rem;
		font-size: 0.65rem;
		line-height: 1.3;
	}
</style>
