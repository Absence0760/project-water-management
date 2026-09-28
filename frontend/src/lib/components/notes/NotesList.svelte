<!--
	The notes on one target (WP-2.7; docs/ui.md § Notes), newest first, with a
	form to add one. Plain text only: the body is rendered with Svelte's
	escaping and `white-space: pre-line`, never as HTML or markdown. Authors
	edit their own notes; the author or an editor deletes (a soft delete).
	`farmer` is the farm view: a farmer's note is always shown to the farm.
	`farmOnly` lists only farm-visible notes: the WUA previewing a farm page
	sees what its farmers see (the API already limits a farmer to those).
	`words`: what a farmer's copy says (./words.ts), English by default; the
	farm card passes the catalogue's, so this list never imports it.
	`formFirst` puts the add form above the notes (the notes drawer, where a
	long list would push it a screen down).
-->
<script lang="ts">
	import { api, NOTE_MAX, type Note } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { bodyProblem, createBody, normaliseBody, targetQuery, type NoteTarget } from './notes';
	import { NOTES_EN, type NotesWords } from './words';

	let {
		projectId,
		target,
		canWrite = true,
		farmer = false,
		farmOnly = false,
		emptyText = 'No notes yet.',
		words = NOTES_EN,
		formFirst = false,
		onChanged
	}: {
		projectId: string;
		target: NoteTarget;
		canWrite?: boolean;
		farmer?: boolean;
		farmOnly?: boolean;
		emptyText?: string;
		words?: NotesWords;
		formFirst?: boolean;
		/** After a note is added, edited or deleted (the count badges refresh). */
		onChanged?: () => void;
	} = $props();

	const uid = $props.id();
	let notes = $state<Note[] | null>(null);
	let loadError = $state<string | null>(null);
	let draft = $state('');
	let shareWithFarm = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let editing = $state<string | null>(null);
	let editDraft = $state('');

	const shown = $derived(notes && farmOnly ? notes.filter((n) => n.visibility === 'farm') : notes);
	const showShare = $derived(!farmer && target.kind === 'node' && target.isFarm);
	const draftLength = $derived(normaliseBody(draft).length);
	const message = (err: unknown) => words.error(err);

	async function load() {
		loadError = null;
		try {
			notes = await api.notes.list(projectId, targetQuery(target));
		} catch (err) {
			loadError = message(err);
		}
	}

	$effect(() => {
		// Reload when the target changes (the drawer is reused across runs).
		void JSON.stringify(targetQuery(target));
		notes = null;
		load();
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const problem = bodyProblem(draft, words);
		if (problem) {
			error = problem;
			return;
		}
		busy = true;
		error = null;
		try {
			const note = await api.notes.create(projectId, createBody(target, draft, farmer || shareWithFarm ? 'farm' : 'team'));
			notes = [note, ...(notes ?? [])];
			draft = '';
			onChanged?.();
		} catch (err) {
			error = message(err);
		} finally {
			busy = false;
		}
	}

	function startEdit(n: Note) {
		editing = n.id;
		editDraft = n.body;
		error = null;
	}

	async function saveEdit(e: SubmitEvent, n: Note) {
		e.preventDefault();
		const problem = bodyProblem(editDraft, words);
		if (problem) {
			error = problem;
			return;
		}
		busy = true;
		error = null;
		try {
			const updated = await api.notes.edit(projectId, n.id, normaliseBody(editDraft));
			notes = (notes ?? []).map((x) => (x.id === n.id ? updated : x));
			editing = null;
			onChanged?.();
		} catch (err) {
			error = message(err);
		} finally {
			busy = false;
		}
	}

	async function remove(n: Note) {
		if (!confirm(words.confirmDelete(n))) return;
		busy = true;
		error = null;
		try {
			await api.notes.remove(projectId, n.id);
			notes = (notes ?? []).filter((x) => x.id !== n.id);
			onChanged?.();
		} catch (err) {
			error = message(err);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet addForm()}
	{#if canWrite}
		<form class="add" onsubmit={add}>
			<label for="{uid}-new">{words.add}</label>
			<textarea id="{uid}-new" rows="3" bind:value={draft} aria-describedby="{uid}-help" aria-invalid={draftLength > NOTE_MAX}></textarea>
			<p id="{uid}-help" class="muted small">
				{words.plainText}
				{#if farmer}{words.farmerAudience}{:else if target.kind === 'node' && target.isFarm}Read by the project team{shareWithFarm ? ' and this hydrological unit’s farmers' : ''}.{:else}Read by the project team; farmers never see it.{/if}
				<span class:over={draftLength > NOTE_MAX}>{draftLength} / {NOTE_MAX}</span>
			</p>
			{#if showShare}
				<label class="check"><input type="checkbox" bind:checked={shareWithFarm} /> Also show to this hydrological unit’s farmers</label>
			{/if}
			<div class="row">
				<button type="submit" class="btn btn-primary btn-sm" disabled={busy || draftLength === 0 || draftLength > NOTE_MAX}>{busy ? words.saving : words.submit}</button>
			</div>
		</form>
	{/if}
	<!-- Under the form, wherever it is, so a failed add shows where it was typed. -->
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
{/snippet}

<div class="notes" class:form-first={formFirst} data-notes-ready={notes !== null || loadError !== null ? 'true' : undefined}>
	{#if formFirst}{@render addForm()}{/if}
	{#if loadError}
		<div class="alert alert-error" role="alert">{words.loadFailed(loadError)}</div>
	{:else if shown === null}
		<p class="muted" aria-busy="true">{words.loading}</p>
	{:else if shown.length === 0}
		<p class="muted">{emptyText}</p>
	{:else}
		<ul class="list" aria-label={words.list}>
			{#each shown as n (n.id)}
				<li class="note">
					{#if editing === n.id}
						<form onsubmit={(e) => saveEdit(e, n)}>
							<label for="{uid}-edit" class="visually-hidden">{words.editLabel}</label>
							<textarea id="{uid}-edit" rows="3" bind:value={editDraft} maxlength={NOTE_MAX + 200}></textarea>
							<div class="row">
								<button type="submit" class="btn btn-primary btn-sm" disabled={busy}>{words.save}</button>
								<button type="button" class="btn btn-sm" onclick={() => (editing = null)}>{words.cancel}</button>
							</div>
						</form>
					{:else}
						<p class="body">{n.body}</p>
					{/if}
					<p class="meta muted">
						<span>{n.mine ? words.you : (n.author ?? words.formerMember)}</span>
						· <time datetime={n.createdAt}>{fmtDate(n.createdAt, true)}</time>
						{#if n.editedAt}<span title={words.editedAt(fmtDate(n.editedAt, true))}>· {words.edited}</span>{/if}
						{#if n.visibility === 'farm' && !farmer}<span class="badge">Shown to its farmers</span>{/if}
						{#if canWrite && editing !== n.id}
							{#if n.mine}<button type="button" class="btn btn-ghost btn-sm" disabled={busy} onclick={() => startEdit(n)}>{words.edit}<span class="visually-hidden">{words.noteFrom(fmtDate(n.createdAt, true))}</span></button>{/if}
							{#if n.canDelete}<button type="button" class="btn btn-ghost btn-sm btn-danger" disabled={busy} onclick={() => remove(n)}>{words.delete}<span class="visually-hidden">{words.noteFrom(fmtDate(n.createdAt, true))}</span></button>{/if}
						{/if}
					</p>
				</li>
			{/each}
		</ul>
	{/if}

	{#if !formFirst}{@render addForm()}{/if}
</div>

<style>
	.list {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		display: grid;
		gap: 0.6rem;
	}
	.note {
		border-left: 3px solid var(--border-strong);
		padding: 0.2rem 0 0.2rem 0.7rem;
	}
	.body {
		/* Keeps the writer's line breaks; the text itself is escaped by Svelte. */
		white-space: pre-line;
		overflow-wrap: anywhere;
		margin: 0 0 0.2rem;
		max-width: 80ch;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		margin: 0;
		font-size: 0.85rem;
	}
	textarea {
		width: 100%;
		max-width: 80ch;
		font: inherit;
	}
	.add label:first-child {
		font-weight: 500;
		display: block;
		margin-bottom: 0.25rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.25rem 0 0.5rem;
	}
	/* The form on top, the notes under it with a rule between. */
	.form-first .add {
		padding-top: 0.5rem;
		padding-bottom: 1rem;
		margin-bottom: 1rem;
		border-bottom: 1px solid var(--border);
	}
	.form-first .list {
		margin-bottom: 0;
	}
	.row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.3rem;
	}
	.small {
		font-size: 0.85rem;
		margin: 0.2rem 0;
	}
	.over {
		color: var(--danger);
		font-weight: 500;
	}
</style>
