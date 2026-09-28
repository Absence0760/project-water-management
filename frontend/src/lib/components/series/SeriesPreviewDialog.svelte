<script lang="ts">
	// "Preview all data" (Input time series card header) / a row's own "Preview":
	// every input series' daily value, side by side, plus columns for how the
	// model actually used that day's data (rain gap-fill + source, CHIRPS bias
	// correction, flow in m³/day, calibration exclusions — all computed with the
	// engine's own prepareRun/rain.ts/quality.ts, see ./preview.ts).
	//
	// Same modal <dialog> as "New team"/"Add data" (Dialog.svelte — native focus
	// trap, Esc-to-close and focus-return-to-opener; verified against this
	// project's Playwright/Chromium build, so no extra JS is needed here for
	// either). Data is whatever SeriesTab has already loaded (same `values`
	// store the chart uses) — this dialog fetches nothing itself.
	//
	// Every column header carries an ⓘ HelpTip (series.<kind> for a raw series,
	// preview.<column> for a derived one, keys set in ./preview.ts): where the
	// number comes from, how it's derived and what it tells you. The bubble is a
	// top-layer popover, so neither the sideways scroll nor the sticky header
	// clips it; the headers have no sort or other click behaviour to trigger.
	import type { ProjectSettings, SeriesMeta } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtReading } from '$lib/format/number';
	import type { Daily } from './coverage';
	import { buildPreviewColumns, buildPreviewRows, FLAG_LABEL, filterPreviewRows, headerUnit, seriesColumnId, type PreviewFlag } from './preview';

	let {
		open = $bindable(false),
		list,
		values,
		settings,
		/** Set when opened from a row's own "Preview" button: that series' column is un-hidden, scrolled into view and highlighted. Null (the card header's "Preview all data" button) shows every column. */
		focusSeriesId = null,
		onRetry
	}: {
		open?: boolean;
		list: SeriesMeta[];
		values: Record<string, Daily>;
		settings: ProjectSettings | null;
		focusSeriesId?: string | null;
		onRetry?: () => void;
	} = $props();

	const uid = $props.id();

	let query = $state('');
	let missingOnly = $state(false);
	let flaggedOnly = $state(false);
	let scrollTop = $state(0);
	let scrollEl: HTMLDivElement | undefined = $state();
	let hidden = $state(new Set<string>());

	const columns = $derived(buildPreviewColumns(list));
	const visibleColumns = $derived(columns.filter((c) => !hidden.has(c.id)));
	const visibleSeriesIds = $derived(visibleColumns.filter((c) => c.group === 'series').map((c) => c.seriesId!));
	const missingIds = $derived(list.filter((s) => !values[s.id]).map((s) => s.id));
	const missingNames = $derived(
		list
			.filter((s) => missingIds.includes(s.id))
			.map((s) => s.name || s.kind)
			.join(', ')
	);

	const rows = $derived(settings ? buildPreviewRows(list, values, settings) : []);
	const loading = $derived(rows.length === 0 && list.length > 0 && missingIds.length === list.length);
	const filtered = $derived(filterPreviewRows(rows, { query, missingOnly, flaggedOnly, visibleSeriesIds }));

	// Un-hide (never re-hide other columns) the focused series on open; the
	// header "Preview all data" button (focusSeriesId null) resets to every column.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			if (focusSeriesId === null) hidden = new Set();
			else if (hidden.has(seriesColumnId(focusSeriesId))) {
				const next = new Set(hidden);
				next.delete(seriesColumnId(focusSeriesId));
				hidden = next;
			}
			query = '';
			missingOnly = false;
			flaggedOnly = false;
			scrollTop = 0;
			if (scrollEl) {
				scrollEl.scrollTop = 0;
				if (focusSeriesId) {
					const target = scrollEl.querySelector(`[data-series-col="${CSS.escape(seriesColumnId(focusSeriesId))}"]`);
					target?.scrollIntoView({ inline: 'center', block: 'nearest' });
				}
			}
		}
		wasOpen = open;
	});

	function toggleColumn(id: string) {
		const next = new Set(hidden);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		hidden = next;
	}

	// Fixed-height row virtualisation: a long record is too many real <tr>s, so
	// only the rows in (and just around) the scrollport are rendered; two
	// spacer rows hold the scrollbar's height for the rest.
	const ROW_H = 28;
	// The scroll box fills the dialog, so its height follows the window; 380 until measured.
	let viewportH = $state(380);
	const BUFFER = 8;
	const startIdx = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER));
	const visibleCount = $derived(Math.ceil(viewportH / ROW_H) + BUFFER * 2);
	const endIdx = $derived(Math.min(filtered.length, startIdx + visibleCount));
	const visibleRows = $derived(filtered.slice(startIdx, endIdx));
	const topH = $derived(startIdx * ROW_H);
	const bottomH = $derived((filtered.length - endIdx) * ROW_H);
	const colCount = $derived(visibleColumns.length + 1);

	const numText = fmtReading;
	const flagList = (flags: PreviewFlag[]) => flags.map((f) => FLAG_LABEL[f]).join(', ');

	// Focus the search when it appears. `autofocus` alone only works if the
	// search is there when the dialog opens: Svelte applies it only while focus
	// is on <body>. Opened while the values still load, the dialog puts focus
	// on its Close button, and the search, mounting later, never got it. Leave
	// focus alone if the user has already moved into a field.
	function focusSearch(input: HTMLInputElement) {
		const active = document.activeElement;
		const dialog = input.closest('dialog');
		if (!active || active === document.body || active === dialog || (dialog?.contains(active) && active.tagName === 'BUTTON')) input.focus();
	}

	function onScroll(e: Event) {
		scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
	}
</script>

<Dialog bind:open title="Input time series — daily preview" full>
	<p class="muted period" role="status" aria-live="polite">
		{#if rows.length}{rows[0]!.date} → {rows[rows.length - 1]!.date} · {fmtNum(filtered.length)} of {fmtNum(rows.length)} days shown{/if}
	</p>

	{#if loading}
		<div class="state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading…</div>
	{:else if rows.length === 0}
		<p class="muted">No series data loaded yet.</p>
	{:else}
		{#if missingIds.length > 0}
			<div class="alert alert-warning" role="status">
				{missingIds.length} series {missingIds.length === 1 ? "isn't" : "aren't"} loaded yet and show{missingIds.length === 1 ? 's' : ''} blank: {missingNames}.
				{#if onRetry}<button type="button" class="btn btn-sm" onclick={onRetry}>Try again</button>{/if}
			</div>
		{/if}

		<div class="controls">
			<div class="search-row">
				<label for="{uid}-q" class="visually-hidden">Search by date or value</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="{uid}-q"
					type="search"
					autofocus
					{@attach focusSearch}
					autocomplete="off"
					placeholder="Date prefix (2015 or 2015-03-14) or value (&gt; 20, = 0)"
					bind:value={query}
				/>
			</div>
			<div class="toggles" role="group" aria-label="Filter rows">
				<label><input type="checkbox" bind:checked={missingOnly} /> Missing only</label>
				<label><input type="checkbox" bind:checked={flaggedOnly} /> Flagged only</label>
			</div>
			<details class="picker">
				<summary class="btn btn-sm">Columns</summary>
				<div class="picker-panel">
					<fieldset>
						<legend>Series</legend>
						{#each columns.filter((c) => c.group === 'series') as col (col.id)}
							<label><input type="checkbox" checked={!hidden.has(col.id)} onchange={() => toggleColumn(col.id)} /> {col.label}</label>
						{/each}
					</fieldset>
					<fieldset>
						<legend>How the model used it</legend>
						{#each columns.filter((c) => c.group === 'derived') as col (col.id)}
							<label><input type="checkbox" checked={!hidden.has(col.id)} onchange={() => toggleColumn(col.id)} /> {col.label}</label>
						{/each}
					</fieldset>
				</div>
			</details>
		</div>

		<!-- Focusable, so the table scrolls from the keyboard (arrows, Page Up/Down) with nothing to focus inside it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="scroll"
			bind:this={scrollEl}
			bind:clientHeight={viewportH}
			onscroll={onScroll}
			tabindex="0"
			role="region"
			aria-label="Input time series: the daily table"
		>
			<table class="data compact" aria-rowcount={filtered.length + 1}>
				<caption class="visually-hidden">Daily values for every input series, plus how the model used them</caption>
				<thead>
					<tr aria-rowindex="1">
						<th scope="col" class="datecol">Date <HelpTip key="preview.date" label="About the date column" /></th>
						{#each visibleColumns as col (col.id)}
							{@const unit = headerUnit(col)}
							<th scope="col" class:num={col.id !== 'excluded'} class:hl={col.seriesId === focusSeriesId} data-series-col={col.id}>
								{col.label}{#if unit}
									<span class="u">({unit})</span>
								{/if}
								<HelpTip key={col.helpKey} label="About {col.label}" />
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#if topH > 0}<tr class="spacer" aria-hidden="true" style="height: {topH}px"><td colspan={colCount}></td></tr>{/if}
					{#each visibleRows as row, i (row.date)}
						<tr aria-rowindex={startIdx + i + 2}>
							<td class="datecol">{row.date}</td>
							{#each visibleColumns as col (col.id)}
								{#if col.group === 'series'}
									{@const cell = row.series[col.seriesId!]}
									<td class="num" class:flag={cell && cell.flags.length > 0} class:hl={col.seriesId === focusSeriesId}>
										{numText(cell?.value ?? null)}
										{#if cell && cell.flags.length}<span class="visually-hidden"> — {flagList(cell.flags)}</span>{/if}
									</td>
								{:else if col.id.startsWith('m3day:')}
									{@const cell = row.series[col.seriesId!]}
									<td class="num" class:hl={col.seriesId === focusSeriesId}>{numText(cell?.m3Day ?? null)}</td>
								{:else if col.id === 'rainUsed'}
									<td class="num">
										{numText(row.derived.rainUsedMm)}
										{#if row.derived.rainSource}<span class="visually-hidden"> — {row.derived.rainSource}</span>{/if}
									</td>
								{:else if col.id === 'chirpsFactor'}
									<td class="num">{row.derived.chirpsFactor == null ? '–' : `${fmtNum(row.derived.chirpsFactor, 2)}×`}</td>
								{:else if col.id === 'chirpsCorrected'}
									<td class="num">{numText(row.derived.chirpsCorrectedMm)}</td>
								{:else if col.id === 'excluded'}
									<td class:flag={row.derived.excluded}>
										{row.derived.excluded ? 'Excluded' : '–'}
										{#if row.derived.exclusionReason}<span class="visually-hidden"> — {row.derived.exclusionReason}</span>{/if}
									</td>
								{/if}
							{/each}
						</tr>
					{/each}
					{#if bottomH > 0}<tr class="spacer" aria-hidden="true" style="height: {bottomH}px"><td colspan={colCount}></td></tr>{/if}
				</tbody>
			</table>
			{#if filtered.length === 0}
				<p class="muted none">No days match this search.</p>
			{/if}
		</div>
	{/if}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
	{/snippet}
</Dialog>

<style>
	.period {
		margin: -0.25rem 0 0.75rem;
		font-size: 0.82rem;
		min-height: 1.2em;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 0.6rem;
	}
	.search-row {
		flex: 1 1 260px;
	}
	.search-row input {
		width: 100%;
	}
	.toggles {
		display: flex;
		gap: 0.75rem;
		font-size: 0.82rem;
		white-space: nowrap;
	}
	.toggles label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.picker {
		position: relative;
	}
	.picker-panel {
		position: absolute;
		right: 0;
		top: calc(100% + 0.25rem);
		z-index: 5;
		display: flex;
		gap: 1rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 8px 20px rgb(0 0 0 / 0.18);
		padding: 0.6rem 0.8rem;
		max-height: 320px;
		overflow-y: auto;
	}
	.picker-panel fieldset {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 160px;
	}
	.picker-panel legend {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.picker-panel label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8rem;
		padding: 0.1rem 0;
		white-space: nowrap;
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
	   rows drifted from their spacers down a long record (as Download → Preview's
	   did, export/DailyTableDialog.svelte). */
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
	table.data td.flag {
		background: var(--row-flag);
	}
	.hl {
		background: var(--accent-soft);
	}
	.state {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1.5rem 1rem;
		color: var(--text-muted);
		justify-content: center;
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
