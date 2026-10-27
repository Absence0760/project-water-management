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
	//
	// With `loadAreas`, the dialog also shows each area's rain under its station
	// (issue #553: the average catchment rainfall and each land unit, the Full
	// CSV's derived columns, derivedRain.ts): asked for when the dialog opens,
	// computed by SeriesTab in its own lazily loaded chunk, never stored.
	//
	// The View select (issue #613) picks the column set: All (every column, as
	// before), one land unit (its station raw and adjusted, its CHIRPS raw and
	// bias-corrected with the factors, its rain used and source, then the series
	// stored at it), or a group (stations, the average catchment rainfall, flow).
	// The column checkboxes hide columns within the view. SeriesTab keeps the
	// view in the URL (`preview=`) while the dialog is open.
	import type { NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
	import Dialog from '#lib/components/common/Dialog.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { kindLabel } from '#lib/series/kinds.js';
	import { fmtDay, fmtNum, fmtReading } from '#lib/format/number.js';
	import type { Daily } from './coverage';
	import {
		areaCell,
		areaTitle,
		buildAreaColumns,
		buildPreviewColumns,
		buildPreviewRows,
		columnsForView,
		FLAG_LABEL,
		filterPreviewRows,
		headerUnit,
		previewViews,
		PREVIEW_ALL,
		resolveView,
		seriesColumnId,
		shownSeriesIds,
		type PreviewArea,
		type PreviewFlag,
		type RainSource
	} from './preview';

	let {
		open = $bindable(false),
		list,
		values,
		settings,
		/** Set when opened from a row's own "Preview" button: that series' column is un-hidden, scrolled into view and highlighted. Null (the card header's "Preview all data" button) shows every column. */
		focusSeriesId = null,
		failed = {},
		onRetry,
		loadAreas,
		nodes = [],
		view = $bindable(PREVIEW_ALL)
	}: {
		open?: boolean;
		list: SeriesMeta[];
		values: Record<string, Daily>;
		settings: ProjectSettings | null;
		focusSeriesId?: string | null;
		/** Series whose values failed to load, with the error (SeriesTab's loadValues). */
		failed?: Record<string, string>;
		onRetry?: () => void;
		/** Each area's rain under its station (SeriesTab, derivedRain.ts); asked for on every open, so it is never older than its inputs. */
		loadAreas?: () => Promise<PreviewArea[]>;
		/** The model's nodes: the land units the View select offers, in the model's order. */
		nodes?: readonly NetworkNode[];
		/** The view's id (preview.ts previewViews): `all`, `unit:<id>`, `stations`, `catchment` or `flow`; one not offered reads as All. */
		view?: string;
	} = $props();

	const uid = $props.id();

	let query = $state('');
	let missingOnly = $state(false);
	let flaggedOnly = $state(false);
	let scrollTop = $state(0);
	let scrollEl: HTMLDivElement | undefined = $state();
	let hidden = $state(new Set<string>());

	// Each area's derived lines: null until asked for, then the areas (each with its lines or why not) or the error.
	let areas = $state.raw<PreviewArea[] | null>(null);
	let areasLoading = $state(false);
	let areasError = $state<string | null>(null);
	let areasAsk = 0;
	async function fetchAreas() {
		if (!loadAreas) return;
		const ask = ++areasAsk;
		areasLoading = true;
		areasError = null;
		try {
			const got = await loadAreas();
			if (ask === areasAsk) areas = got;
		} catch (e) {
			if (ask === areasAsk) areasError = e instanceof Error ? e.message : String(e);
		} finally {
			if (ask === areasAsk) areasLoading = false;
		}
	}
	const areaLines = $derived(new Map((areas ?? []).map((a) => [a.nodeId, a.lines])));
	const areasFailed = $derived((areas ?? []).filter((a) => a.error));

	const columns = $derived([...buildPreviewColumns(list), ...buildAreaColumns(areas ?? [])]);
	const views = $derived(previewViews(nodes, settings, list));
	const activeView = $derived(resolveView(views, view));
	const unitViews = $derived(views.filter((v) => v.kind === 'unit'));
	const groupViews = $derived(views.filter((v) => v.kind === 'group'));
	// A view this project doesn't offer (a stale link to a deleted unit) reads as All, and says so in the URL too.
	$effect(() => {
		if (open && list.length && view !== activeView) view = activeView;
	});
	const viewColumns = $derived(columnsForView(activeView, columns, { list, areas: areas ?? [] }));
	const visibleColumns = $derived(viewColumns.filter((c) => !hidden.has(c.id)));
	// The area a unit's or the catchment's view is about (its lines, or why not), for the factors panel.
	const viewArea = $derived.by(() => {
		if (activeView === 'catchment') return { nodeId: null, name: 'the catchment', found: (areas ?? []).find((a) => a.nodeId === null) ?? null };
		if (!activeView.startsWith('unit:')) return null;
		const nodeId = activeView.slice('unit:'.length);
		return { nodeId, name: views.find((v) => v.id === activeView)?.label ?? '', found: (areas ?? []).find((a) => a.nodeId === nodeId) ?? null };
	});
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const stationNameOf = (id: string) => list.find((s) => s.id === id)?.name || 'a station no longer in the project';
	// A unit's view shows its station and CHIRPS as raw lines: the search and the toggles read those series there too.
	const visibleSeriesIds = $derived(shownSeriesIds(visibleColumns));
	const missingIds = $derived(list.filter((s) => !values[s.id]).map((s) => s.id));
	const failedIds = $derived(missingIds.filter((id) => id in failed));
	const pendingIds = $derived(missingIds.filter((id) => !(id in failed)));
	const namesOf = (ids: string[]) =>
		list
			.filter((s) => ids.includes(s.id))
			.map((s) => s.name || kindLabel(s.kind))
			.join(', ');
	const failedNames = $derived(namesOf(failedIds));
	const pendingNames = $derived(namesOf(pendingIds));
	// The first error, as the server or the network gave it (one is enough: they are usually the same).
	const failedReason = $derived(failedIds.length ? failed[failedIds[0]!] : '');

	const rows = $derived(settings ? buildPreviewRows(list, values, settings) : []);
	const noValues = $derived(rows.length === 0 && list.length > 0 && missingIds.length === list.length);
	// Still waiting on at least one series and none has failed; once one fails, the error shows instead.
	const loading = $derived(noValues && failedIds.length === 0);
	const filtered = $derived(filterPreviewRows(rows, { query, missingOnly, flaggedOnly, visibleSeriesIds }));

	// Un-hide (never re-hide other columns) the focused series on open; the
	// header "Preview all data" button (focusSeriesId null) resets to every column.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			if (focusSeriesId !== null && !columnsForView(activeView, columns, { list, areas: areas ?? [] }).some((c) => c.id === seriesColumnId(focusSeriesId))) view = PREVIEW_ALL;
			if (focusSeriesId === null) hidden = new Set();
			else if (hidden.has(seriesColumnId(focusSeriesId))) {
				const next = new Set(hidden);
				next.delete(seriesColumnId(focusSeriesId));
				hidden = next;
			}
			query = '';
			void fetchAreas();
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
	// Where Rain used came from, in words beside the value (the colour is never the only cue).
	const RAIN_SOURCE_LABEL: Record<Exclude<RainSource, 'none'>, string> = { catchment: 'catchment', chirps: 'CHIRPS', forecast: 'forecast' };

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

	// Each Try again takes itself out of the dialog (the loading line, or the list once loaded): the focus
	// follows within its own block (followRetry), so the values' and the areas' retries don't find each other's.
	function retryValues(e: MouseEvent) {
		const button = e.currentTarget as HTMLElement;
		followRetry(button, { scope: button.closest('[data-retry-scope]') });
		onRetry?.();
	}
	function retryAreas(e: MouseEvent) {
		const button = e.currentTarget as HTMLElement;
		followRetry(button, { scope: button.closest('[data-retry-scope]') });
		void fetchAreas();
	}

	function onScroll(e: Event) {
		scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
	}
</script>

<Dialog bind:open title="Input time series — daily preview" full>
	<p class="muted period" role="status" aria-live="polite">
		{#if rows.length}{fmtDay(rows[0]!.date)} → {fmtDay(rows[rows.length - 1]!.date)} · {fmtNum(filtered.length)} of {fmtNum(rows.length)} days shown{/if}
	</p>

	{#if loading}
		<div class="state" role="status" aria-live="polite" data-loading><span class="spinner" aria-hidden="true"></span> Loading…</div>
	{:else if noValues}
		<div class="alert alert-error" role="alert">
			Couldn't load the values of {failedNames} ({failedReason}).{pendingIds.length ? ` Still loading: ${pendingNames}.` : ''}
			{#if onRetry}<button type="button" class="btn btn-sm" data-retry onclick={retryValues}>Try again</button>{/if}
		</div>
	{:else if rows.length === 0}
		<p class="muted">No series data loaded yet.</p>
	{:else}
		<div data-retry-scope>
			{#if missingIds.length > 0}
				<div class="alert alert-warning" role="status">
					{#if failedIds.length}{failedIds.length} series couldn't be loaded and show{failedIds.length === 1 ? 's' : ''} blank: {failedNames} ({failedReason}).{/if}
					{#if pendingIds.length}{pendingIds.length} series {pendingIds.length === 1 ? "isn't" : "aren't"} loaded yet and show{pendingIds.length === 1 ? 's' : ''} blank: {pendingNames}.{/if}
					{#if onRetry}<button type="button" class="btn btn-sm" data-retry onclick={retryValues}>Try again</button>{/if}
				</div>
			{/if}
		</div>

		<div data-retry-scope>
			{#if areasLoading}
				<p class="muted areas-note" role="status" data-testid="preview-areas" data-loading><span class="spinner" aria-hidden="true"></span> Computing each area’s rain under its station…</p>
			{:else if areasError || areasFailed.length}
				<div class="alert alert-warning" role="status" data-testid="preview-areas">
					{#if areasError}Couldn’t compute each area’s rain ({areasError}).{:else}Couldn’t compute the rain of {areasFailed.map((a) => `${areaTitle(a)} (${a.error})`).join(', ')}.{/if}
					<button type="button" class="btn btn-sm" data-retry onclick={retryAreas}>Try again</button>
				</div>
			{/if}
		</div>

		<div class="controls">
			<div class="view-pick">
				<label for="{uid}-view">View</label>
				<select id="{uid}-view" bind:value={() => activeView, (v) => (view = v)} data-testid="preview-view">
					<option value={PREVIEW_ALL}>All</option>
					{#if unitViews.length}
						<optgroup label="Units with land">
							{#each unitViews as v (v.id)}<option value={v.id}>{v.label}</option>{/each}
						</optgroup>
					{/if}
					{#if groupViews.length}
						<optgroup label="Groups">
							{#each groupViews as v (v.id)}<option value={v.id}>{v.label}</option>{/each}
						</optgroup>
					{/if}
				</select>
				<HelpTip key="preview.view" label="About the View select" />
			</div>
			<div class="search-row">
				<label for="{uid}-q" class="visually-hidden">Search by date or value</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					id="{uid}-q"
					type="search"
					autofocus
					{@attach focusSearch}
					autocomplete="off"
					placeholder="Date (2015, Mar 2015 or 14 Mar 2015) or value (&gt; 20, = 0)"
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
					{#if viewColumns.some((c) => c.group === 'series')}<fieldset>
						<legend>Series</legend>
						{#each viewColumns.filter((c) => c.group === 'series') as col (col.id)}
							<label><input type="checkbox" checked={!hidden.has(col.id)} onchange={() => toggleColumn(col.id)} /> {col.label}</label>
						{/each}
					</fieldset>{/if}
					{#if viewColumns.some((c) => c.group === 'derived')}<fieldset>
						<legend>How the model used it</legend>
						{#each viewColumns.filter((c) => c.group === 'derived') as col (col.id)}
							<label><input type="checkbox" checked={!hidden.has(col.id)} onchange={() => toggleColumn(col.id)} /> {col.label}</label>
						{/each}
					</fieldset>{/if}
					{#if viewColumns.some((c) => c.group === 'area')}
						<fieldset>
							<legend>Each area’s rain (derived, not stored)</legend>
							{#each viewColumns.filter((c) => c.group === 'area') as col (col.id)}
								<label><input type="checkbox" checked={!hidden.has(col.id)} onchange={() => toggleColumn(col.id)} /> {col.label}</label>
							{/each}
						</fieldset>
					{/if}
				</div>
			</details>
		</div>

		{#if viewArea && !areasLoading && !areasError}
			{@const lines = viewArea.found?.lines ?? null}
			<div class="factors" data-testid="preview-factors">
				{#if lines}
					{#if lines.refused}
						<p>The pairing that corrects {viewArea.name}’s CHIRPS against {stationNameOf(lines.correctAgainst)} is refused: {lines.refused}. Its CHIRPS isn’t corrected, so its gaps fall to the next fallback.</p>
					{:else if lines.factors}
						<p>CHIRPS bias factors f(m) against {stationNameOf(lines.correctAgainst)}, January to December{lines.chirpsRaw ? '' : ` (${viewArea.name} has no CHIRPS of its own to correct)`}:</p>
						<ul aria-label="CHIRPS bias factors by month">
							{#each lines.factors as k, m (m)}<li><span class="muted">{MONTHS[m]}</span> {fmtNum(k, 2)}</li>{/each}
						</ul>
					{:else}
						<p>No CHIRPS bias factors were fitted against {stationNameOf(lines.correctAgainst)}.</p>
					{/if}
				{:else if !viewArea.found?.error}
					<p class="muted">A run reads no rainfall station for {viewArea.name} with the settings as saved, so it has no derived rain lines; the series stored for it are shown.</p>
				{/if}
			</div>
		{/if}
		{#if viewColumns.length === 0 && !areasLoading}
			<p class="muted" data-testid="preview-view-empty">Nothing is stored or derived for this view yet.</p>
		{/if}

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
				<caption class="visually-hidden">{activeView === PREVIEW_ALL ? 'Daily values for every input series, plus how the model used them' : `Daily values: ${views.find((v) => v.id === activeView)?.label ?? ''}`}</caption>
				<thead>
					<tr aria-rowindex="1">
						<th scope="col" class="datecol">Date <HelpTip key="preview.date" label="About the date column" /></th>
						{#each visibleColumns as col (col.id)}
							{@const unit = headerUnit(col)}
							<th scope="col" class:num={col.id !== 'excluded' && col.area?.line !== 'source'} class:hl={col.seriesId === focusSeriesId} data-series-col={col.id}>
								{col.label}{#if unit}
									<span class="u">({unit})</span>
								{/if}
								<HelpTip key={col.helpKey} label="About {col.label}" />
								{#if col.group === 'area'}<span class="derived" data-testid="derived-tag">Derived · not stored</span>{/if}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#if topH > 0}<tr class="spacer" aria-hidden="true" style="height: {topH}px"><td colspan={colCount}></td></tr>{/if}
					{#each visibleRows as row, i (row.date)}
						<tr aria-rowindex={startIdx + i + 2}>
							<td class="datecol">{fmtDay(row.date)}</td>
							{#each visibleColumns as col (col.id)}
								{#if col.group === 'series'}
									{@const cell = row.series[col.seriesId!]}
									<td class="num" class:flag={cell && cell.flags.length > 0} class:hl={col.seriesId === focusSeriesId}>
										{numText(cell?.value ?? null)}{#if cell && cell.flags.length}<span class="tag" data-testid="cell-flags"> · {flagList(cell.flags)}</span>{/if}
									</td>
								{:else if col.id.startsWith('m3day:')}
									{@const cell = row.series[col.seriesId!]}
									<td class="num" class:hl={col.seriesId === focusSeriesId}>{numText(cell?.m3Day ?? null)}</td>
								{:else if col.id === 'rainUsed'}
									<td class="num">
										{numText(row.derived.rainUsedMm)}{#if row.derived.rainSource && row.derived.rainSource !== 'none'}<span class="tag" data-testid="rain-source"> · {RAIN_SOURCE_LABEL[row.derived.rainSource]}</span>{/if}
									</td>
								{:else if col.id === 'chirpsFactor'}
									<td class="num">{row.derived.chirpsFactor == null ? '–' : `${fmtNum(row.derived.chirpsFactor, 2)}×`}</td>
								{:else if col.id === 'chirpsCorrected'}
									<td class="num">{numText(row.derived.chirpsCorrectedMm)}</td>
								{:else if col.area}
									{@const lines = areaLines.get(col.area.nodeId)}
									{@const v = lines ? areaCell(lines, col.area.line, row.date) : null}
									{@const stored = col.seriesId ? row.series[col.seriesId] : undefined}
									{@const flags = v !== null && stored ? stored.flags.filter((f) => f !== 'missing') : []}
									<td class:num={col.area.line !== 'source'} class="area" class:flag={flags.length > 0}>
										{typeof v === 'string' ? v : numText(v)}{#if flags.length}<span class="tag" data-testid="cell-flags"> · {flagList(flags)}</span>{/if}
									</td>
								{:else if col.id === 'excluded'}
									<td class:flag={row.derived.excluded}>
										{row.derived.excluded ? 'Excluded' : '–'}{#if row.derived.exclusionReason}<span class="tag" data-testid="exclusion-reason"> · {row.derived.exclusionReason}</span>{/if}
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
		font-size: 0.85rem;
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
	.view-pick {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		min-width: 0;
	}
	.view-pick select {
		min-width: 0;
		max-width: 22rem;
	}
	.factors {
		font-size: 0.85rem;
		margin: 0 0 0.6rem;
	}
	.factors p {
		margin: 0 0 0.3rem;
	}
	.factors ul {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		list-style: none;
		margin: 0;
		padding: 0;
		font-variant-numeric: tabular-nums;
	}
	.search-row input {
		width: 100%;
	}
	.toggles {
		display: flex;
		gap: 0.75rem;
		font-size: 0.85rem;
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
		box-shadow: var(--popover-shadow);
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
		font-size: var(--font-xs);
		font-weight: 600;
		color: var(--text-muted);
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.picker-panel label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: var(--font-sm);
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
	/* Which check flagged a value, Rain used's source, an exclusion's reason: on screen, compact, the row still 28 px. */
	.tag {
		font-size: var(--font-xs);
		/* Its own small line box: at the cell's 27 px, the smaller text's baseline shift grew the line, and every row, by ~1 px. */
		line-height: 1;
		color: var(--text-2);
	}
	.hl {
		background: var(--accent-soft);
	}
	/* An area's derived column: said in its header, and its cells set apart from the stored values. */
	.derived {
		display: block;
		font-size: var(--font-xs);
		font-weight: 400;
		color: var(--text-2);
	}
	table.data td.area {
		font-style: italic;
	}
	.areas-note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		margin: 0 0 0.5rem;
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
