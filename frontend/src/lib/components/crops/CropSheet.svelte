<script lang="ts">
	// One crop's name and 12 monthly factors in a side sheet over the Crops
	// page (issue #17, option A · A3: a crop row's Edit in the crop list, `crop=<cropId>` in
	// the URL). It edits the shared ModelEditor, the same values as the Crop
	// factors grid. The sheet is modal, which hides the save bar, so it
	// carries the save row (model/ModelSaveRow.svelte), as the farm drawer does.
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import GridPasteDialog from '$lib/components/model/GridPasteDialog.svelte';
	import ModelSaveRow from '$lib/components/model/ModelSaveRow.svelte';
	import { gridPasteTarget, type PastePlan } from '$lib/spreadsheet/paste/grid';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { applyFactorPaste, cropFactorsCsv, planFactorPaste } from './areaPaste';
	import { findSystem, systemLabel, systemsOf } from '$lib/model/systems';
	import { joinNames } from './demand';

	let {
		open = $bindable(false),
		editor,
		cropId,
		farms,
		readonly,
		onsave,
		onremove,
		onloadfactors,
		reason = $bindable('')
	}: {
		open?: boolean;
		editor: ModelEditor;
		cropId: string;
		/** The Crops page's farms, to say where the crop is planted. */
		farms: readonly { id: string; name: string }[];
		readonly: boolean;
		onsave: () => void;
		/** Told before the crop is removed, so the page can put the focus somewhere that stays (the Edit button that opened the sheet goes with its row). */
		onremove?: (cropId: string) => void;
		/** Opens Load crop factors (the library or a workbook) over the sheet; absent, no link. */
		onloadfactors?: () => void;
		reason?: string;
	} = $props();

	const crop = $derived(editor.model.crops.find((c) => c.id === cropId) ?? null);
	const label = $derived(crop?.name || 'unnamed crop');
	const high = $derived(crop ? WATER_YEAR_MONTHS.filter((_, i) => (crop.cropFactor[i] ?? 0) > 1) : []);
	const plantedOn = $derived(
		farms.flatMap((f) => {
			const m2 = editor.cropArea(f.id, cropId);
			return m2 > 0 ? [`${f.name || '(unnamed)'} (${fmtNum(m2 / 10_000, 2)} ha)`] : [];
		})
	);

	// Its default irrigation system (engine ≥ 1.72.0), and the units that put it on another.
	const systems = $derived(systemsOf(editor.model));
	const ownOn = $derived(
		farms.flatMap((f) => {
			const a = editor.model.cropAreas.find((x) => x.nodeId === f.id && x.cropId === cropId && x.areaM2 > 0);
			const s = a?.irrigationSystemId ? findSystem(editor.model, a.irrigationSystemId) : null;
			return s ? [`${f.name || '(unnamed)'} (${s.name})`] : [];
		})
	);

	// A block pasted into a month (one copied row of 12 factors, say): previewed, then applied from that month on.
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteCol = $state(0);
	let announce = $state('');
	function onPaste(e: ClipboardEvent) {
		const t = gridPasteTarget(e);
		if (!t) return;
		const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-paste-col]') : null;
		pasteCol = cell ? Number(cell.dataset.pasteCol) : 0;
		pasteText = t.text;
		pasteOpen = true;
	}
	function applyPaste(plan: PastePlan) {
		applyFactorPaste(plan, (id, m, f) => {
			const c = editor.model.crops.find((x) => x.id === id);
			if (c) c.cropFactor[m] = f;
		});
		announce = `Pasted ${plan.changes.length} crop ${plan.changes.length === 1 ? 'factor' : 'factors'}. Save the model to keep them.`;
	}

	async function remove() {
		if (!crop) return;
		const id = crop.id;
		const used = editor.model.cropAreas.some((a) => a.cropId === id);
		if (
			used &&
			!(await confirmDialog({
				title: `Remove crop “${label}”?`,
				message: 'Its planted areas on every hydrological unit are removed too.',
				confirmLabel: 'Remove crop',
				danger: true
			}))
		)
			return;
		onremove?.(id);
		editor.removeCrop(id);
		open = false;
	}
</script>

{#if crop}
	<Dialog bind:open title={readonly ? `${crop.name || '(unnamed)'}: crop factors` : `Edit ${crop.name || '(unnamed crop)'}`} side>
		<div class="sheet">
			<label class="name">
				<span>Crop name</span>
				<input id="crop-name-{crop.id}" maxlength="100" readonly={readonly} bind:value={crop.name} />
			</label>
			<div class="name">
				<span class="lbl"><label for="crop-system-{crop.id}">Irrigation system</label> <HelpTip key="crop.irrigationSystemId" /></span>
				<select
					id="crop-system-{crop.id}"
					disabled={readonly}
					aria-describedby="crop-system-{crop.id}-h"
					value={crop.irrigationSystemId ?? ''}
					onchange={(e) => (crop.irrigationSystemId = e.currentTarget.value || null)}
				>
					<option value="">None (each unit's own efficiency)</option>
					{#each systems as s (s.id)}<option value={s.id}>{systemLabel(s)}</option>{/each}
				</select>
				<span class="muted small hint" id="crop-system-{crop.id}-h" data-testid="crop-system-hint">
					The system it is under wherever it grows{ownOn.length ? `, except on ${joinNames(ownOn)}` : ''}. A unit can put it on another in its planted areas.
				</span>
			</div>
			<fieldset>
				<legend>Crop factor by month <HelpTip key="crop.cropFactor" /></legend>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="months" onpaste={readonly ? undefined : onPaste}>
					{#each WATER_YEAR_MONTHS as m, i (m)}
						<div class="month" data-paste-col={i}>
							<span class="m" aria-hidden="true">{m}</span>
							<!-- Cleared, a factor is 0 (a month the crop isn't irrigated), never an empty field over a value the model keeps. -->
							<NumberInput
								label="{label} crop factor, {m}"
								min={0}
								step={0.01}
								disabled={readonly}
								nullable
								bind:value={() => crop.cropFactor[i] ?? 0, (v) => (crop.cropFactor[i] = v ?? 0)}
							/>
						</div>
					{/each}
				</div>
				<!-- No mean factor: an unweighted 12-month average the b023 workbook doesn't have, which reads as more than it is (issue #174). -->
				<p class="muted small">
					Water year, October → September.{#if !readonly}{' '}Paste a copied row of 12 factors into Oct to fill them all.{/if}
				</p>
			</fieldset>
			{#if !readonly && onloadfactors}
				<p class="small">
					<button type="button" class="btn btn-sm" onclick={onloadfactors}>Load crop factors…</button>
					<span class="muted">from the ARC/SABI library or a workbook</span>
				</p>
			{/if}
			{#if high.length}
				<p class="alert alert-warning small" role="status">
					A factor above 1.0 ({high.join(', ')}) means the crop uses more water than an open A-pan loses. That can happen, but check it
					isn't an FAO Kc entered as it is.
				</p>
			{/if}
			<p class="muted small">
				Gross irrigation need (mm) = A-pan × crop factor. It is <strong>× A-pan, not an FAO Kc</strong>: FAO-56 Kc values multiply
				reference ET₀, about 0.6–0.85 × pan (0.35–0.85 in FAO-56 Table 5), so multiply a published Kc by the pan coefficient first. Use 0 for months the crop isn't
				irrigated.
			</p>
			<p class="small" data-testid="crop-planted-on">
				{plantedOn.length ? `Planted on ${joinNames(plantedOn)}.` : 'Not planted on any hydrological unit yet.'}
			</p>
			{#if !readonly}
				<p><button type="button" class="btn btn-sm btn-danger" aria-label="Remove {label}" onclick={remove}>Remove crop</button></p>
			{/if}
		</div>

		<p class="visually-hidden" aria-live="polite">{announce}</p>
		{#if !readonly}
			<GridPasteDialog
				bind:open={pasteOpen}
				bind:text={pasteText}
				title="Paste {crop.name || 'unnamed crop'}'s crop factors"
				layout="Crop factors (× A-pan), one row of months; without a heading row the values fill from the month you pasted into. 0 is a month the crop isn't irrigated."
				where="{crop.name || '(unnamed)'}, {WATER_YEAR_MONTHS[pasteCol]}"
				plan={(t) => planFactorPaste(t, [crop], { row: 0, col: pasteCol })}
				onapply={applyPaste}
				csv={() => cropFactorsCsv([crop])}
				csvName="crop-factors.csv"
			/>
		{/if}

		{#snippet actions()}
			{#if readonly}
				<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
			{:else}
				<ModelSaveRow {editor} {onsave} ondone={() => (open = false)} bind:reason />
			{/if}
		{/snippet}
	</Dialog>
{/if}

<style>
	.sheet {
		display: grid;
		gap: 0.9rem;
	}
	.sheet p {
		margin: 0;
	}
	.name {
		display: grid;
		gap: 0.25rem;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.name .hint {
		font-weight: 400;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend {
		padding: 0;
		margin-bottom: 0.4rem;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.months {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.month {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.m {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.month :global(input) {
		width: 100%;
		min-width: 0;
	}
	.small {
		font-size: 0.85rem;
	}
</style>
