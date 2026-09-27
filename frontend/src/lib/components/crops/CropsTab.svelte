<script lang="ts">
	// Crops & demand (issue #17, option A · A3): a page of pictures over the
	// crop grids. A card per crop (area, peak-need month, a sparkline of its
	// 12 factors; Edit opens its name and factors in a side sheet,
	// `crop=<cropId>`), the catchment's demand by month (its table behind
	// Show table), and planted area per farm as stacked bars (a farm opens the
	// farm drawer; Edit areas opens the planted-areas grid). The full grids
	// open from the Grids menu in the grid modal (`grid=<id>`,
	// lib/workspace/overlays.ts), which shows them through `sections`
	// (CropGrids); scenario override mode shows all three inline the same way.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { ProjectSettings } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MonthlyBars from '$lib/components/settings/MonthlyBars.svelte';
	import { fmtNum, fmtQty } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { withParam, withoutParam, type GridId } from '$lib/workspace/overlays';
	import { CROP_PALETTE, cropCards, cropColours, cropsSummary, farmBarLabel, farmBars, SPARK_H, SPARK_W } from './cards';
	import CropGrids from './CropGrids.svelte';
	import CropSheet from './CropSheet.svelte';
	import { catchmentDemand, cropStacks, farmDemands, noPlantedAreaNote } from './demand';
	import DemandTable from './DemandTable.svelte';
	import { fillHeader } from '$lib/components/workspace/sectionHeader.svelte';

	let {
		editor,
		settings,
		readonly,
		sections,
		onsave,
		reason = $bindable('')
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
	} = $props();

	const crops = $derived(editor.model.crops);
	// Farms, plus any other node that already carries crop areas (the grids' rows).
	const farms = $derived(
		editor.model.nodes.filter((n) => n.kind === 'farm' || editor.model.cropAreas.some((a) => a.nodeId === n.id))
	);
	const farmIds = $derived(farms.map((f) => f.id));
	const ha = (m2: number) => fmtNum(m2 / 10_000, 1, true);

	const cards = $derived(cropCards(crops, editor.model.cropAreas, farmIds, settings.apanMm, WATER_YEAR_MONTHS));
	const bars = $derived(farmBars(farms, crops, editor.model.cropAreas));
	const totalM2 = $derived(bars.reduce((s, b) => s + b.totalM2, 0));
	const summary = $derived(cropsSummary(crops.length, totalM2, bars.length, ha));
	const unplantedNote = $derived(noPlantedAreaNote(farms.filter((f) => !bars.some((b) => b.id === f.id)).map((f) => f.name || '(unnamed)')));

	// Demand: saved A-pan × the crops and areas as edited (demand.ts, the engine's own helper).
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	const demand = $derived(farmDemands(editor.model, settings.apanMm, settings.februaryDays, farmIds));
	const demandTotal = $derived(catchmentDemand(demand));
	const stackParts = $derived(cropStacks(demand, crops, CROP_PALETTE.length));
	const colours = $derived(cropColours(crops, stackParts));
	const colourOf = (id: string) => colours.get(id) ?? 'var(--text-muted)';
	const stacks = $derived(stackParts.map((s) => ({ ...s, color: colourOf(s.id) })));
	const peakMonth = $derived(demandTotal.monthly.reduce((best, v, m, a) => (v > a[best]! ? m : best), 0));
	const chartLabel = $derived(
		`Catchment irrigation demand by month, stacked by crop (${stacks.map((s) => s.name).join(', ')}). ` +
			`Peak in ${WATER_YEAR_MONTHS[peakMonth]} at ${fmtNum(demandTotal.monthly[peakMonth])} m³/day. Show table holds the values.`
	);
	let chartW = $state(0);
	let chartH = $state(0);
	// The legend under the bars: one line when wide, room for two when narrow.
	const barsH = $derived(Math.max(140, chartH - (chartW < 520 ? 46 : 26)));
	// From 1100 px the lower row (chart beside the farm bars) reaches the window's bottom, less what the
	// page keeps below it (its padding, room for the save bar), as the Network's map does; measured, not assumed.
	let lowerEl: HTMLDivElement | undefined = $state();
	let lowerTop = $state(0);
	let lowerBelow = $state(0);
	$effect(() => {
		if (!lowerEl) return;
		const measure = () => {
			if (!lowerEl) return;
			const r = lowerEl.getBoundingClientRect();
			lowerTop = r.top + window.scrollY;
			lowerBelow = Math.max(0, document.documentElement.scrollHeight - (r.bottom + window.scrollY));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	let tableOpen = $state(false);
	// The crops planted somewhere, for the bars' legend.
	const plantedCrops = $derived(crops.filter((c) => bars.some((b) => b.parts.some((p) => p.cropId === c.id))));

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

{#if sections}
	<CropGrids {editor} {settings} {readonly} {sections} />
{:else}
	{#if crops.length === 0}
		<section class="panel" aria-label="No crops yet">
			<div class="empty">
				<p>No crops defined. Add each irrigated crop (e.g. citrus, vines, pasture) with its monthly crop factors.</p>
				{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
			</div>
		</section>
	{:else}
		<section class="cards" aria-label="Crops">
			{#each cards as c (c.id)}
				<article class="panel card" aria-labelledby="crop-card-{c.id}" data-testid="crop-card">
					<div class="card-head">
						<h3 id="crop-card-{c.id}"><span class="key" style:background={colourOf(c.id)} aria-hidden="true"></span>{c.name}</h3>
						<button type="button" class="btn btn-sm" aria-label="{readonly ? 'View' : 'Edit'} {c.name}" onclick={() => openCrop(c.id)}>{readonly ? 'View' : 'Edit'}</button>
					</div>
					<p class="muted small facts">
						{ha(c.areaM2)} ha · {c.peak >= 0 ? `peak need in ${WATER_YEAR_MONTHS[c.peak]}` : 'no crop factors yet'}
					</p>
					<svg viewBox="0 0 {SPARK_W} {SPARK_H}" preserveAspectRatio="none" class="spark" role="img" aria-label={c.label}>
						<line x1="0" x2={SPARK_W} y1={SPARK_H - 4} y2={SPARK_H - 4} class="spark-base" />
						<path d={c.fill} class="spark-fill" />
						<polyline points={c.line} class="spark-line" />
					</svg>
					<div class="spark-months" aria-hidden="true"><span>Oct</span><span>Jan</span><span>Apr</span><span>Jul</span><span>Sep</span></div>
					{#if c.high.length}
						<p class="warn small">Factor above 1.0 in {c.high.join(', ')}: check it isn't an FAO Kc entered as it is.</p>
					{/if}
				</article>
			{/each}
		</section>
	{/if}

	<div class="lower" bind:this={lowerEl} style:--lower-top="{lowerTop}px" style:--lower-below="{lowerBelow}px">
		<section class="panel dem-card" aria-labelledby="crop-dem-h">
			<div class="panel-head">
				<h3 id="crop-dem-h">Irrigation demand by month <HelpTip key="settings.apanMm" label="About A-pan evaporation" /></h3>
				<span class="muted small">Gross demand, whole catchment, m³/day</span>
			</div>
			{#if !apanSet}
				<div class="alert alert-info">
					A-pan evaporation isn't set yet, so demand is zero. <a href="?tab=settings">Enter the monthly A-pan values</a>
					(Settings & calibration, Demand).
				</div>
			{/if}
			{#if farms.length === 0}
				<p class="muted">No units yet. Add units on the <a href="?tab=network">Network</a>.</p>
			{:else}
				{#if stacks.length && demandTotal.annual > 0}
					<figure class="demand-chart" bind:clientWidth={chartW} bind:clientHeight={chartH}>
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
					<p class="muted">No demand yet: add crops with their factors and each unit's planted area.</p>
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
				<h3 id="crop-area-h">Planted area by unit</h3>
				<a class="btn btn-sm" href={withParam(page.url, 'grid', 'planted-areas')}>{readonly ? 'Areas table' : 'Edit areas'}</a>
			</div>
			{#if farms.length === 0 || crops.length === 0}
				<p class="muted">Add at least one unit (<a href="?tab=network">Network</a>) and one crop to enter planted areas.</p>
			{:else}
				{#if bars.length}
					<ul class="bars" aria-label="Planted area by unit">
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
					<ul class="legend" aria-hidden="true">
						{#each plantedCrops as c (c.id)}<li><span class="key" style:background={colourOf(c.id)}></span>{c.name || '(unnamed)'}</li>{/each}
					</ul>
				{/if}
				{#if unplantedNote}<p class="muted small note">{unplantedNote}</p>{/if}
			{/if}
		</section>
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
	.cards {
		display: grid;
		/* Four to a row where they fit (A3), fewer as the width shrinks; a lone crop keeps a card's width. */
		grid-template-columns: repeat(auto-fill, minmax(max(15rem, calc(25% - 0.75rem)), 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.card {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.card h3 {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		font-size: 1.05rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.key {
		flex: none;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
	}
	.facts {
		margin: 0;
	}
	.spark {
		display: block;
		width: 100%;
		height: 64px;
	}
	.spark-base {
		stroke: var(--border);
		vector-effect: non-scaling-stroke;
	}
	.spark-fill {
		fill: var(--accent);
		opacity: 0.14;
	}
	.spark-line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.spark-months {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.warn {
		margin: 0.2rem 0 0;
		color: var(--warning);
	}
	.small {
		font-size: 0.85rem;
	}
	.lower {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.lower > .panel {
		margin: 0;
		min-width: 0;
	}
	.panel-head h3 {
		font-size: 1.05rem;
	}
	/* The chart takes its box's measured size (no zoomed text); the box's height comes from the layout. */
	.demand-chart {
		position: relative;
		height: 260px;
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
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
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
		min-height: 32px;
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
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin: 0.7rem 0 0;
		padding: 0;
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
		margin: 0.6rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	/* Demand chart beside the farm bars once there's room for both (A3's lower row). */
	@media (min-width: 1100px) {
		.lower {
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 28rem);
			min-height: max(380px, calc(100vh - var(--lower-top, 0px) - var(--lower-below, 0px)));
			align-items: stretch;
		}
		.dem-card {
			display: flex;
			flex-direction: column;
		}
		.demand-chart {
			flex: 1;
			height: auto;
			min-height: 240px;
			max-height: 480px;
		}
	}
	@media (max-width: 640px) {
		.demand-chart {
			height: 230px;
		}
		.bars li {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.2rem 0.6rem;
		}
		.track {
			grid-column: 1 / -1;
			grid-row: 2;
		}
		.farm {
			min-height: 44px;
		}
	}
</style>
