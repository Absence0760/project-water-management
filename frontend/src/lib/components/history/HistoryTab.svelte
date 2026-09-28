<!--
	The History tab (WP-2.4, docs/ui.md § History; issue #17 option A): who
	changed what, when and why, newest first and grouped by the viewer's day,
	with "Restore this version" for editors. The section header says what
	changed last, by whom and when. The unit, kind and parameter filters are in
	the URL (`unit=`, `kind=`, `q=`), so Back steps through the first two and a
	link keeps all three (a field's "Changed 3×" line links here with them). In a
	wide column the timeline is a list of compact rows beside the picked change
	(`entry=`, else the newest), and from 1100 × 620 the card fills the window
	with both columns scrolling inside it; in a narrow one (a phone) each entry
	shows whole and the page scrolls. Viewers read it; farmers never reach it
	(the workspace sends them to their farm page, and the API refuses them).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { InputChange } from '@water-management/engine';
	import { api, ApiError, type HistoryItem, type HistoryRevision, type Relink } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import ChangesList from '$lib/components/compare/ChangesList.svelte';
	import { fmtDate, fmtDay } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { withoutParam, withParam } from '$lib/workspace/overlays';
	import {
		entryHeading,
		entrySummary,
		filterEntries,
		groupByChangeSet,
		groupByDay,
		historyContext,
		itemLines,
		KIND_FILTERS,
		localDay,
		localTime,
		parseKind,
		pickEntry,
		revisionTitle,
		seriesRestore,
		type HistoryEntry
	} from './timeline';

	let {
		projectId,
		editor,
		canEdit,
		onRestored,
		onSeriesRestored
	}: {
		projectId: string;
		/** The model as the page holds it: the unit filter's units, and whether there are unsaved edits. */
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
	/** The newest entry of the whole history, whatever the filters: the header's line. */
	let latest = $state<HistoryEntry | null>(null);

	const url = $derived(page.url);
	const farms = $derived(editor.model.nodes.filter((n) => n.kind === 'farm'));
	// The unit and kind filters are the server's, in the URL; an unknown value is no filter.
	const kind = $derived(parseKind(url.searchParams.get('kind')));
	const nodeId = $derived.by(() => {
		const v = url.searchParams.get('unit');
		return v && farms.some((f) => f.id === v) ? v : '';
	});
	// The parameter filter narrows what's loaded as you type, and, once the URL has it (`q=`,
	// written after a pause), the server finds matching revisions on every page, however old.
	const urlQuery = $derived(url.searchParams.get('q') ?? '');
	let query = $state(untrack(() => urlQuery));
	/** The last words this box wrote to the URL: the URL catching up with them isn't a new filter. */
	let written = untrack(() => urlQuery);
	$effect(() => {
		const q = urlQuery;
		if (q !== untrack(() => written)) query = written = q;
	});
	let queryTimer: ReturnType<typeof setTimeout> | undefined;
	function onQueryInput() {
		clearTimeout(queryTimer);
		queryTimer = setTimeout(() => {
			const words = query.trim();
			if (words === urlQuery.trim()) return;
			written = words;
			const q = new URLSearchParams(url.search);
			if (words) q.set('q', words);
			else q.delete('q');
			q.delete('entry');
			void goto(`?${q}`, { replaceState: true, noScroll: true, keepFocus: true });
		}, 400);
	}
	$effect(() => () => clearTimeout(queryTimer));
	const entries = $derived(filterEntries(groupByChangeSet(items), query));
	const days = $derived(groupByDay(entries));

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	let loadSeq = 0;
	async function load(more = false) {
		const seq = ++loadSeq;
		if (more) loadingMore = true;
		else loading = true;
		error = null;
		const filtered = !!(nodeId || kind || urlQuery);
		try {
			const [pageOf, newest] = await Promise.all([
				api.history.list(projectId, {
					limit: 50,
					...(more && next ? { before: next } : {}),
					...(nodeId ? { nodeId } : {}),
					...(kind ? { kind } : {}),
					...(urlQuery ? { q: urlQuery } : {})
				}),
				// Filtered, the header still names the latest change of all (a change set is a few items at most).
				filtered && !more ? api.history.list(projectId, { limit: 5 }) : null
			]);
			if (seq !== loadSeq) return;
			items = more ? [...items, ...pageOf.items] : pageOf.items;
			next = pageOf.next;
			since = pageOf.historySince;
			if (!more) {
				latest = groupByChangeSet((newest ?? pageOf).items)[0] ?? null;
				// The saved inputs may have moved (a restore, a save): every version's differences from now are stale.
				diffs.clear();
				const id = untrack(() => diff?.id);
				if (id) void loadDiff(id);
			}
		} catch (e) {
			if (seq === loadSeq) error = msg(e);
		} finally {
			if (seq === loadSeq) loading = loadingMore = false;
		}
	}
	$effect(() => {
		void nodeId;
		void kind;
		void urlQuery;
		untrack(() => load());
	});

	/** A filter in the URL (pushed, so Back steps back through it); the pick goes with it. */
	function setFilter(name: 'unit' | 'kind', value: string) {
		const q = new URLSearchParams(url.search);
		if (value) q.set(name, value);
		else q.delete(name);
		q.delete('entry');
		void goto(`?${q}`, { noScroll: true, keepFocus: true });
	}

	// --- the layout: a list beside the picked change when there's room, measured, not assumed ---
	let pageW = $state(0);
	let innerW = $state(0);
	let innerH = $state(0);
	/** 60rem at 14 px: room for the list and a readable detail side by side. */
	const side = $derived(pageW >= 840);
	const fit = $derived(side && innerW >= 1100 && innerH >= 620 && entries.length > 0);
	let root: HTMLDivElement | undefined = $state();
	let top = $state(0);
	$effect(() => {
		if (!root) return;
		const el = root;
		const measure = () => (top = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	const entryParam = $derived(url.searchParams.get('entry'));
	const picked = $derived(side ? pickEntry(entries, entryParam) : null);
	const entryHref = (key: string) => withParam(url, 'entry', key);
	const pickedAt = $derived(picked ? entries.findIndex((e) => e.key === picked.key) : -1);
	const newer = $derived(pickedAt > 0 ? entries[pickedAt - 1]! : null);
	const older = $derived(pickedAt >= 0 && pickedAt < entries.length - 1 ? entries[pickedAt + 1]! : null);

	// --- the picked version against the saved inputs now (what restoring it would change), read by anyone who reads the history ---
	const diffs = new Map<string, InputChange[]>();
	let diff = $state<{ id: string; changes: InputChange[] | null; error: string | null } | null>(null);
	async function loadDiff(id: string) {
		const known = diffs.get(id);
		diff = { id, changes: known ?? null, error: null };
		if (known) return;
		try {
			const d = await api.history.revision(projectId, id);
			diffs.set(id, d.preview);
			if (diff?.id === id) diff = { id, changes: d.preview, error: null };
		} catch (e) {
			if (diff?.id === id) diff = { id, changes: null, error: msg(e) };
		}
	}
	$effect(() => {
		const id = picked?.revision?.id;
		if (id) untrack(() => loadDiff(id));
		else diff = null;
	});

	// A new pick starts its detail at the top.
	let detailEl: HTMLElement | undefined = $state();
	$effect(() => {
		void picked?.key;
		if (detailEl) detailEl.scrollTop = 0;
	});

	// A link that names an entry further down: bring its row into view once, inside the list's own scroller,
	// after the card fits the window at its measured top (the playbook's Allocations trap).
	let listEl: HTMLElement | undefined = $state();
	let revealed = false;
	$effect(() => {
		if (revealed || !listEl || !picked || !fit || !top) return;
		revealed = true;
		if (!untrack(() => entryParam)) return;
		const row = listEl.querySelector('.picked');
		if (!row) return;
		const r = row.getBoundingClientRect();
		const l = listEl.getBoundingClientRect();
		listEl.scrollTop += r.top - l.top - (l.height - r.height) / 2;
	});

	/** After a restore the newest entry is the restore itself: show it (in place, so Back doesn't step to the old pick). */
	function showNewest() {
		if (entryParam) void goto(withoutParam(url, 'entry'), { replaceState: true, noScroll: true, keepFocus: true });
	}

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
		const known = diffs.get(r.id);
		if (known) {
			preview = known;
			return;
		}
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
			showNewest();
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
			showNewest();
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

	// The fact the page is opened for, in the section header (issue #17): not a second "History" heading.
	$effect(() => fillHeader({ context: headerContext }));
</script>

<svelte:window bind:innerWidth={innerW} bind:innerHeight={innerH} />

{#snippet headerContext()}<span>{loading && !latest ? 'Every change, with who made it and why' : historyContext(latest, since)}</span>{/snippet}

<!-- One entry's whole content: in the detail beside the list, or in the list itself in a narrow column. -->
{#snippet entryBody(e: HistoryEntry, titled: boolean)}
	{#each e.items as i (i.type + i.id)}
		{#if i.type === 'revision'}
			<!-- Beside the list the detail's heading is already the revision's title. -->
			{#if titled || i.id !== e.revision?.id}<p class="title">{revisionTitle(i)}</p>{/if}
			<ul class="lines">
				{#each itemLines(i) as line, n (n)}<li>{line}</li>{/each}
			</ul>
			{#if i.reason}<p class="reason"><span class="muted">Reason:</span> {i.reason}</p>{/if}
		{:else}
			{@const sr = canEdit ? seriesRestore(i) : null}
			<p class="event">{itemLines(i)[0]}</p>
			{#if sr}
				<button type="button" class="btn btn-sm restore" onclick={() => askSeriesRestore({ ...sr, at: i.createdAt })}>Restore the earlier values</button>
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
{/snippet}

<div class="history" class:side class:fit bind:this={root} bind:clientWidth={pageW} style:--h-top="{top}px" data-testid="history">
	{#if restored}
		<div class="alert alert-success-ish" role="status">
			<p>Restored the version of {fmtDate(restored.at, true)}. The model and settings are as they were then; run the model again to update the results.</p>
			{#if restored.relink.length}
				<p>Farmers aren't linked back automatically. Re-link them in the Farmers list on the <a href="?tab=project#farmers-h">Project page</a>:</p>
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

	<!-- Not "History": the page's h1 already says it, and the tab body is the region of that name. -->
	<section class="panel card" aria-labelledby="{uid}-h">
		<div class="panel-head">
			<div class="head-text">
				<h2 id="{uid}-h">Changes, newest first</h2>
				<span class="muted small">
					Every change to the model, settings, data, members and publication, with who made it and why.
					{#if canEdit}Restoring a version saves it as a new change: nothing is ever erased.{/if}
				</span>
			</div>
			<div class="filters" role="group" aria-label="Filter the history">
				<div class="field">
					<label for="{uid}-farm">Hydrological unit</label>
					<select id="{uid}-farm" value={nodeId} onchange={(e) => setFilter('unit', e.currentTarget.value)}>
						<option value="">All hydrological units</option>
						{#each farms as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
					</select>
				</div>
				<div class="field">
					<label for="{uid}-kind">Kind of change</label>
					<select id="{uid}-kind" value={kind} onchange={(e) => setFilter('kind', e.currentTarget.value)}>
						{#each KIND_FILTERS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
					</select>
				</div>
				<div class="field grow">
					<label for="{uid}-q">Parameter</label>
					<input id="{uid}-q" type="search" placeholder="e.g. dam capacity" bind:value={query} oninput={onQueryInput} autocomplete="off" />
				</div>
			</div>
		</div>

		<LoadState {loading} {error} retry={() => load()}>
			{#if days.length === 0}
				<p class="empty" data-testid="history-empty">
					{#if items.length || nodeId || kind || urlQuery}
						Nothing matches these filters.
					{:else}
						No changes recorded yet. History starts from {since ? fmtDay(localDay(since)) : 'now'}.
					{/if}
				</p>
			{:else if side}
				<div class="split">
					<div class="list" bind:this={listEl}>
						<ol class="days">
							{#each days as d (d.day)}
								<li>
									<h3 class="day">{d.label}</h3>
									<ol class="rows">
										{#each d.entries as e (e.key)}
											{@const s = entrySummary(e)}
											<li data-testid="history-entry" class:picked={picked?.key === e.key}>
												<a
													class="row"
													href={entryHref(e.key)}
													aria-current={picked?.key === e.key ? 'true' : undefined}
													data-sveltekit-noscroll
													data-sveltekit-keepfocus
												>
													<span class="row-meta"><time datetime={e.createdAt}>{localTime(e.createdAt)}</time>{' · '}<span class="who">{e.actor ?? 'A deleted account'}</span></span>
													<span class="row-title">{' '}{s.title}</span>
													{#if s.line || s.more}
														<span class="row-line">
															{' '}{s.line}{#if s.more}<span class="more">{s.line ? ' ' : ''}+{s.more} more</span>{/if}
														</span>
													{/if}
													{#each e.items as i (i.type + i.id)}
														{#if i.type === 'revision' && i.reason}<span class="row-reason">{' '}<span class="muted">Reason:</span> {i.reason}</span>{/if}
													{/each}
												</a>
											</li>
										{/each}
									</ol>
								</li>
							{/each}
						</ol>
						{#if next}
							<button type="button" class="btn btn-sm more-btn" onclick={() => load(true)} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older changes'}</button>
						{/if}
					</div>
					{#if picked}
						<section class="detail" aria-labelledby="{uid}-detail-h" bind:this={detailEl} data-testid="history-detail">
							<div class="detail-head">
								<div>
									<h2 id="{uid}-detail-h">{entryHeading(picked)}</h2>
									<p class="detail-meta">
										<time datetime={picked.createdAt}>{fmtDay(localDay(picked.createdAt))} at {localTime(picked.createdAt)}</time> · by {picked.actor ?? 'a deleted account'}
									</p>
								</div>
								<p class="steps">
									{#if newer}<a class="btn btn-sm" href={entryHref(newer.key)} data-sveltekit-noscroll data-sveltekit-keepfocus>Newer</a>{/if}
									{#if older}<a class="btn btn-sm" href={entryHref(older.key)} data-sveltekit-noscroll data-sveltekit-keepfocus>Older</a>{/if}
								</p>
							</div>
							<div class="what">{@render entryBody(picked, false)}</div>
							{#if canEdit && editor.dirty && picked.revision}
								<p class="muted small" role="note">You have unsaved model changes: save or discard them before restoring a version.</p>
							{/if}
							{#if picked.revision}
								<section class="since" aria-labelledby="{uid}-since-h" data-testid="history-differences">
									<h3 id="{uid}-since-h">Differences from now</h3>
									<p class="muted small">From the saved inputs now to this version{canEdit ? ': what restoring it would change' : ''}.</p>
									{#if diff?.error}
										<div class="alert alert-error" role="alert">{diff.error}</div>
									{:else if !diff?.changes}
										<p class="muted" role="status">Working out the differences…</p>
									{:else if diff.changes.length === 0}
										<p class="muted">None: the saved inputs match this version.</p>
									{:else}
										<ChangesList changes={diff.changes} />
									{/if}
								</section>
							{/if}
						</section>
					{/if}
				</div>
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
										<div class="what">{@render entryBody(e, true)}</div>
									</li>
								{/each}
							</ol>
						</li>
					{/each}
				</ol>
				{#if next}
					<button type="button" class="btn more-btn" onclick={() => load(true)} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older changes'}</button>
				{/if}
				{#if canEdit && editor.dirty}
					<p class="muted small" role="note">You have unsaved model changes: save or discard them before restoring a version.</p>
				{/if}
			{/if}
		</LoadState>
	</section>
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
		<p class="muted small">Series values aren't part of a version: restore them from their own entries here (“Restore the earlier values”). A restored hydrological unit comes back without its farmer links.</p>
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
	.history {
		container: history-page / inline-size;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.history > .panel {
		margin: 0;
	}
	/* Wide and tall enough: the card is the height left in the window; the list and the detail scroll inside it. */
	.history.fit {
		height: max(420px, calc(100vh - var(--h-top, 0px) - var(--dock-h, 0px) - 1rem));
	}
	.fit .card {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.panel-head {
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.6rem 1.25rem;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex: 1 1 24rem;
		min-width: 0;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		align-items: flex-end;
		flex: 1 1 36rem;
	}
	.filters .field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0;
		min-width: 10rem;
	}
	.filters .grow {
		flex: 1;
		min-width: 12rem;
	}
	.days,
	.entries,
	.rows,
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

	/* --- beside the detail: a list of compact rows --- */
	.split {
		display: grid;
		grid-template-columns: minmax(20rem, 2fr) minmax(0, 3fr);
		gap: 0 1.25rem;
		margin-top: 0.75rem;
	}
	.fit .split {
		flex: 1 1 auto;
		min-height: 0;
	}
	.list {
		min-width: 0;
		border-right: 1px solid var(--border);
		padding-right: 0.75rem;
	}
	.side:not(.fit) .list {
		max-height: 36rem;
		overflow-y: auto;
	}
	.fit .list,
	.fit .detail {
		min-height: 0;
		overflow-y: auto;
	}
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.45rem 0.6rem;
		border-top: 1px solid var(--border);
		border-left: 3px solid transparent;
		color: var(--text);
		text-decoration: none;
		min-width: 0;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.picked .row {
		background: var(--accent-soft);
		border-left-color: var(--accent);
	}
	.row-meta {
		font-size: 0.8rem;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.row-title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.row-line,
	.row-reason {
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-reason {
		font-style: italic;
		color: var(--text-2);
	}
	.more {
		font-weight: 600;
		color: var(--text-2);
	}
	.more-btn {
		margin-top: 0.75rem;
	}
	.detail {
		min-width: 0;
		padding-right: 0.25rem;
	}
	.detail-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem 1rem;
	}
	.steps {
		display: flex;
		gap: 0.4rem;
		margin: 0;
	}
	.detail h2 {
		margin: 0 0 0.15rem;
		font-size: 1.1rem;
	}
	.since {
		margin-top: 1.25rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.since h3 {
		margin: 0 0 0.1rem;
		font-size: 1rem;
	}
	.since > p {
		margin: 0 0 0.5rem;
	}
	.detail-meta {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.detail .lines li {
		padding: 0.2rem 0;
		border-bottom: 1px solid var(--border);
	}

	/* --- a narrow column: each entry whole --- */
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
		margin-top: 0.35rem !important;
	}
	.event {
		overflow-wrap: anywhere;
	}
	.restore {
		display: block;
		margin-top: 0.5rem;
	}
	.empty {
		color: var(--text-2);
		padding: 1rem 0;
		margin: 0;
	}
	.alert-success-ish {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--text);
		margin: 0;
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
	/* A phone (under 640 px): the entry's time and author on one line, the two selects side by side, big targets. */
	@container history-page (max-width: 45.7rem) {
		.entry {
			grid-template-columns: 1fr;
		}
		.meta {
			flex-direction: row;
			gap: 0.5rem;
		}
		.filters {
			display: grid;
			grid-template-columns: 1fr 1fr;
			flex-basis: 100%;
		}
		.filters .field {
			min-width: 0;
		}
		.filters .grow {
			grid-column: 1 / -1;
		}
		.restore,
		.more-btn {
			min-height: 44px;
		}
	}
</style>
