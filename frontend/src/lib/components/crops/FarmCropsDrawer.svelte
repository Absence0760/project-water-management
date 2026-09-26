<script lang="ts">
	// One farm's planted areas in a side sheet over any workspace tab (issue
	// #17, option A step 4; `farm=<nodeId>` in the URL, farmDrawer.ts). It edits
	// the shared ModelEditor, as the Crops tab's Planted areas table does, so an
	// edit here shows there and the other way round. The sheet is modal, which
	// makes the page's save bar unreachable while it is open, so it carries the
	// same save row: reason, Save changes (the page's save), and Done.
	import type { ProjectSettings } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { farmDemands } from './demand';
	import { farmPlanting } from './farmDrawer';

	let {
		open = $bindable(false),
		editor,
		settings,
		nodeId,
		readonly,
		onsave,
		reason = $bindable('')
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
	} = $props();

	const node = $derived(editor.model.nodes.find((n) => n.id === nodeId) ?? null);
	const name = $derived(node?.name || '(unnamed)');
	const planting = $derived(farmPlanting(editor.model, nodeId));
	// Saved A-pan × the areas as edited, as the Crops tab's demand preview.
	const demand = $derived(farmDemands(editor.model, settings.apanMm, settings.februaryDays, [nodeId])[0] ?? null);
	const apanSet = $derived(settings.apanMm.some((v) => v > 0));
	const peak = $derived(demand ? demand.monthlyM3Day.reduce((best, v, m, a) => (v > a[best]! ? m : best), 0) : 0);
	const blocking = $derived(editor.issues.length);
	const ha = (m2: number) => fmtNum(m2 / 10_000, 2);
</script>

<Dialog bind:open title={node ? `${name}: planted areas` : 'Farm not found'} side>
	{#if !node}
		<p>This farm isn't in the model any more. It may have been removed or renamed on the Network tab.</p>
	{:else if planting.rows.length === 0}
		<p>No crops are defined yet. Add crops and their monthly crop factors on <a href="?tab=crops">Crops &amp; demand</a> first.</p>
	{:else}
		<table class="data compact areas">
			<thead>
				<tr><th scope="col">Crop</th><th scope="col" class="num">Area <span class="u">ha</span></th></tr>
			</thead>
			<tbody>
				{#each planting.rows as r (r.cropId)}
					<tr>
						<th scope="row">{r.name || '(unnamed)'}</th>
						<td>
							<NumberInput
								label="{r.name || 'crop'} on {name}, ha"
								min={0}
								step={0.1}
								scale={1 / 10_000}
								disabled={readonly}
								value={editor.cropArea(nodeId, r.cropId)}
								onchange={(n) => editor.setCropArea(nodeId, r.cropId, n ?? 0)}
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
			Irrigated area of each crop on this farm, in hectares. The same values as this farm's row on
			<a href="?tab=crops">Crops &amp; demand</a>, where the crop factors are set.
		</p>
		{#if !apanSet}
			<p class="muted small">A-pan evaporation isn't set yet, so this farm's demand is zero (<a href="?tab=settings">Settings &amp; calibration</a>).</p>
		{:else if demand && planting.totalM2 > 0}
			<p class="small" data-testid="farm-demand">
				Gross irrigation demand: <strong>{fmtNum(demand.meanM3Day)} m³/day</strong> on average,
				{fmtNum(demand.annualMm3, 3)} million m³ a year, highest in {WATER_YEAR_MONTHS[peak]} ({fmtNum(demand.monthlyM3Day[peak])} m³/day).
			</p>
		{:else}
			<p class="muted small">Nothing planted, so this farm draws no irrigation water.</p>
		{/if}
	{/if}

	{#snippet actions()}
		{#if readonly || !node}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{:else}
			<div class="save">
				<p class="status small" aria-live="polite">
					{#if editor.saving}
						Saving…
					{:else if editor.saveError}
						<span class="err">Save failed: {editor.saveError}</span>
					{:else if editor.dirty && blocking}
						Unsaved changes · <span class="err">{blocking} problem{blocking === 1 ? '' : 's'} to fix before saving</span>
					{:else if editor.dirty}
						Unsaved changes to the model
					{:else}
						<span class="muted">No unsaved changes</span>
					{/if}
				</p>
				{#if editor.dirty}
					<label class="reason">
						<span class="visually-hidden">Reason for this change (optional)</span>
						<input type="text" maxlength="500" placeholder="Reason for this change (optional)" bind:value={reason} disabled={editor.saving} />
					</label>
				{/if}
				<div class="buttons">
					<button type="button" class="btn" onclick={() => (open = false)}>Done</button>
					<button type="button" class="btn btn-primary" onclick={onsave} disabled={editor.saving || blocking > 0 || !editor.dirty}>Save changes</button>
				</div>
			</div>
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
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.save {
		display: grid;
		gap: 0.5rem;
		width: 100%;
	}
	.status {
		margin: 0;
	}
	.err {
		color: var(--danger);
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
