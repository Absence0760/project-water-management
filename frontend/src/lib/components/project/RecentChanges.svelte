<!--
	The Project page's recent changes (issue #42): the newest saved changes to the
	model and settings, who made them and when, from the change history
	(GET /projects/:id/history?kind=revision). The History tab has the rest.
	Shown only to members who have the History tab (farmers never do).
-->
<script lang="ts">
	import { api, type HistoryRevision } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { FORMER_MEMBER } from '$lib/components/compare/attribution';
	import { RECENT_CHANGES, recentChange } from './recentChanges';

	let {
		projectId,
		updatedAt,
		saving
	}: {
		projectId: string;
		/** The project's updated_at: a settings or details save changes it. */
		updatedAt: string;
		/** A model save in flight (the save bar): the list reloads once it is done. */
		saving: boolean;
	} = $props();

	let revisions = $state<HistoryRevision[] | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		void updatedAt;
		if (saving) return;
		let current = true;
		api.history
			.list(projectId, { kind: 'revision', limit: RECENT_CHANGES })
			.then((page) => {
				if (!current) return;
				// The baseline is the state before the first recorded change, not a change.
				revisions = page.items.filter((i): i is HistoryRevision => i.type === 'revision' && i.source !== 'baseline');
				error = null;
			})
			.catch((err) => {
				if (current) error = err instanceof Error ? err.message : String(err);
			});
		return () => (current = false);
	});
</script>

<section class="panel" aria-labelledby="recent-changes-h" data-changes-ready={revisions !== null || error !== null ? 'true' : undefined}>
	<div class="panel-head">
		<h2 id="recent-changes-h">Recent changes</h2>
		<a class="small" href="?tab=history">Open the history</a>
	</div>
	{#if error}
		<div class="alert alert-error" role="alert">Couldn’t load the recent changes: {error}</div>
	{:else if revisions === null}
		<p class="muted" aria-busy="true">Loading changes…</p>
	{:else if revisions.length === 0}
		<p class="muted">No changes to the model or settings saved yet.</p>
	{:else}
		<ul class="recent">
			{#each revisions as r (r.id)}
				{@const c = recentChange(r)}
				<li>
					<p class="what"><strong>{c.title}:</strong> {c.first}{#if c.more}{' '}<span class="muted">and {c.more} more</span>{/if}</p>
					<p class="muted small">
						{r.actor ?? FORMER_MEMBER} · <time datetime={r.createdAt}>{fmtDate(r.createdAt, true)}</time>{r.reason ? ` · “${r.reason}”` : ''}
					</p>
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
		gap: 0.6rem;
	}
	.what {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.recent .small {
		margin: 0.1rem 0 0;
	}
</style>
