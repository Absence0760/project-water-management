<script lang="ts">
	// One farm's planted areas in a side sheet over any workspace tab (issue
	// #17, option A step 4; `farm=<nodeId>` in the URL, farmDrawer.ts). It edits
	// the shared ModelEditor, as the Crops tab's Planted areas table does, so an
	// edit here shows there and the other way round. The sheet is modal, which
	// makes the page's save bar unreachable while it is open, so it carries the
	// same save row: reason, Save changes (the page's save), and Done. Under the
	// areas, "From land cover" proposes a crop's area from the unit's parcels on
	// the map (issue #326 B-landcover, CroplandProposalsBox.svelte).
	import { untrack } from 'svelte';
	import type { ProjectSettings } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import ModelSaveRow from '$lib/components/model/ModelSaveRow.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import CroplandProposalsBox from './CroplandProposalsBox.svelte';
	import { farmDemands } from './demand';
	import { farmPlanting, inOrder, plantedFirst } from './farmDrawer';

	let {
		open = $bindable(false),
		editor,
		settings,
		nodeId,
		readonly,
		onsave,
		reason = $bindable(''),
		projectId,
		onModelChanged = () => {}
	}: {
		open?: boolean;
		editor: ModelEditor;
		settings: ProjectSettings;
		/** The farm (network node) whose areas are shown. */
		nodeId: string;
		readonly: boolean;
		/** The page's model save (the save bar's Save changes). */
		onsave: () => void;
		/** The save bar's reason, shared, so it goes with whichever save runs. */
		reason?: string;
		/** The project: with it, a hydrological unit's drawer proposes areas from land cover. */
		projectId?: string;
		/** After a value from land cover is saved to the model: reload the inputs. */
		onModelChanged?: () => Promise<void> | void;
	} = $props();

	const node = $derived(editor.model.nodes.find((n) => n.id === nodeId) ?? null);
	const name = $derived(node?.name || '(unnamed)');
	const planting = $derived(farmPlanting(editor.model, nodeId));
	// The crops planted here first, largest first: ordered as the drawer opens (or moves to another unit), then
	// kept, so a row doesn't jump while its area is typed (farmDrawer.ts plantedFirst).
	const order = $derived.by(() => {
		void open;
		void nodeId;
		return untrack(() => plantedFirst(planting.rows));
	});
	const rows = $derived(inOrder(planting.rows, order));
	// Saved A-pan × the areas as edited, as the Crops tab's demand preview.
	const demand = $derived(farmDemands(editor.model, settings.apanMm, settings.februaryDays, [nodeId])[0] ?? null);
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	const peak = $derived(demand ? demand.monthlyM3Day.reduce((best, v, m, a) => (v > a[best]! ? m : best), 0) : 0);
	const ha = (m2: number) => fmtNum(m2 / 10_000, 2);
</script>

<Dialog bind:open title={node ? `${name}: planted areas` : 'Hydrological unit not found'} side>
	{#if !node}
		<p>This hydrological unit isn't in the model any more. It may have been removed or renamed on the Network tab.</p>
	{:else if planting.rows.length === 0}
		<p>No crops are defined yet. Add crops and their monthly crop factors on <a href="?tab=crops">Crops &amp; demand</a> first.</p>
	{:else}
		<table class="data compact areas">
			<thead>
				<tr><th scope="col">Crop</th><th scope="col" class="num">Area <span class="u">ha</span></th></tr>
			</thead>
			<tbody>
				{#each rows as r (r.cropId)}
					<tr>
						<th scope="row">{r.name || '(unnamed)'}<FieldHistoryLine field="crop:{nodeId}:{r.cropId}" unit={nodeId} /></th>
						<td>
							<!-- Cleared, an area is 0: nothing planted (the editor drops the row), never an empty field over a value the model keeps. -->
							<NumberInput
								label="{r.name || 'crop'} on {name}, ha"
								min={0}
								step={0.1}
								scale={1 / 10_000}
								disabled={readonly}
								nullable
								bind:value={() => editor.cropArea(nodeId, r.cropId), (n) => editor.setCropArea(nodeId, r.cropId, n ?? 0)}
							/>
						</td>
					</tr>
				{/each}
			</tbody>
			<tfoot>
				<tr><th scope="row">Total</th><td class="num" data-testid="farm-total">{ha(planting.totalM2)} ha</td></tr>
			</tfoot>
		</table>
		<!-- After the table, so opening the sheet focuses the first area, not this link. -->
		<p class="muted small">
			Irrigated area of each crop on this hydrological unit, in hectares. The same values as this hydrological unit's row on
			<a href="?tab=crops">Crops &amp; demand</a>, where the crop factors are set.
		</p>
		{#if !apanSet}
			<p class="muted small">A-pan evaporation isn't set yet, so this hydrological unit's demand is zero (<a href="?tab=settings#set-demand">Settings &amp; calibration, Demand</a>).</p>
		{:else if demand && planting.totalM2 > 0}
			<p class="small" data-testid="farm-demand">
				Irrigation demand before rain: <strong>{fmtNum(demand.meanM3Day)} m³/day</strong> on average,
				{fmtNum(demand.annualMm3, 3)} million m³ a year, highest in {WATER_YEAR_MONTHS[peak]} ({fmtNum(demand.monthlyM3Day[peak])} m³/day),
				at {fmtPct(demand.efficiency, 0)} irrigation efficiency.
			</p>
		{:else}
			<p class="muted small">Nothing planted, so this hydrological unit draws no irrigation water.</p>
		{/if}
	{/if}
	{#if node && node.kind === 'farm' && projectId}
		{#if editor.savedNodeIds.has(node.id)}
			<CroplandProposalsBox {projectId} nodeId={node.id} {readonly} dirty={editor.dirty} {onModelChanged} />
		{:else}
			<p class="muted small" data-testid="cropland-unsaved">Save the model to see this hydrological unit’s cultivated area from land cover.</p>
		{/if}
	{/if}

	{#snippet actions()}
		{#if readonly || !node}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{:else}
			<ModelSaveRow {editor} {onsave} ondone={() => (open = false)} bind:reason />
		{/if}
	{/snippet}
</Dialog>

<style>
	.areas {
		width: 100%;
	}
	.areas td {
		width: 9rem;
	}
	.areas th[scope='row'] {
		text-align: left;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
