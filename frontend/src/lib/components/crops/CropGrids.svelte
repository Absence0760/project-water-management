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
	import { applyAreaPaste, plantedAreasCsv, planAreaPaste } from './areaPaste';

	let {
		editor,
		settings,
		readonly,
		sections,
		apanDaily = false
	}: {
		editor: ModelEditor;
		settings: ProjectSettings;
		readonly: boolean;
		/** Only these sections (the grid modal shows one, lib/workspace/overlays.ts); all when absent. */
		sections?: readonly ('factors' | 'areas' | 'demand')[];
		/** The project has a daily A-pan series, which runs use instead of the monthly means on the days it covers (model.md §2.3a). */
		apanDaily?: boolean;
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
		announce = `${f.name || 'Farm'} moved to row ${to + 1} of ${farms.length} (network order).`;
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

	const cropReorder = new RowReorder(() => crops.map((c) => c.id), (from, to) => moveCrop(from, to));
	const farmReorder = new RowReorder(() => farms.map((f) => f.id), (from, to) => moveFarm(from, to));
</script>

<p class="visually-hidden" aria-live="polite">{announce}</p>

{#if show('factors')}
<section class="panel" aria-labelledby="crops-h">
	<div class="panel-head">
		<h2 id="crops-h">Crop factors <HelpTip key="crop.cropFactor" /></h2>
		<span class="muted small">Water year, October → September</span>
	</div>
	<p class="muted small intro">
		A crop factor scales monthly A-pan evaporation to the crop's water use: gross irrigation need (mm) = A-pan × crop
		factor. It is <strong>× A-pan, not an FAO Kc</strong>: FAO-56 Kc values multiply reference ET₀, about 0.6–0.85 × pan (0.35–0.85 in FAO-56 Table 5), so
		multiply a published Kc by the pan coefficient before entering it. Use 0 for months the crop isn't irrigated.
	</p>
	{#if crops.length === 0}
		<div class="empty">
			<p>No crops defined. Add each irrigated crop (e.g. citrus, vines, pasture) with its monthly crop factors.</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add crop</button>{/if}
		</div>
	{:else}
		<div class="table-wrap">
			<table class="data compact factors" class:editable={!readonly}>
				<thead>
					<tr>
						<th scope="col" class="sticky">Crop</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody bind:this={cropReorder.body}>
					{#each crops as crop, ci (crop.id)}
						{@const label = crop.name || 'unnamed crop'}
						{@const rs = cropReorder.rowState(crop.id, ci, crops.length)}
						<tr data-idx={ci} class:dragging={rs.dragging} class:drop-before={rs.before} class:drop-after={rs.after}>
							<th scope="row" class="sticky">
								<span class="namecell">
									{#if !readonly}
										<MoveControls id={crop.id} {label} index={ci} count={crops.length} reorder={cropReorder} idPrefix="mvc" onmove={(d) => moveCrop(ci, ci + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<input id="crop-name-{crop.id}" aria-label="Crop name" maxlength="100" readonly={readonly} bind:value={crop.name} />
								</span>
							</th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td>
									<span class="cell-label" aria-hidden="true">{m}</span>
									<NumberInput
										label="{label} crop factor, {m}"
										min={0}
										step={0.01}
										disabled={readonly}
										bind:value={crop.cropFactor[i]}
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
			<div class="toolbar after">
				<button type="button" class="btn" onclick={add}>+ Add crop</button>
				<button type="button" class="btn" onclick={openLoad} onpointerenter={() => prefetch(loadCropFactors)} onfocus={() => prefetch(loadCropFactors)}>Load crop factors…</button>
			</div>
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
<section class="panel" aria-labelledby="areas-h">
	<div class="panel-head">
		<h2 id="areas-h">Planted areas</h2>
		<span class="muted small">Irrigated area per hydrological unit and crop, hectares · rows follow the network order</span>
	</div>
	{#if farms.length === 0 || crops.length === 0}
		<p class="muted">
			Add at least one hydrological unit (<a href="?tab=network">Network tab</a>) and one crop to enter planted areas.
		</p>
	{:else}
		<div class="table-wrap">
			<table class="data compact areas">
				<thead>
					<tr>
						<th scope="col" class="sticky">Farm</th>
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
										<MoveControls id={f.id} label={f.name || 'farm'} index={fi} count={farms.length} reorder={farmReorder} idPrefix="mvf" onmove={(d) => moveFarm(fi, fi + d, d < 0 ? 'up' : 'down')} />
									{/if}
									<span>{f.name || '(unnamed)'}</span>
								</span>
							</th>
							{#each crops as c, ci (c.id)}
								<td data-paste-col={ci}>
									<span class="cell-label" aria-hidden="true">{c.name || '(unnamed)'} <span class="u">ha</span></span>
									<NumberInput
										label="{c.name || 'crop'} on {f.name || 'farm'}, ha"
										min={0}
										step={0.1}
										scale={1 / 10_000}
										disabled={readonly}
										value={editor.cropArea(f.id, c.id)}
										onchange={(n) => editor.setCropArea(f.id, c.id, n ?? 0)}
									/>
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
			<div class="toolbar after">
				<button type="button" class="btn" onclick={openPaste}>Paste from a spreadsheet…</button>
			</div>
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
		<span class="muted small">Gross demand, m³/day per month</span>
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

<style>
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
	@media (max-width: 640px) {
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
