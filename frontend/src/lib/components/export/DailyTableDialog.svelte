<script lang="ts">
	// Preview of a daily CSV download (a date column, then a column per farm:
	// the run's "Fragmented flow / EWR — all farms" tables) before saving it.
	// It fetches the export itself and parses it (lib/export/dailyTable.ts), so
	// what it shows is exactly the file its Download button saves, from the
	// same response, with no second request.
	//
	// Same modal Dialog and row virtualisation as the Data tab's preview
	// (series/SeriesPreviewDialog.svelte): only the rows in view are real
	// <tr>s, the header row and the date column stay in view while scrolling,
	// and number columns are right-aligned under right-aligned headers.
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fetchDownload, saveBlob } from '$lib/export/download';
	import { parseDailyCsv, type DailyTable } from '$lib/export/dailyTable';
	import { fmtNum, fmtReading } from '$lib/format/number';

	let {
		open = $bindable(false),
		title,
		url,
		description
	}: {
		open?: boolean;
		title: string;
		/** The export to preview (lib/export/urls.ts). */
		url: string;
		/** One line under the title: what the table is. */
		description?: string;
	} = $props();

	const uid = $props.id();
	let table = $state.raw<DailyTable | null>(null);
	let file = $state.raw<{ blob: Blob; filename: string } | null>(null);
	let loadedUrl = $state<string | null>(null);
	let error = $state<string | null>(null);
	let query = $state('');
	let scrollTop = $state(0);
	let scrollEl: HTMLDivElement | undefined = $state();

	async function load(u: string) {
		error = null;
		try {
			const f = await fetchDownload(u);
			const t = parseDailyCsv(await f.blob.text());
			if (u !== url) return; // a newer preview was asked for meanwhile
			file = f;
			table = t;
			loadedUrl = u;
		} catch (e) {
			if (u === url) error = e instanceof Error ? e.message : String(e);
		}
	}

	// Fetch on open, once per URL: reopening the same table shows it at once.
	// `requested` is plain (not state), so a failed load isn't retried in a
	// loop; "Try again" calls load itself.
	let requested: string | null = null;
	$effect(() => {
		if (open && url !== requested) {
			requested = url;
			void load(url);
		}
	});
	// Each open starts at the top with no search.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			query = '';
			scrollTop = 0;
			if (scrollEl) scrollEl.scrollTop = 0;
		}
		wasOpen = open;
	});

	const shown = $derived(table && loadedUrl === url ? table : null);
	/** Row indexes matching the date prefix (2015, 2015-03 or 2015-03-14). */
	const rows = $derived.by(() => {
		if (!shown) return [];
		const q = query.trim();
		const all = shown.dates.map((_, i) => i);
		return q ? all.filter((i) => shown.dates[i]!.startsWith(q)) : all;
	});

	const ROW_H = 28;
	const BUFFER = 8;
	let viewportH = $state(380);
	const startIdx = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER));
	const endIdx = $derived(Math.min(rows.length, startIdx + Math.ceil(viewportH / ROW_H) + BUFFER * 2));
	const visibleRows = $derived(rows.slice(startIdx, endIdx));
	const topH = $derived(startIdx * ROW_H);
	const bottomH = $derived((rows.length - endIdx) * ROW_H);

	function onScroll(e: Event) {
		scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
	}
</script>

<Dialog bind:open {title} full>
	{#if description}<p class="muted lead">{description}</p>{/if}
	{#if error}
		<div class="alert alert-error" role="alert">
			{error}
			<button type="button" class="btn btn-sm" onclick={() => load(url)}>Try again</button>
		</div>
	{:else if !shown}
		<div class="state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading…</div>
	{:else}
		{#if shown.legacy}<div class="alert alert-warning" role="note">This run used the legacy runoff model (removed in engine 1.0.0): a workbook comparison only, not evidence.</div>{/if}
		<div class="controls">
			<label for="{uid}-q" class="visually-hidden">Find a date</label>
			<input id="{uid}-q" type="search" autocomplete="off" placeholder="Date prefix: 2015, 2015-03 or 2015-03-14" bind:value={query} />
			<p class="muted period" role="status" aria-live="polite">
				{#if shown.dates.length}{shown.dates[0]} → {shown.dates[shown.dates.length - 1]} ·{/if}
				{fmtNum(rows.length)} of {fmtNum(shown.dates.length)} days · {shown.headers.length} hydrological unit{shown.headers.length === 1 ? '' : 's'}
			</p>
		</div>
		<!-- Focusable, so the table scrolls from the keyboard (arrows, Page Up/Down) with nothing to focus inside it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="scroll" bind:this={scrollEl} bind:clientHeight={viewportH} onscroll={onScroll} tabindex="0" role="region" aria-label="{title}: the table">
			<table class="data compact" aria-rowcount={rows.length + 1}>
				<caption class="visually-hidden">{title}: one row per day, one column per hydrological unit</caption>
				<thead>
					<tr aria-rowindex="1">
						<th scope="col" class="datecol">Date</th>
						{#each shown.headers as h, c (c)}<th scope="col" class="num">{h}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#if topH > 0}<tr class="spacer" aria-hidden="true" style="height: {topH}px"><td colspan={shown.headers.length + 1}></td></tr>{/if}
					{#each visibleRows as r, i (r)}
						<tr aria-rowindex={startIdx + i + 2}>
							<td class="datecol">{shown.dates[r]}</td>
							{#each shown.columns as col, c (c)}<td class="num">{fmtReading(col[r])}</td>{/each}
						</tr>
					{/each}
					{#if bottomH > 0}<tr class="spacer" aria-hidden="true" style="height: {bottomH}px"><td colspan={shown.headers.length + 1}></td></tr>{/if}
				</tbody>
			</table>
			{#if rows.length === 0}<p class="muted none">No days match this date.</p>{/if}
		</div>
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		<button type="button" class="btn btn-primary" disabled={!file || !shown} onclick={() => file && saveBlob(file.blob, file.filename)}>
			Download CSV
		</button>
	{/snippet}
</Dialog>

<style>
	.lead {
		margin: -0.25rem 0 0.6rem;
		font-size: 0.85rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 1rem;
		margin-bottom: 0.6rem;
	}
	.controls input {
		flex: 1 1 260px;
		max-width: 420px;
	}
	.period {
		margin: 0;
		font-size: 0.82rem;
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.scroll:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	/* Exactly ROW_H tall, border included, so the spacers' sums line up with the
	   rows they stand for: with the table's own padding a row was ~29 px, and the
	   rows drifted from their spacers down a long record. */
	table.data tbody tr {
		height: 28px;
	}
	table.data tbody td {
		padding-block: 0;
		line-height: 27px;
	}
	/* A spacer is only its height, with no rule. */
	table.data tbody tr.spacer td {
		border: 0;
	}
	table.data th,
	table.data td {
		white-space: nowrap;
	}
	.datecol {
		position: sticky;
		left: 0;
		z-index: 1;
		background: var(--surface);
		box-shadow: 1px 0 0 var(--border);
	}
	/* The pinned date keeps the row's hover, which its own background would hide. */
	table.data tbody tr:hover .datecol {
		background: var(--row-hover);
	}
	thead th.datecol {
		z-index: 3;
		background: var(--surface-2);
	}
	.state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 1.5rem 1rem;
		color: var(--text-muted);
	}
	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border-strong);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
	.none {
		text-align: center;
		padding: 1rem;
	}
</style>
