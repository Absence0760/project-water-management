<script lang="ts">
	// Crops & demand (issue #17, option A · A3): the answers first, the crop
	// grids one click away. A compact crop list, largest planted area first (a
	// row per crop: its colour, area, peak-need month, a sparkline of its 12
	// factors under one column header naming them (charts/Sparkline.svelte:
	// Oct and Sep at its ends, the highest factor marked, a read-out on
	// hover); Edit opens its name and factors in a side sheet,
	// `crop=<cropId>`), the catchment's demand by month (its table behind Show
	// table), and planted area per unit as stacked bars (a unit opens the farm
	// drawer; Edit areas opens the planted-areas grid). From 1100 px of page
	// width the list is a column that scrolls in itself and the chart and bars
	// fill the window beside it, so they stay on the first screen whatever the
	// number of crops or units. The full grids open from the Grids menu in the
	// grid modal (`grid=<id>`, lib/workspace/overlays.ts), which shows them
	// through `sections` (CropGrids); scenario override mode shows all three
	// inline the same way.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { ProjectSettings } from '@water-management/engine';
	import Sparkline from '$lib/components/charts/Sparkline.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MonthlyBars from '$lib/components/settings/MonthlyBars.svelte';
	import { fmtNum, fmtQty } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { withParam, withoutParam, type GridId } from '$lib/workspace/overlays';
	import {
		cropAreaTotals,
		cropColouring,
		cropRows,
		cropsSummary,
		FACTOR_CAPTION,
		farmBarLabel,
		farmBars,
		OTHER_COLOUR,
		otherLabel,
		rankCrops,
		type CropRow
	} from './cards';
	import CropGrids from './CropGrids.svelte';
	import CropSheet from './CropSheet.svelte';
	import { catchmentDemand, cropStacks, DAILY_APAN_NO_MEANS, demandApanNote, farmDemands, noPlantedAreaNote } from './demand';
	import DemandTable from './DemandTable.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';

	let {
		editor,
		settings,
		readonly,
		sections,
		onsave,
		reason = $bindable(''),
		apanDaily = false
	}: {
		editor: ModelEditor;
		settings: ProjectSettings;
		readonly: boolean;
		/** Only these grids, as full tables (the grid modal shows one; override mode all three); absent: the page. */
		sections?: readonly ('factors' | 'areas' | 'demand')[];
		/** The page's model save, for the crop sheet's save row (the sheet hides the save bar). */
		onsave?: () => void;
		/** The save bar's reason, shared with the sheet's save row. */
		reason?: string;
		/** The project has a daily A-pan series, which runs use instead of the monthly means on the days it covers (model.md §2.3a). */
		apanDaily?: boolean;
	} = $props();

	const crops = $derived(editor.model.crops);
	// Farms, plus any other node that already carries crop areas (the grids' rows).
	const farms = $derived(
		editor.model.nodes.filter((n) => n.kind === 'farm' || editor.model.cropAreas.some((a) => a.nodeId === n.id))
	);
	const farmIds = $derived(farms.map((f) => f.id));
	const ha = (m2: number) => fmtNum(m2 / 10_000, 1, true);
	const factor = (v: number) => v.toFixed(2);

	// One ranking (planted area, largest first) orders the list, picks the colours and stacks the chart and bars.
	const areaTotals = $derived(cropAreaTotals(editor.model.cropAreas, farmIds));
	const ranked = $derived(rankCrops(crops, areaTotals));
	const colouring = $derived(cropColouring(ranked));
	const colourOf = (id: string) => colouring.colours.get(id) ?? OTHER_COLOUR;
	const inOther = $derived(new Set(colouring.other));
	const rows = $derived(cropRows(ranked, areaTotals, settings.apanMm, WATER_YEAR_MONTHS));
	const namedRows = $derived(rows.filter((r) => !inOther.has(r.id)));
	const otherRows = $derived(rows.filter((r) => inOther.has(r.id)));
	const otherAreaM2 = $derived(otherRows.reduce((s, r) => s + r.areaM2, 0));

	const bars = $derived(farmBars(farms, ranked, editor.model.cropAreas));
	const totalM2 = $derived(bars.reduce((s, b) => s + b.totalM2, 0));
	const summary = $derived(cropsSummary(crops.length, totalM2, bars.length, ha));
	const unplantedNote = $derived(noPlantedAreaNote(farms.filter((f) => !bars.some((b) => b.id === f.id)).map((f) => f.name || '(unnamed)')));

	// Demand: saved A-pan × the crops and areas as edited (demand.ts, the engine's own helper).
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	// The preview reads the monthly means only; a run reads a daily A-pan series first (issue #173).
	const apanNote = $derived(demandApanNote(apanDaily));
	const demand = $derived(farmDemands(editor.model, settings.apanMm, settings.februaryDays, farmIds));
	const demandTotal = $derived(catchmentDemand(demand));
	const stacks = $derived(cropStacks(demand, crops, colouring.named).map((s) => ({ ...s, color: s.id === 'other' ? OTHER_COLOUR : colourOf(s.id) })));
	const peakMonth = $derived(demandTotal.monthly.reduce((best, v, m, a) => (v > a[best]! ? m : best), 0));
	const chartLabel = $derived(
		`Catchment irrigation demand by month, stacked by crop (${stacks.map((s) => s.name).join(', ')}). ` +
			`Peak in ${WATER_YEAR_MONTHS[peakMonth]} at ${fmtNum(demandTotal.monthly[peakMonth])} m³/day. Show table holds the values.` +
			(apanNote ? ` ${apanNote}` : '')
	);
	let chartW = $state(0);
	let chartH = $state(0);
	// The chart's legend (MonthlyBars draws it under the bars) wraps with the width: measured after each render.
	let figEl: HTMLElement | undefined = $state();
	let legendH = $state(0);
	$effect(() => {
		void chartW;
		void stacks.length;
		const l = figEl?.querySelector<HTMLElement>('.legend');
		legendH = l ? l.offsetHeight + 8 : 0;
	});
	const barsH = $derived(Math.max(120, chartH - legendH));

	// The key under the unit bars: the named crops planted somewhere, then "Other" when any of its crops is.
	const planted = $derived(new Set(bars.flatMap((b) => b.parts.map((p) => p.cropId))));
	const barKey = $derived([
		...ranked.filter((c) => planted.has(c.id) && !inOther.has(c.id)).map((c) => ({ id: c.id, name: c.name || '(unnamed)', color: colourOf(c.id) })),
		...(colouring.other.some((id) => planted.has(id)) ? [{ id: 'other', name: 'Other', color: OTHER_COLOUR }] : [])
	]);

	// From 1100 px of page width the list and the results fill the window below the header, less the page's gutter
	// and the save bar while it shows (--dock-h), as the Network's map does. The top is measured. (Measuring what sat
	// below as the page's scroll height less its bottom let the window's own height prop up any shorter layout, so one
	// shrunk in a narrower window never grew back.)
	let layoutEl: HTMLDivElement | undefined = $state();
	let layoutTop = $state(0);
	$effect(() => {
		if (!layoutEl) return;
		const measure = () => {
			if (!layoutEl) return;
			layoutTop = layoutEl.getBoundingClientRect().top + window.scrollY;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	let tableOpen = $state(false);
	// Narrower than 1100 px the list is capped (it scrolls in itself) until "Show all N crops".
	const LIST_CAP = 6;
	const listLen = $derived(rows.length + (otherRows.length ? 1 : 0));
	let listAll = $state(false);

	// --- the crop sheet: one crop's name and factors, while the URL names it (`crop=<id>`) ---
	const cropParam = $derived(sections ? null : page.url.searchParams.get('crop'));
	const sheetCrop = $derived(cropParam && crops.some((c) => c.id === cropParam) ? cropParam : null);
	let sheetOpen = $state(false);
	$effect(() => {
		sheetOpen = !!sheetCrop;
	});
	$effect(() => {
		// Closed (Done, Esc, the ✕, the crop removed): drop `crop` in place, so Back goes to where it was opened from.
		if (!sheetOpen && untrack(() => cropParam)) void goto(withoutParam(page.url, 'crop'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	const openCrop = (id: string) => goto(withParam(page.url, 'crop', id), { noScroll: true, keepFocus: true });
	function add() {
		const c = editor.addCrop();
		void openCrop(c.id);
	}

	// --- the Grids menu (as the Network's): each full grid in the grid modal ---
	const GRID_LINKS: [GridId, string][] = [
		['crop-factors', 'Crop factors'],
		['planted-areas', 'Planted areas'],
		['demand', 'Irrigation demand']
	];
	let gridsOpen = $state(false);
	let gridsEl: HTMLDetailsElement | undefined = $state();
	// Close through the element: the toggle event that updates `gridsOpen` is async (issue #17 playbook).
	function closeGrids() {
		if (gridsEl) gridsEl.open = false;
	}
	function gridsKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !gridsEl?.open) return;
		e.preventDefault();
		closeGrids();
		gridsEl.querySelector('summary')?.focus();
	}
	$effect(() => {
		if (!gridsOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (gridsEl && !gridsEl.contains(e.target as Node)) closeGrids();
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
	// The page's section header shows the summary line, Grids and Add crop (not in a modal or override mode).
	$effect(() => fillHeader({ context: headerContext, actions: headerActions }, !sections));
</script>

{#snippet headerContext()}<span data-testid="crops-summary">{summary}</span>{/snippet}
{#snippet headerActions()}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<details class="grids-menu" bind:open={gridsOpen} bind:this={gridsEl} onkeydown={gridsKeydown}>
		<summary class="btn">Grids <span aria-hidden="true">▾</span></summary>
		<div class="grids-pop" role="group" aria-label="Open as a grid">
			{#each GRID_LINKS as [id, label] (id)}<a href={withParam(page.url, 'grid', id)} onclick={closeGrids}>{label}</a>{/each}
		</div>
	</details>
	{#if !readonly}<button type="button" class="btn" onclick={add}>+ Add crop</button>{/if}
{/snippet}

{#snippet cropRow(r: CropRow, member: boolean)}
	<li class="crop-row" data-testid="crop-row">
		<span class="key" class:hatch={member} style:background={member ? null : colourOf(r.id)} aria-hidden="true"></span>
		<span class="who">
			<span class="name">{r.name}</span>
			<span class="facts">{ha(r.areaM2)} ha · {r.peak >= 0 ? `peak need in ${WATER_YEAR_MONTHS[r.peak]}` : 'no crop factors yet'}{member ? ' · in Other' : ''}</span>
		</span>
		<Sparkline values={r.factors} labels={WATER_YEAR_MONTHS} caption={FACTOR_CAPTION} captionHidden name={r.name} format={factor} hi={r.top} />
		{#if r.high.length}
			{@const tip = `Factor above 1.0 in ${r.high.join(', ')}`}
			<button type="button" class="warn-flag" aria-label="{tip}: check {r.name} isn't an FAO Kc" data-tip={tip} onclick={() => openCrop(r.id)}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15.2 14.4H.8Z" class="tri" /><path d="M8 6v4" class="bang" /><circle cx="8" cy="12.2" r=".9" class="dot" /></svg>
			</button>
		{:else}
			<span></span>
		{/if}
		<button type="button" class="btn btn-sm" aria-label="{readonly ? 'View' : 'Edit'} {r.name}" onclick={() => openCrop(r.id)}>{readonly ? 'View' : 'Edit'}</button>
	</li>
{/snippet}

{#if sections}
	<CropGrids {editor} {settings} {readonly} {sections} {apanDaily} />
{:else}
	<div class="crops-page">
		{#if crops.length === 0}
			<section class="panel" aria-label="No crops yet">
				<div class="empty">
					<p>No crops defined. Add each irrigated crop (e.g. citrus, vines, pasture) with its monthly crop factors.</p>
					{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
				</div>
			</section>
		{/if}
		<div
			class="layout"
			class:no-list={crops.length === 0}
			class:table-open={tableOpen}
			bind:this={layoutEl}
			style:--layout-top="{layoutTop}px"
		>
			{#if crops.length}
				<section class="panel list-card" class:capped={!listAll} aria-labelledby="crop-list-h">
					<div class="panel-head">
						<h3 id="crop-list-h">Crops</h3>
						<span class="muted small">Largest planted area first</span>
					</div>
					<!-- The sparklines' caption, once, over their column (each keeps it in its accessible name). -->
					<div class="list-cols" aria-hidden="true" data-testid="crop-spark-caption">
						<span></span><span></span><span class="c-spark">{FACTOR_CAPTION}</span><span></span><span class="btn btn-sm ghost">{readonly ? 'View' : 'Edit'}</span>
					</div>
					<ul class="crop-list" aria-label="Crops, largest planted area first">
						{#each namedRows as r (r.id)}{@render cropRow(r, false)}{/each}
						{#if otherRows.length}
							<li class="other-row" data-testid="crop-other">
								<span class="key" style:background={OTHER_COLOUR} aria-hidden="true"></span>
								<span class="who">
									<span class="name">{otherLabel(otherRows.map((r) => r.name))}</span>
									<span class="facts">{otherRows.length === 1 ? 'The smallest crop, past the colours' : `${otherRows.length} smaller crops share one colour`} · {ha(otherAreaM2)} ha</span>
								</span>
							</li>
							{#each otherRows as r (r.id)}{@render cropRow(r, true)}{/each}
						{/if}
					</ul>
					{#if listLen > LIST_CAP}
						<button type="button" class="btn btn-sm show-all" aria-expanded={listAll} onclick={() => (listAll = !listAll)}>
							{listAll ? 'Show fewer' : `Show all ${rows.length} crops`}
						</button>
					{/if}
				</section>
			{/if}

			<div class="results">
				<section class="panel dem-card" aria-labelledby="crop-dem-h">
					<div class="panel-head">
						<h3 id="crop-dem-h">Irrigation demand by month <HelpTip key="settings.apanMm" label="About A-pan evaporation" /></h3>
						<span class="muted small">Gross demand, whole catchment, m³/day</span>
					</div>
					{#if !apanSet}
						<div class="alert alert-info">
							{#if apanDaily}
								{DAILY_APAN_NO_MEANS} <a href="?tab=settings">Enter the monthly A-pan values</a> (Settings & calibration, Demand) for the other days.
							{:else}
								A-pan evaporation isn't set yet, so demand is zero. <a href="?tab=settings">Enter the monthly A-pan values</a>
								(Settings & calibration, Demand).
							{/if}
						</div>
					{:else if apanNote}
						<p class="small muted" data-testid="crops-demand-apan">{apanNote}</p>
					{/if}
					{#if farms.length === 0}
						<p class="muted">No hydrological units yet. Add hydrological units on the <a href="?tab=network">Network</a>.</p>
					{:else}
						{#if stacks.length && demandTotal.annual > 0}
							<figure class="demand-chart" bind:this={figEl} bind:clientWidth={chartW} bind:clientHeight={chartH}>
								<div class="chart-in">
									{#if chartW > 0 && chartH > 0}
										<MonthlyBars {stacks} unit="m³/day" label="Irrigation demand" ariaLabel={chartLabel} width={chartW} height={barsH} />
									{/if}
								</div>
							</figure>
							<p class="small" data-testid="crops-demand-summary">
								{fmtQty(demandTotal.annual, 3)} million m³ a year ({fmtQty((demandTotal.annual * 1e6) / 86_400 / 365.25, 3)} m³/s on average),
								highest in {WATER_YEAR_MONTHS[peakMonth]} at {fmtNum(demandTotal.monthly[peakMonth])} m³/day. Before effective rain and irrigation efficiency.
							</p>
						{:else if apanSet}
							<p class="muted">No demand yet: add crops with their factors and each hydrological unit's planted area.</p>
						{/if}
						<details class="show-table" bind:open={tableOpen}>
							<summary class="btn btn-sm">{tableOpen ? 'Hide table' : 'Show table'}</summary>
							<div class="table-body">
								<DemandTable {farms} {demand} {settings} total={demandTotal} areaM2={totalM2} />
							</div>
						</details>
					{/if}
				</section>

				<section class="panel area-card" aria-labelledby="crop-area-h">
					<div class="panel-head">
						<h3 id="crop-area-h">Planted area by hydrological unit</h3>
						<a class="btn btn-sm" href={withParam(page.url, 'grid', 'planted-areas')}>{readonly ? 'Areas table' : 'Edit areas'}</a>
					</div>
					{#if farms.length === 0 || crops.length === 0}
						<p class="muted">Add at least one hydrological unit (<a href="?tab=network">Network</a>) and one crop to enter planted areas.</p>
					{:else}
						{#if bars.length}
							<ul class="bars" aria-label="Planted area by hydrological unit, largest first">
								{#each bars as b (b.id)}
									<li>
										<a class="farm" href={withParam(page.url, 'farm', b.id)} aria-label="{b.name}: planted areas">{b.name}</a>
										<span class="track" role="img" aria-label={farmBarLabel(b, ha)}>
											{#each b.parts as p (p.cropId)}<span class="seg" style:width="{p.pct}%" style:background={colourOf(p.cropId)} title="{p.name}: {ha(p.areaM2)} ha"></span>{/each}
										</span>
										<span class="total">{ha(b.totalM2)} ha</span>
									</li>
								{/each}
							</ul>
							<ul class="legend" aria-hidden="true" data-testid="crops-bar-key">
								{#each barKey as c (c.id)}<li><span class="key" style:background={c.color}></span>{c.name}</li>{/each}
							</ul>
						{/if}
						{#if unplantedNote}<p class="muted small note">{unplantedNote}</p>{/if}
					{/if}
				</section>
			</div>
		</div>
	</div>

	{#if sheetCrop && onsave}
		<CropSheet bind:open={sheetOpen} {editor} cropId={sheetCrop} {farms} {readonly} {onsave} bind:reason />
	{/if}
{/if}

<style>
	.grids-menu {
		position: relative;
	}
	.grids-menu summary {
		list-style: none;
		cursor: pointer;
	}
	.grids-menu summary::-webkit-details-marker {
		display: none;
	}
	.grids-pop {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: grid;
		min-width: 12rem;
		padding: 0.3rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	.grids-pop a {
		display: block;
		min-height: 36px;
		padding: 0.45rem 0.6rem;
		border-radius: var(--radius-sm);
		color: var(--text);
		font-size: 0.9rem;
		text-decoration: none;
	}
	.grids-pop a:hover {
		background: var(--surface-2);
	}
	.crops-page {
		container: crops-page / inline-size;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
	}
	.results {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		min-width: 0;
		min-height: 0;
	}
	.layout .panel {
		margin: 0;
		min-width: 0;
	}
	.panel-head h3 {
		font-size: 1.05rem;
	}
	.small {
		font-size: 0.85rem;
	}

	/* --- the crop list --- */
	.list-card {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.list-card .panel-head {
		margin-bottom: 0.4rem;
	}
	.crop-list {
		list-style: none;
		margin: 0 -0.4rem;
		padding: 0 0.4rem;
		overflow-y: auto;
	}
	.capped .crop-list {
		/* About six rows, then it scrolls in itself (until Show all). */
		max-height: 21rem;
	}
	.crop-row,
	.other-row,
	.list-cols {
		display: grid;
		grid-template-columns: 0.75rem minmax(0, 1fr) 7rem 1.6rem auto;
		align-items: center;
		gap: 0.55rem;
		padding: 0.4rem 0;
		border-top: 1px solid var(--border);
	}
	/* The column header: the same grid as a row, so the caption sits over the sparklines. */
	.list-cols {
		padding: 0 0 0.3rem;
		font-size: 0.72rem;
		line-height: 1.25;
		color: var(--text-muted);
	}
	.list-cols .ghost {
		visibility: hidden;
		min-height: 0;
		padding-block: 0;
		height: 0;
	}
	.crop-list > li:first-child {
		border-top: 0;
	}
	.other-row {
		grid-template-columns: 0.75rem minmax(0, 1fr);
	}
	.key {
		flex: none;
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 2px;
	}
	/* A crop inside "Other": no colour of its own, so a neutral hatch, not the group's grey. */
	.key.hatch {
		background: repeating-linear-gradient(135deg, var(--text-muted) 0 1.5px, transparent 1.5px 4px);
		box-shadow: inset 0 0 0 1px var(--text-muted);
	}
	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	/* The group's member names: two lines, then an ellipsis (each member has its own row below). */
	.other-row .name {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.facts {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.warn-flag {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--warning);
		cursor: pointer;
	}
	.warn-flag svg {
		width: 1.05rem;
		height: 1.05rem;
	}
	.warn-flag .tri {
		fill: currentColor;
	}
	.warn-flag .bang {
		stroke: var(--surface);
		stroke-width: 1.8;
		stroke-linecap: round;
	}
	.warn-flag .dot {
		fill: var(--surface);
	}
	.warn-flag:hover {
		background: var(--warning-soft);
	}
	/* Its text on hover and focus (the full warning is in the crop sheet it opens). */
	.warn-flag::after {
		content: attr(data-tip);
		position: absolute;
		right: 0;
		bottom: calc(100% + 4px);
		z-index: 5;
		width: max-content;
		max-width: 14rem;
		padding: 0.3rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--text);
		color: var(--surface);
		font-size: 0.78rem;
		line-height: 1.3;
		text-align: left;
		pointer-events: none;
		opacity: 0;
		visibility: hidden;
	}
	.warn-flag:hover::after,
	.warn-flag:focus-visible::after {
		opacity: 1;
		visibility: visible;
	}
	.show-all {
		align-self: flex-start;
		margin-top: 0.6rem;
	}

	/* --- demand chart --- */
	.dem-card {
		display: flex;
		flex-direction: column;
	}
	/* The chart takes its box's measured size (no zoomed text); the box's height comes from the layout. */
	.demand-chart {
		position: relative;
		height: 280px;
		margin: 0 0 0.5rem;
	}
	.chart-in {
		position: absolute;
		inset: 0;
	}
	.dem-card > p {
		margin: 0 0 0.6rem;
	}
	.show-table summary {
		list-style: none;
		cursor: pointer;
	}
	.show-table summary::-webkit-details-marker {
		display: none;
	}
	.table-body {
		margin-top: 0.75rem;
	}

	/* --- planted area by unit --- */
	.area-card {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.bars {
		list-style: none;
		margin: 0 -0.4rem;
		padding: 0 0.4rem;
		display: grid;
		align-content: start;
		gap: 0.2rem;
		max-height: 24rem;
		overflow-y: auto;
	}
	.bars li {
		display: grid;
		grid-template-columns: minmax(5rem, 9rem) minmax(0, 1fr) 4.5rem;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.9rem;
	}
	.farm {
		display: inline-flex;
		align-items: center;
		min-height: 30px;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.track {
		display: flex;
		height: 14px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--surface-2);
	}
	.seg {
		display: block;
		height: 100%;
	}
	.seg + .seg {
		box-shadow: inset 1px 0 0 var(--surface);
	}
	.total {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	/* The key stays under the bars (they scroll, it doesn't). */
	.legend {
		flex: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin: 0.6rem 0 0;
		padding: 0.5rem 0 0;
		border-top: 1px solid var(--border);
		list-style: none;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.note {
		flex: none;
		margin: 0.5rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}

	/* From a 60rem (840 px) page column, a window of about 1100 px beside the sidebar: the list a column that scrolls in itself, the chart over the bars filling the
	   window beside it, so both stay on the first screen however many crops and units there are. */
	@container crops-page (min-width: 60rem) {
		.layout {
			grid-template-columns: minmax(19rem, 28rem) minmax(0, 1fr);
			height: max(520px, calc(100vh - var(--layout-top, 0px) - var(--dock-h, 0px) - 1rem));
		}
		.layout.no-list {
			grid-template-columns: minmax(0, 1fr);
		}
		/* An open demand table needs the room: the row grows and the page scrolls. */
		.layout.table-open {
			height: auto;
			min-height: max(520px, calc(100vh - var(--layout-top, 0px) - var(--dock-h, 0px) - 1rem));
		}
		.list-card .crop-list {
			flex: 1;
			min-height: 0;
			max-height: none;
		}
		.show-all {
			display: none;
		}
		.results {
			grid-template-rows: minmax(0, 1.15fr) minmax(0, 1fr);
		}
		.table-open .results {
			grid-template-rows: auto minmax(20rem, 1fr);
		}
		.demand-chart {
			flex: 1;
			height: auto;
			min-height: 160px;
		}
		.table-open .demand-chart {
			flex: none;
			height: 320px;
		}
		.bars {
			flex: 0 1 auto;
			min-height: 0;
			max-height: none;
		}
	}
	/* Wide enough for the chart and the bars side by side. */
	@container crops-page (min-width: 1500px) {
		.results {
			grid-template-columns: minmax(0, 1.5fr) minmax(22rem, 1fr);
			grid-template-rows: minmax(0, 1fr);
		}
		.table-open .results {
			grid-template-rows: auto;
		}
	}
	@media (max-width: 640px) {
		.demand-chart {
			height: 240px;
		}
		.crop-row,
		.list-cols {
			/* The flag's column is always there, so every row's sparkline lines up under the caption. The sparkline
			   keeps the desktop's 7rem: its ticks ("Oct  max 1.10  Sep") need 84 px in Noto Sans but 95 px in DejaVu
			   Sans (Ubuntu's and Debian's default sans), so 6rem (84 px) cut the mark to "max …" there. */
			grid-template-columns: 0.75rem minmax(0, 1fr) 7rem 44px auto;
			gap: 0.4rem;
		}
		.bars li {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.1rem 0.6rem;
			padding-bottom: 0.3rem;
		}
		.track {
			grid-column: 1 / -1;
			grid-row: 2;
		}
		.farm {
			min-height: 44px;
		}
		.crop-row .btn-sm,
		.warn-flag {
			min-height: 44px;
			min-width: 44px;
		}
		.list-cols .ghost {
			min-width: 44px;
		}
	}
</style>
