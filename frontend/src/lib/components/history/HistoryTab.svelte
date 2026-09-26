<!--
	The History tab (WP-2.4, docs/ui.md § History): who changed what, when and
	why, newest first and grouped by the viewer's day, with "Restore this
	version" for editors. Viewers read it; farmers never reach it (the
	workspace sends them to their farm page, and the API refuses them).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { InputChange } from '@water-management/engine';
	import { api, ApiError, type HistoryItem, type HistoryRevision, type Relink } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { filterEntries, groupByChangeSet, groupByDay, itemLines, KIND_FILTERS, localDay, localTime, revisionTitle, seriesRestore } from './timeline';

	let {
		projectId,
		editor,
		canEdit,
		onRestored,
		onSeriesRestored
	}: {
		projectId: string;
		/** The model as the page holds it: the farm filter's farms, and whether there are unsaved edits. */
		editor: ModelEditor;
		canEdit: boolean;
		/** A restore changed the saved model and settings: reload them. */
		onRestored: () => Promise<void>;
		/** A series' earlier values were put back: reload the series list. */
		onSeriesRestored?: () => Promise<void>;
	} = $props();

	const uid = $props.id();
	const REASON_MAX = 500;

	let items = $state<HistoryItem[]>([]);
	let next = $state<string | null>(null);
	let since = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);

	let nodeId = $state('');
	let kind = $state('');
	let query = $state('');

	const farms = $derived(editor.model.nodes.filter((n) => n.kind === 'farm'));
	const entries = $derived(filterEntries(groupByChangeSet(items), query));
	const days = $derived(groupByDay(entries));

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	let loadSeq = 0;
	async function load(more = false) {
		const seq = ++loadSeq;
		if (more) loadingMore = true;
		else loading = true;
		error = null;
		try {
			const page = await api.history.list(projectId, {
				limit: 50,
				...(more && next ? { before: next } : {}),
				...(nodeId ? { nodeId } : {}),
				...(kind ? { kind } : {})
			});
			if (seq !== loadSeq) return;
			items = more ? [...items, ...page.items] : page.items;
			next = page.next;
			since = page.historySince;
		} catch (e) {
			if (seq === loadSeq) error = msg(e);
		} finally {
			if (seq === loadSeq) loading = loadingMore = false;
		}
	}
	// The farm and kind filters are the server's; the parameter filter narrows what's loaded.
	$effect(() => {
		void nodeId;
		void kind;
		untrack(() => load());
	});

	// --- Restore this version ---------------------------------------------------
	let confirmOpen = $state(false);
	let target = $state<HistoryRevision | null>(null);
	let preview = $state<InputChange[] | null>(null);
	let previewError = $state<string | null>(null);
	let reason = $state('');
	let restoring = $state(false);
	let restoreError = $state<string | null>(null);
	let restored = $state<{ at: string; relink: Relink[] } | null>(null);

	async function askRestore(r: HistoryRevision) {
		target = r;
		preview = null;
		previewError = null;
		restoreError = null;
		reason = '';
		confirmOpen = true;
		try {
			const d = await api.history.revision(projectId, r.id);
			if (target?.id === r.id) preview = d.preview;
		} catch (e) {
			if (target?.id === r.id) previewError = msg(e);
		}
	}

	async function restore() {
		if (!target) return;
		restoring = true;
		restoreError = null;
		try {
			const res = await api.history.restore(projectId, target.id, reason.trim() || undefined);
			confirmOpen = false;
			restored = { at: target.createdAt, relink: res.relink };
			await onRestored();
			await load();
		} catch (e) {
			restoreError = msg(e);
		} finally {
			restoring = false;
		}
	}

	// --- Restore a series' earlier values ---------------------------------------
	type SeriesTarget = NonNullable<ReturnType<typeof seriesRestore>> & { at: string };
	let seriesOpen = $state(false);
	let seriesTarget = $state<SeriesTarget | null>(null);
	let seriesRestoring = $state(false);
	let seriesError = $state<string | null>(null);
	let seriesDone = $state<string | null>(null);

	function askSeriesRestore(t: SeriesTarget) {
		seriesTarget = t;
		seriesError = null;
		seriesOpen = true;
	}

	async function restoreSeriesValues() {
		const t = seriesTarget;
		if (!t) return;
		seriesRestoring = true;
		seriesError = null;
		try {
			await api.history.restoreSeries(projectId, t.seriesId, t.revisionId);
			seriesOpen = false;
			seriesDone = `Put back the values of ${t.what} from before the change of ${fmtDate(t.at, true)}.`;
			await onSeriesRestored?.();
			await load();
		} catch (e) {
			seriesError =
				e instanceof ApiError && e.status === 404
					? 'Those values are no longer kept: a series keeps its newest 5 earlier versions, for up to 180 days.'
					: msg(e);
		} finally {
			seriesRestoring = false;
		}
	}
</script>

<!-- A plain panel, not a second region: the tab body is already the region
     named "History" (a same-named landmark inside it is axe landmark-unique). -->
<div class="panel">
	<div class="head">
		<h2 id="{uid}-h">History</h2>
		<p class="muted small">
			Every change to the model, settings, data, members and publication, with who made it and why.
			{#if canEdit}Restoring a version saves it as a new change: nothing is ever erased.{/if}
		</p>
	</div>

	<div class="filters" role="group" aria-label="Filter the history">
		<div class="field">
			<label for="{uid}-farm">Farm</label>
			<select id="{uid}-farm" bind:value={nodeId}>
				<option value="">All farms</option>
				{#each farms as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="{uid}-kind">Kind of change</label>
			<select id="{uid}-kind" bind:value={kind}>
				{#each KIND_FILTERS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
			</select>
		</div>
		<div class="field grow">
			<label for="{uid}-q">Parameter</label>
			<input id="{uid}-q" type="search" placeholder="e.g. dam capacity" bind:value={query} autocomplete="off" />
		</div>
	</div>

	{#if restored}
		<div class="alert alert-success-ish" role="status">
			<p>Restored the version of {fmtDate(restored.at, true)}. The model and settings are as they were then; run the model again to update the results.</p>
			{#if restored.relink.length}
				<p>Farmers aren't linked back automatically. Re-link them on the Summary tab's farmers list:</p>
				<ul>
					{#each restored.relink as r (r.userId + r.nodeId)}<li>{r.displayName} to {r.nodeName}</li>{/each}
				</ul>
			{/if}
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (restored = null)}>Dismiss</button>
		</div>
	{/if}
	{#if seriesDone}
		<div class="alert alert-success-ish" role="status">
			<p>{seriesDone} Run the model again to use them.</p>
			<button type="button" class="btn btn-ghost btn-sm" onclick={() => (seriesDone = null)}>Dismiss</button>
		</div>
	{/if}

	<LoadState {loading} {error} retry={() => load()}>
		{#if days.length === 0}
			<p class="empty" data-testid="history-empty">
				{#if items.length || nodeId || kind}
					Nothing matches these filters.
				{:else}
					No changes recorded yet. History starts from {since ? fmtDay(localDay(since)) : 'now'}.
				{/if}
			</p>
		{:else}
			<ol class="days">
				{#each days as d (d.day)}
					<li>
						<h3 class="day">{d.label}</h3>
						<ol class="entries">
							{#each d.entries as e (e.key)}
								<li class="entry" data-testid="history-entry">
									<div class="meta">
										<time datetime={e.createdAt}>{localTime(e.createdAt)}</time>
										<span class="who">{e.actor ?? 'A deleted account'}</span>
									</div>
									<div class="what">
										{#each e.items as i (i.type + i.id)}
											{#if i.type === 'revision'}
												<p class="title">{revisionTitle(i)}</p>
												<ul class="lines">
													{#each itemLines(i) as line, n (n)}<li>{line}</li>{/each}
												</ul>
												{#if i.reason}<p class="reason"><span class="muted">Reason:</span> {i.reason}</p>{/if}
											{:else}
												{@const sr = canEdit ? seriesRestore(i) : null}
												<p class="event">{itemLines(i)[0]}</p>
												{#if sr}
													<button type="button" class="btn btn-sm restore" onclick={() => askSeriesRestore({ ...sr, at: i.createdAt })}>
														Restore the earlier values
													</button>
												{/if}
											{/if}
										{/each}
										{#if canEdit && e.revision}
											<button
												type="button"
												class="btn btn-sm restore"
												onclick={() => askRestore(e.revision!)}
												disabled={editor.dirty}
												title={editor.dirty ? 'Save or discard your unsaved model changes first' : undefined}
											>
												Restore this version
											</button>
										{/if}
									</div>
								</li>
							{/each}
						</ol>
					</li>
				{/each}
			</ol>
			{#if next}
				<button type="button" class="btn more" onclick={() => load(true)} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older changes'}</button>
			{/if}
		{/if}
	</LoadState>
	{#if canEdit && editor.dirty}
		<p class="muted small" role="note">You have unsaved model changes: save or discard them before restoring a version.</p>
	{/if}
</div>

<Dialog bind:open={confirmOpen} title="Restore this version?" wide>
	{#if target}
		<p>
			The model and settings go back to how they were after the change of {fmtDate(target.createdAt, true)}{target.actor ? ` by ${target.actor}` : ''}.
			This is saved as a new change, so it can be undone the same way.
		</p>
		<h3 class="small-h">What restoring changes</h3>
		{#if previewError}
			<div class="alert alert-error" role="alert">{previewError}</div>
		{:else if preview === null}
			<p class="muted" role="status">Working out what changes…</p>
		{:else if preview.length === 0}
			<p class="muted">The saved inputs already match this version{target.changes.length ? '' : ' in everything the change list describes'}.</p>
		{:else}
			<ChangesList changes={preview} />
		{/if}
		<p class="muted small">Series values aren't part of a version: restore them from their own entries here (“Restore the earlier values”). A restored farm comes back without its farmer links.</p>
		<div class="field">
			<label for="{uid}-reason">Reason for restoring <span class="muted">(optional)</span></label>
			<input id="{uid}-reason" maxlength={REASON_MAX} bind:value={reason} placeholder="e.g. the new dam survey was wrong" />
		</div>
		{#if restoreError}<div class="alert alert-error" role="alert">{restoreError}</div>{/if}
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (confirmOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" onclick={restore} disabled={restoring || preview === null || preview.length === 0}>
			{restoring ? 'Restoring…' : 'Restore'}
		</button>
	{/snippet}
</Dialog>

<Dialog bind:open={seriesOpen} title="Restore the earlier values?">
	{#if seriesTarget}
		<p>
			{seriesTarget.what[0]!.toUpperCase() + seriesTarget.what.slice(1)} goes back to the values it held before the change of {fmtDate(seriesTarget.at, true)}.
			The values it holds now are kept too, so this can be undone the same way.
		</p>
		<p class="muted small">Runs already made keep the data they used.</p>
		{#if seriesError}<div class="alert alert-error" role="alert">{seriesError}</div>{/if}
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (seriesOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" onclick={restoreSeriesValues} disabled={seriesRestoring}>
			{seriesRestoring ? 'Restoring…' : 'Restore values'}
		</button>
	{/snippet}
</Dialog>

<style>
	.head h2 {
		margin: 0 0 0.25rem;
	}
	.head p {
		margin: 0 0 0.75rem;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1rem;
		align-items: flex-end;
		margin-bottom: 1rem;
	}
	.filters .field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 11rem;
	}
	.filters .grow {
		flex: 1;
		min-width: 12rem;
	}
	.days,
	.entries,
	.lines {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.day {
		margin: 1rem 0 0.4rem;
		font-size: 0.95rem;
		color: var(--text-2);
	}
	.days > li:first-child .day {
		margin-top: 0;
	}
	.entry {
		display: grid;
		grid-template-columns: 9rem 1fr;
		gap: 0.25rem 1rem;
		padding: 0.6rem 0;
		border-top: 1px solid var(--border);
	}
	.meta {
		display: flex;
		flex-direction: column;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.meta time {
		font-variant-numeric: tabular-nums;
	}
	.who {
		overflow-wrap: anywhere;
	}
	.what {
		min-width: 0;
	}
	.what p {
		margin: 0 0 0.2rem;
	}
	.title {
		font-weight: 600;
	}
	.lines li {
		padding: 0.1rem 0;
		overflow-wrap: anywhere;
	}
	.reason {
		font-style: italic;
	}
	.event {
		overflow-wrap: anywhere;
	}
	.restore {
		margin-top: 0.35rem;
	}
	.more {
		margin-top: 1rem;
	}
	.empty {
		color: var(--text-2);
		padding: 1rem 0;
	}
	.alert-success-ish {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--text);
	}
	.alert-success-ish p {
		margin: 0 0 0.3rem;
	}
	.alert-success-ish ul {
		margin: 0 0 0.4rem 1.2rem;
	}
	.small-h {
		font-size: 0.95rem;
		margin: 0.75rem 0 0.35rem;
	}
	.field input {
		width: 100%;
	}
	@media (max-width: 640px) {
		.entry {
			grid-template-columns: 1fr;
		}
		.meta {
			flex-direction: row;
			gap: 0.5rem;
		}
		.filters .field {
			min-width: 100%;
		}
		.restore,
		.more {
			min-height: 44px;
		}
	}
</style>
