<script module lang="ts">
	// The Load crop factors dialog (issue #54 item 1) is its own chunk, fetched when first opened.
	const loadCropFactors = () => import('./LoadCropFactorsDialog.svelte');
</script>

<script lang="ts">
	// The Crops & demand grids: crop factors, planted areas and the demand
	// preview, as full tables. The grid modal shows one section each
	// (model/GridModal.svelte, `sections`), scenario override mode all three
	// (scenarios/OverrideEditor.svelte). The Crops page itself (CropsTab) is
	// cards and bars over the same editor.
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { findSystem, systemLabel, systemsOf } from '$lib/model/systems';
	import type { ProjectSettings } from '@water-management/engine';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { prefetch } from '$lib/components/common/lazy';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MoveControls from '$lib/components/model/MoveControls.svelte';
	import { refocusMover, RowReorder } from '$lib/components/model/rowReorder.svelte';
	import { moveTo, reorderSubset } from '$lib/model/order';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import MonthlyBars from '$lib/components/settings/MonthlyBars.svelte';
	import { catchmentDemand, cropStacks, DAILY_APAN_NO_MEANS, demandApanNote, farmDemands, highCropFactors, noPlantedAreaNote } from './demand';
	import { cropAreaTotals, cropColouring, OTHER_COLOUR, rankCrops } from './cards';
	import DemandTable from './DemandTable.svelte';
	import GridPasteDialog from '$lib/components/model/GridPasteDialog.svelte';
	import { gridPasteTarget, type PasteAnchor, type PastePlan } from '$lib/spreadsheet/paste/grid';
	import { applyAreaPaste, applyFactorPaste, cropFactorsCsv, planFactorPaste, plantedAreasCsv, planAreaPaste } from './areaPaste';

	let {
		editor,
		settings,
		readonly,
		sections,
		apanDaily = false,
		inModal = false
	}: {
		editor: ModelEditor;
		settings: ProjectSettings;
		readonly: boolean;
		/** Only these sections (the grid modal shows one, lib/workspace/overlays.ts); all when absent. */
		sections?: readonly ('factors' | 'areas' | 'demand')[];
		/** The project has a daily A-pan series, which runs use instead of the monthly means on the days it covers (model.md §2.3a). */
		apanDaily?: boolean;
		/** In the grid modal, whose title names the grid: no heading of its own (one heading per modal, playbook § 2). */
		inModal?: boolean;
	} = $props();
	const show = (s: 'factors' | 'areas' | 'demand') => !sections || sections.includes(s);

	const crops = $derived(editor.model.crops);
	// Farms, plus any other node that already carries crop areas.
	const farms = $derived(
		editor.model.nodes.filter((n) => n.kind === 'farm' || editor.model.cropAreas.some((a) => a.nodeId === n.id))
	);

	const rowTotal = (nodeId: string) =>
		editor.model.cropAreas.filter((a) => a.nodeId === nodeId).reduce((s, a) => s + a.areaM2, 0);
	const colTotal = (cropId: string) =>
		editor.model.cropAreas
			.filter((a) => a.cropId === cropId && farms.some((f) => f.id === a.nodeId))
			.reduce((s, a) => s + a.areaM2, 0);
	const grandTotal = $derived(crops.reduce((s, c) => s + colTotal(c.id), 0));
	// Factors multiply A-pan, not ET₀: above 1.0 is worth a second look (a hint, never blocking).
	const highFactors = $derived(highCropFactors(crops, WATER_YEAR_MONTHS));

	// Demand preview: saved A-pan × current (possibly unsaved) crops and areas.
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	// The preview reads the monthly means only; a run reads a daily A-pan series first (issue #173).
	const apanNote = $derived(demandApanNote(apanDaily));
	const demand = $derived(
		farmDemands(
			editor.model,
			settings.apanMm,
			settings.februaryDays,
			farms.map((f) => f.id)
		)
	);
	const demandTotal = $derived(catchmentDemand(demand));
	// Farms with nothing planted (unsaved edits included): their demand is zero.
	const unplantedNote = $derived(noPlantedAreaNote(farms.filter((f) => rowTotal(f.id) === 0).map((f) => f.name || '(unnamed)')));

	// Stacked chart above the demand table: the same numbers, split by crop,
	// in the crop colours the Crops page uses (cards.ts cropColouring: ranked by planted area).
	const stacks = $derived.by(() => {
		const ranked = rankCrops(crops, cropAreaTotals(editor.model.cropAreas, farms.map((f) => f.id)));
		const { colours, named } = cropColouring(ranked);
		return cropStacks(demand, crops, named).map((s) => ({ ...s, color: colours.get(s.id) ?? OTHER_COLOUR }));
	});
	const peakMonth = $derived(demandTotal.monthly.reduce((best, v, m, a) => (v > a[best]! ? m : best), 0));
	const chartLabel = $derived(
		`Catchment irrigation demand by month, stacked by crop (${stacks.map((s) => s.name).join(', ')}). ` +
			`Peak in ${WATER_YEAR_MONTHS[peakMonth]} at ${fmtNum(demandTotal.monthly[peakMonth])} m³/day. The table below holds the values.` +
			(apanNote ? ` ${apanNote}` : '')
	);

	function add() {
		const c = editor.addCrop();
		queueMicrotask(() => document.getElementById(`crop-name-${c.id}`)?.focus());
	}

	async function remove(id: string, name: string) {
		const used = editor.model.cropAreas.some((a) => a.cropId === id);
		if (
			used &&
			!(await confirmDialog({
				title: `Remove crop “${name}”?`,
				message: 'Its planted areas on every hydrological unit are removed too.',
				confirmLabel: 'Remove crop',
				danger: true
			}))
		)
			return;
		editor.removeCrop(id);
	}

	const ha = (m2: number) => fmtNum(m2 / 10_000, 2);

	// Load crop factors: mounted on first open, then kept (its state survives a close).
	let loadMounted = $state(false);
	let loadOpen = $state(false);
	function openLoad() {
		loadMounted = true;
		loadOpen = true;
	}
	const loaded = (names: string[]) =>
		(announce = `Loaded crop factors into ${names.join(', ')}. Review them and save the model to keep them.`);

	// --- display order: crops have their own; farm rows share the node order ---
	let announce = $state('');
	function moveCrop(from: number, to: number, focus: 'up' | 'down' | null = null) {
		const c = crops[from];
		if (!c || to < 0 || to >= crops.length) return;
		editor.model.crops = moveTo(editor.model.crops, from, to);
		announce = `${c.name || 'Crop'} moved to position ${to + 1} of ${crops.length}.`;
		if (focus) void refocusMover('mvc', c.id, focus);
	}
	function moveFarm(from: number, to: number, focus: 'up' | 'down' | null = null) {
		const f = farms[from];
		if (!f || to < 0 || to >= farms.length) return;
		editor.model.nodes = reorderSubset(editor.model.nodes, farms.map((x) => x.id), from, to);
		announce = `${f.name || 'Unit'} moved to row ${to + 1} of ${farms.length} (network order).`;
		if (focus) void refocusMover('mvf', f.id, focus);
	}
	// --- paste a block of hectares from a spreadsheet (issue #285): into a cell, or from the button ---
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteAnchor = $state<PasteAnchor | null>(null);
	const pasteWhere = $derived(pasteAnchor ? `${farms[pasteAnchor.row]?.name || '(unnamed)'}, ${crops[pasteAnchor.col]?.name || '(unnamed)'}` : null);
	function onAreasPaste(e: ClipboardEvent) {
		const t = gridPasteTarget(e);
		if (!t) return;
		pasteAnchor = t.anchor;
		pasteText = t.text;
		pasteOpen = true;
	}
	function openPaste() {
		pasteAnchor = null;
		pasteText = '';
		pasteOpen = true;
	}
	function applyPaste(plan: PastePlan) {
		applyAreaPaste(plan, (nodeId, cropId, m2) => editor.setCropArea(nodeId, cropId, m2));
		announce = `Pasted ${plan.changes.length} planted ${plan.changes.length === 1 ? 'area' : 'areas'}. Save the model to keep them.`;
	}
	// The crop factors take a pasted block the same way: one copied row of 12 months, or the whole table.
	let factorPasteOpen = $state(false);
	let factorPasteText = $state('');
	let factorAnchor = $state<PasteAnchor | null>(null);
	const factorWhere = $derived(factorAnchor ? `${crops[factorAnchor.row]?.name || '(unnamed)'}, ${WATER_YEAR_MONTHS[factorAnchor.col] ?? 'Oct'}` : null);
	function onFactorsPaste(e: ClipboardEvent) {
		const t = gridPasteTarget(e);
		if (!t) return;
		factorAnchor = t.anchor;
		factorPasteText = t.text;
		factorPasteOpen = true;
	}
	function openFactorPaste() {
		factorAnchor = null;
		factorPasteText = '';
		factorPasteOpen = true;
	}
	function applyFactors(plan: PastePlan) {
		applyFactorPaste(plan, (cropId, m, f) => {
			const c = editor.model.crops.find((x) => x.id === cropId);
			if (c) c.cropFactor[m] = f;
		});
		announce = `Pasted ${plan.changes.length} crop ${plan.changes.length === 1 ? 'factor' : 'factors'}. Save the model to keep them.`;
	}

	const cropReorder = new RowReorder(() => crops.map((c) => c.id), (from, to) => moveCrop(from, to));
	const farmReorder = new RowReorder(() => farms.map((f) => f.id), (from, to) => moveFarm(from, to));
	// Each planting's irrigation system (engine ≥ 1.72.0): its own on the unit, else its crop's default.
	const systems = $derived(systemsOf(editor.model));
	const ownSystem = (nodeId: string, cropId: string) => editor.model.cropAreas.find((a) => a.nodeId === nodeId && a.cropId === cropId)?.irrigationSystemId ?? '';
	const cropDefault = (cropId: string) => findSystem(editor.model, editor.model.crops.find((c) => c.id === cropId)?.irrigationSystemId);
	const defaultText = (cropId: string) => {
		const d = cropDefault(cropId);
		return d ? `Default: ${d.name}` : "Default: the unit's own";
	};
	const systemText = (nodeId: string, cropId: string) => {
		const own = findSystem(editor.model, ownSystem(nodeId, cropId) || null);
		const s = own ?? cropDefault(cropId);
		return s ? `${s.name}${own ? '' : ' (default)'}` : "the unit's own";
	};

</script>

<p class="visually-hidden" aria-live="polite">{announce}</p>

<!-- The container the phone layout queries (a query never styles its own container: playbook § 2). -->
<div class="crop-grids">

{#if show('factors')}
<section class="panel" aria-labelledby={inModal ? undefined : 'crops-h'}>
	{#if !inModal}
		<div class="panel-head">
			<h2 id="crops-h">Crop factors <HelpTip key="crop.cropFactor" /></h2>
			<span class="muted small">Water year, October → September</span>
		</div>
	{/if}
	<!-- One line: what a factor is and isn't; the FAO Kc conversion is in the ⓘ and the glossary (issue #463). -->
	<p class="muted small intro" data-testid="crop-factors-intro">
		{#if inModal}Water year, October → September. <HelpTip key="crop.cropFactor" />{/if}
		Gross irrigation need (mm) = A-pan × crop factor: <strong>× A-pan, not an FAO Kc</strong>. 0 is a month the crop isn't irrigated.
	</p>
	{#if crops.length === 0}
		<div class="empty">
			<p>No crops defined. Add each irrigated crop (e.g. citrus, vines, pasture) with its monthly crop factors.</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
		</div>
	{:else}
		<!-- The grid's actions above it, not under up to 30 crop rows (issue #463, as #461 did for the EWR settings). -->
		{#if !readonly}
			<div class="toolbar grid-actions" data-testid="grid-actions">
				<button type="button" class="btn" onclick={add}>+ Add crop</button>
				<button type="button" class="btn" onclick={openLoad} onpointerenter={() => prefetch(loadCropFactors)} onfocus={() => prefetch(loadCropFactors)}>Load crop factors…</button>
				<button type="button" class="btn" onclick={openFactorPaste}>Paste from a spreadsheet…</button>
			</div>
		{/if}
		<div class="table-wrap">
			<table class="data compact factors" class:editable={!readonly}>
				<thead>
					<tr>
						<th scope="col" class="sticky">Crop</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody bind:this={cropReorder.body} onpaste={readonly ? undefined : onFactorsPaste}>
					{#each crops as crop, ci (crop.id)}
						{@const label = crop.name || 'unnamed crop'}
						{@const rs = cropReorder.rowState(crop.id, ci, crops.length)}
						<tr data-idx={ci} class:dragging={rs.dragging} class:drop-before={rs.before} class:drop-after={rs.after}>
							<th scope="row" class="sticky" data-paste-col="0">
								<span class="namecell">
									{#if !readonly}
										<MoveControls id={crop.id} {label} index={ci} count={crops.length} reorder={cropReorder} idPrefix="mvc" onmove={(d) => moveCrop(ci, ci + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<input id="crop-name-{crop.id}" aria-label="Crop name" maxlength="100" readonly={readonly} bind:value={crop.name} />
								</span>
							</th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td data-paste-col={i}>
									<span class="cell-label" aria-hidden="true">{m}</span>
									<!-- Cleared, a factor is 0 (a month the crop isn't irrigated): the model never keeps a value the field doesn't show. -->
									<NumberInput
										label="{label} crop factor, {m}"
										min={0}
										step={0.01}
										disabled={readonly}
										nullable
										bind:value={() => crop.cropFactor[i] ?? 0, (v) => (crop.cropFactor[i] = v ?? 0)}
									/>
								</td>
							{/each}
							{#if !readonly}
								<td class="rm"><button type="button" class="btn btn-icon" aria-label="Remove {label}" title="Remove crop" onclick={() => remove(crop.id, label)}>✕</button></td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if highFactors.length}
			<p class="alert alert-warning small" role="status">
				A crop factor above 1.0 means the crop uses more water than an open A-pan loses. That can happen, but check it isn't an
				FAO Kc entered as it is:
				{#each highFactors as h, i (h.id)}{i ? '; ' : ' '}<strong>{h.name || 'unnamed crop'}</strong> ({h.months.join(', ')}){/each}.
			</p>
		{/if}
		{#if !readonly}
			<GridPasteDialog
				bind:open={factorPasteOpen}
				bind:text={factorPasteText}
				title="Paste crop factors"
				layout="Crop factors (× A-pan): a row per crop with its name first, under a heading row of months, Oct to Sep (as the CSV below has them); without names or headings the values fill the grid from the cell you pasted into, so one copied row of 12 months fills a crop. 0 is a month the crop isn't irrigated."
				where={factorWhere}
				plan={(t) => planFactorPaste(t, crops, factorAnchor)}
				onapply={applyFactors}
				csv={() => cropFactorsCsv(crops)}
				csvName="crop-factors.csv"
			/>
		{/if}
	{/if}
</section>
{#if loadMounted}
	<Lazy load={loadCropFactors}>
		{#snippet children(LoadCropFactorsDialog)}
			<LoadCropFactorsDialog bind:open={loadOpen} {editor} {settings} farmIds={farms.map((f) => f.id)} onapplied={loaded} />
		{/snippet}
	</Lazy>
{/if}
{/if}

{#if show('areas')}
<section class="panel" aria-labelledby={inModal ? undefined : 'areas-h'}>
	{#if inModal}
		<p class="muted small intro">Irrigated area per hydrological unit and crop, hectares, and its irrigation system there · rows follow the network order</p>
	{:else}
		<div class="panel-head">
			<h2 id="areas-h">Planted areas</h2>
			<span class="muted small">Irrigated area per hydrological unit and crop, hectares, and its irrigation system there · rows follow the network order</span>
		</div>
	{/if}
	{#if farms.length === 0 || crops.length === 0}
		<p class="muted">
			Add at least one hydrological unit (<a href="?tab=network">Network tab</a>) and one crop to enter planted areas.
		</p>
	{:else}
		{#if !readonly}
			<div class="toolbar grid-actions" data-testid="grid-actions">
				<button type="button" class="btn" onclick={openPaste}>Paste from a spreadsheet…</button>
			</div>
		{/if}
		<div class="table-wrap">
			<table class="data compact areas">
				<thead>
					<tr>
						<th scope="col" class="sticky">Hydrological unit</th>
						{#each crops as c (c.id)}<th scope="col" class="num">{c.name || '(unnamed)'}<br /><span class="u">ha</span></th>{/each}
						<th scope="col" class="num">Total<br /><span class="u">ha</span></th>
					</tr>
				</thead>
				<tbody bind:this={farmReorder.body} onpaste={readonly ? undefined : onAreasPaste}>
					{#each farms as f, fi (f.id)}
						{@const rs = farmReorder.rowState(f.id, fi, farms.length)}
						<tr data-idx={fi} class:dragging={rs.dragging} class:drop-before={rs.before} class:drop-after={rs.after}>
							<th scope="row" class="sticky" data-paste-col="0">
								<span class="namecell">
									{#if !readonly}
										<MoveControls id={f.id} label={f.name || 'unit'} index={fi} count={farms.length} reorder={farmReorder} idPrefix="mvf" onmove={(d) => moveFarm(fi, fi + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<span>{f.name || '(unnamed)'}</span>
								</span>
							</th>
							{#each crops as c, ci (c.id)}
								<td data-paste-col={ci}>
									<span class="cell-label" aria-hidden="true">{c.name || '(unnamed)'} <span class="u">ha</span></span>
									<!-- Cleared, an area is 0: nothing planted (the editor drops the row). -->
									<NumberInput
										label="{c.name || 'crop'} on {f.name || 'unit'}, ha"
										min={0}
										step={0.1}
										scale={1 / 10_000}
										disabled={readonly}
										nullable
										bind:value={() => editor.cropArea(f.id, c.id), (n) => editor.setCropArea(f.id, c.id, n ?? 0)}
									/>
									<!-- Its irrigation system on this unit (engine ≥ 1.72.0), once planted: the crop's default unless the unit has its own. -->
									{#if editor.cropArea(f.id, c.id) > 0}
										{#if readonly}
											<span class="sys-text" data-testid="area-system">{systemText(f.id, c.id)}</span>
										{:else}
											<select
												class="sys"
												aria-label="Irrigation system of {c.name || 'crop'} on {f.name || 'unit'}"
												value={ownSystem(f.id, c.id)}
												onchange={(e) => editor.setPlantingSystem(f.id, c.id, e.currentTarget.value || null)}
											>
												<option value="">{defaultText(c.id)}</option>
												{#each systems as x (x.id)}<option value={x.id}>{systemLabel(x)}</option>{/each}
											</select>
										{/if}
									{/if}
								</td>
							{/each}
							<td class="num total"><span class="cell-label">Total{' '}</span>{ha(rowTotal(f.id))}<span class="cell-label">{' '}ha</span></td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<th scope="row" class="sticky">Total</th>
						{#each crops as c (c.id)}
							<td class="num"><span class="cell-label">{c.name || '(unnamed)'}{' '}</span>{ha(colTotal(c.id))} ha</td>
						{/each}
						<td class="num"><span class="cell-label">All crops{' '}</span>{ha(grandTotal)} ha</td>
					</tr>
				</tfoot>
			</table>
		</div>
		{#if unplantedNote}<p class="muted small after">{unplantedNote}</p>{/if}
		{#if !readonly}
			<GridPasteDialog
				bind:open={pasteOpen}
				bind:text={pasteText}
				title="Paste planted areas"
				layout="Hectares: a row per hydrological unit with its name first, under a heading row of crop names (as the CSV below has them); without names or headings the values fill the grid from the cell you pasted into, in its order. 0 clears an area."
				where={pasteWhere}
				plan={(t) => planAreaPaste(t, farms, crops, editor.model.cropAreas, pasteAnchor)}
				onapply={applyPaste}
				csv={() => plantedAreasCsv(farms, crops, editor.model.cropAreas)}
				csvName="planted-areas.csv"
			/>
		{/if}
	{/if}
</section>
{/if}

{#if show('demand')}
<section class="panel" aria-labelledby="dem-h">
	<div class="panel-head">
		<h2 id="dem-h">Irrigation demand preview <HelpTip key="settings.apanMm" label="About A-pan evaporation" /></h2>
		<span class="muted small">Before rain, ÷ irrigation efficiency, m³/day per month</span>
	</div>
	{#if !apanSet}
		<div class="alert alert-info">
			{#if apanDaily}
				{DAILY_APAN_NO_MEANS} <a href="?tab=settings#set-demand">Enter the monthly A-pan values</a> (Settings & calibration, Demand) for the other days.
			{:else}
				A-pan evaporation isn't set yet, so demand is zero. <a href="?tab=settings#set-demand">Enter the monthly A-pan values</a>
				(Settings & calibration, Demand).
			{/if}
		</div>
	{:else if apanNote}
		<p class="small muted" data-testid="crops-demand-apan">{apanNote}</p>
	{/if}
	{#if farms.length === 0}
		<p class="muted">No hydrological units yet.</p>
	{:else}
		{#if stacks.length && demandTotal.annual > 0}
			<figure class="demand-chart">
				<MonthlyBars {stacks} unit="m³/day" label="Irrigation demand" ariaLabel={chartLabel} />
			</figure>
		{/if}
		<DemandTable {farms} {demand} {settings} total={demandTotal} areaM2={grandTotal} />
	{/if}
</section>
{/if}
</div>

<style>
	.areas .sys {
		display: block;
		width: 100%;
		min-width: 0;
		margin-top: 0.2rem;
		font-size: 0.75rem;
		padding: 0.1rem 0.2rem;
		/* WCAG 2.5.8's 24 px target. */
		min-height: 24px;
	}
	.areas .sys-text {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.75rem;
		color: var(--text-muted);
		text-align: right;
	}
	.crop-grids {
		container: crop-grids / inline-size;
	}
	.intro {
		margin: -0.25rem 0 0.75rem;
		max-width: 75ch;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
	}
	thead th.sticky,
	tfoot th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.factors th[scope='row'] {
		min-width: 150px;
	}
	.factors td {
		min-width: 64px;
	}
	.factors td :global(input[type='number']) {
		min-width: 3.8rem;
	}
	.areas td {
		min-width: 100px;
	}
	.areas th[scope='row'] {
		min-width: 130px;
		white-space: nowrap;
	}
	.total {
		font-weight: 600;
	}
	.namecell {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.namecell input {
		flex: 1;
		min-width: 110px;
	}
	tr.dragging {
		opacity: 0.5;
	}
	tr.drop-before > * {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	tr.drop-after > * {
		box-shadow: inset 0 -2px 0 var(--accent);
	}
	.demand-chart {
		margin: 0 0 1rem;
		max-width: 420px;
	}
	.after {
		margin: 0.75rem 0 0;
	}
	/* Phones: each row of the crop-factor and planted-area tables becomes a card
	   with visible field labels, instead of a sideways-scrolling table whose
	   sticky name column leaves room for one month. */
	.cell-label {
		display: none;
	}
	/* 80rem is 1 120 px at the 14 px root: the factor table's own least width (a 150 px name column and twelve
	   64 px months, with their inputs and padding, measured 1 114 px), so any narrower column stacks rather than
	   scrolls sideways: override mode's beside the Scenarios rail at 1024 (~760 px), the grid modal under ~1 150. */
	@container crop-grids (max-width: 80rem) {
		.factors thead,
		.areas thead {
			display: none;
		}
		.factors,
		.factors tbody,
		.areas,
		.areas tbody,
		.areas tfoot {
			display: block;
		}
		.factors tr,
		.areas tr {
			display: grid;
			gap: 0.5rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border);
		}
		.factors tr:last-child,
		.areas tbody tr:last-child {
			border-bottom: none;
		}
		.factors tr > *,
		.areas tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
		}
		th.sticky {
			position: static;
			background: none;
		}
		.namecell input {
			min-width: 0;
		}
		.factors td :global(input[type='number']),
		.areas td :global(input[type='number']) {
			min-width: 0;
		}
		.cell-label {
			display: block;
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-2);
			margin-bottom: 0.15rem;
		}
		/* Crop factors: name (and remove) on top, the months four to a row. */
		.factors tr {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.factors th[scope='row'] {
			grid-column: 1 / -1;
		}
		.factors.editable th[scope='row'] {
			grid-column: 1 / 4;
			grid-row: 1;
		}
		.factors .rm {
			grid-column: 4;
			grid-row: 1;
			justify-self: end;
		}
		/* Planted areas: farm name on top, crops two to a row, total last. */
		.areas tr {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.areas th[scope='row'],
		.areas .total {
			grid-column: 1 / -1;
		}
		.areas tfoot tr {
			background: var(--surface-2);
			border-top: 2px solid var(--border-strong);
		}
		.areas tfoot tr > * {
			background: none;
		}
		.areas .total .cell-label,
		.areas tfoot .cell-label {
			display: inline;
			margin: 0;
		}
		tr.drop-before > *,
		tr.drop-after > * {
			box-shadow: none;
		}
		tr.drop-before {
			box-shadow: inset 0 2px 0 var(--accent);
		}
		tr.drop-after {
			box-shadow: inset 0 -2px 0 var(--accent);
		}
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
</style>
