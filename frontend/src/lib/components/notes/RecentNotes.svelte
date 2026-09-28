<!--
	The Overview's recent notes (WP-2.7): the newest notes across the project,
	each linking to where its target is shown, and the project-level notes
	drawer. Reloads when the shared note counts change (a note added, edited
	or deleted in any drawer).
-->
<script lang="ts">
	import { api, type Note } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { noteCounts } from './counts.svelte';
	import NotesDrawer from './NotesDrawer.svelte';
	import { noteAbout, noteHref } from './notes';

	const RECENT = 8;
	let { projectId }: { projectId: string } = $props();

	let notes = $state<Note[] | null>(null);
	let error = $state<string | null>(null);
	const counts = $derived(noteCounts(projectId));

	$effect(() => {
		void counts.counts; // reload after any change the counts pick up
		api.notes
			.list(projectId, { limit: RECENT })
			.then((n) => {
				notes = n;
				error = null;
			})
			.catch((err) => (error = err instanceof Error ? err.message : String(err)));
	});
</script>

<section class="panel" aria-labelledby="recent-notes-h" data-notes-ready={notes !== null || error !== null ? 'true' : undefined}>
	<div class="panel-head">
		<h2 id="recent-notes-h">Recent notes</h2>
		<NotesDrawer {projectId} target={{ kind: 'project' }} />
	</div>
	{#if error}
		<div class="alert alert-error" role="alert">Couldn’t load the notes: {error}</div>
	{:else if notes === null}
		<p class="muted" aria-busy="true">Loading notes…</p>
	{:else if notes.length === 0}
		<p class="muted">No notes yet. Add one on a hydrological unit in Network, a run, a settings group or the project itself.</p>
	{:else}
		<ul class="recent">
			{#each notes as n (n.id)}
				{@const href = noteHref(n)}
				<li>
					<p class="about">
						{#if href}<a {href}>{noteAbout(n)}</a>{:else}{noteAbout(n)}{/if}
						{#if n.visibility === 'farm'}<span class="badge">Shown to its farmers</span>{/if}
					</p>
					<p class="body">{n.body}</p>
					<p class="muted small">{n.mine ? 'You' : (n.author ?? 'A former member')} · <time datetime={n.createdAt}>{fmtDate(n.createdAt, true)}</time></p>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.about {
		margin: 0;
		font-weight: 500;
		display: flex;
		gap: 0.4rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.body {
		white-space: pre-line;
		overflow-wrap: anywhere;
		margin: 0.1rem 0;
		/* The newest few lines of each; the drawer has the whole note. */
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
</style>
