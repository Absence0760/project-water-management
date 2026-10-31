<script lang="ts">
	// The Restriction log (?tab=restrictions, docs/ui.md § Restriction log; the WUA persona's "log of restriction
	// decisions", docs/followups.md): every restriction the WUA published to farmers and every change to its notice,
	// newest first, with when, by whom and on which run, for the members and the responsible authority. Read from the
	// decision log (GET …/restriction-log), which outlives the 12 publications the Publication panel's history keeps.
	// A reading page: it scrolls, 50 decisions at a time. Viewers and above, as the decision log is; farmers read the
	// notice on their farm page.
	import { untrack } from 'svelte';
	import { api, type RestrictionDecision } from '#lib/api/index.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import RestrictionLogList from './RestrictionLogList.svelte';
	import { logContext } from './log';

	let { projectId }: { projectId: string } = $props();

	let items = $state<RestrictionDecision[] | null>(null);
	let next = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let loadingMore = $state(false);
	let moreError = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const page = await api.publication.log(projectId);
			items = page.items;
			next = page.next;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	async function loadMore() {
		if (!next || loadingMore) return;
		loadingMore = true;
		moreError = null;
		try {
			const page = await api.publication.log(projectId, next);
			const seen = new Set((items ?? []).map((d) => d.id));
			items = [...(items ?? []), ...page.items.filter((d) => !seen.has(d.id))];
			next = page.next;
		} catch (e) {
			moreError = e instanceof Error ? e.message : String(e);
		} finally {
			loadingMore = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}<span data-testid="restriction-log-context">{logContext(loading ? null : items)}</span>{/snippet}
{#snippet headerActions()}<a class="btn" href="?tab=runs#res-publication">Publication</a>{/snippet}

<section class="panel" aria-labelledby="restriction-log-h" data-testid="restriction-log">
	<div class="panel-head">
		<div class="head-text">
			<h2 id="restriction-log-h">Restriction decisions</h2>
			<span class="muted small">
				What the water user association published to farmers, when and by whom, and the run each rested on, kept for the life of the
				project. Change the notice, or publish another run, from the Publication panel in Runs &amp; results.
			</span>
		</div>
	</div>
	<LoadState {loading} {error} retry={load}>
		{#if !items?.length}
			<div class="empty-box">
				<p class="empty" data-testid="restriction-log-empty">No restriction decisions yet.</p>
				<p class="small">
					Publishing a run to farmers records the first one, with its restriction level and notice. Publish from the
					<a href="?tab=runs#res-publication">Publication panel</a> in Runs &amp; results.
				</p>
			</div>
		{:else}
			<RestrictionLogList {items} />
			{#if next || moreError}
				<div class="more">
					{#if next}
						<button type="button" class="btn" aria-disabled={loadingMore} onclick={loadMore} data-testid="restriction-log-more">
							{loadingMore ? 'Loading…' : 'Show older decisions'}
						</button>
					{/if}
					{#if moreError}<p class="error small" role="alert">Older decisions couldn’t be loaded: {moreError}</p>{/if}
				</div>
			{/if}
		{/if}
	</LoadState>
</section>

<style>
	.panel {
		margin: 0;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.head-text .small {
		max-width: 75ch;
	}
	.more {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-top: 0.75rem;
	}
	.more .btn {
		min-height: 44px;
	}
	.error {
		margin: 0;
		color: var(--danger);
	}
	.empty-box {
		margin-top: 0.5rem;
		padding: 1.25rem;
		text-align: center;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty {
		margin: 0 0 0.35rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.empty-box .small {
		max-width: 65ch;
		margin: 0 auto;
		color: var(--text-2);
	}
</style>
