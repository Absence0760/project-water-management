<script lang="ts">
	// One crop's name and 12 monthly factors in a side sheet over the Crops
	// page (issue #17, option A · A3: a crop row's Edit in the crop list, `crop=<cropId>` in
	// the URL). It edits the shared ModelEditor, the same values as the Crop
	// factors grid. The sheet is modal, which hides the save bar, so it
	// carries the save row (model/ModelSaveRow.svelte), as the farm drawer does.
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import ModelSaveRow from '$lib/components/model/ModelSaveRow.svelte';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { joinNames } from './demand';

	let {
		open = $bindable(false),
		editor,
		cropId,
		farms,
		readonly,
		onsave,
		reason = $bindable('')
	}: {
		open?: boolean;
		editor: ModelEditor;
		cropId: string;
		/** The Crops page's farms, to say where the crop is planted. */
		farms: readonly { id: string; name: string }[];
		readonly: boolean;
		onsave: () => void;
		reason?: string;
	} = $props();

	const crop = $derived(editor.model.crops.find((c) => c.id === cropId) ?? null);
	const label = $derived(crop?.name || 'unnamed crop');
	const mean = $derived(crop ? crop.cropFactor.reduce((s, f) => s + (f || 0), 0) / 12 : 0);
	const high = $derived(crop ? WATER_YEAR_MONTHS.filter((_, i) => (crop.cropFactor[i] ?? 0) > 1) : []);
	const plantedOn = $derived(
		farms.flatMap((f) => {
			const m2 = editor.cropArea(f.id, cropId);
			return m2 > 0 ? [`${f.name || '(unnamed)'} (${fmtNum(m2 / 10_000, 2)} ha)`] : [];
		})
	);

	function remove() {
		if (!crop) return;
		const used = editor.model.cropAreas.some((a) => a.cropId === crop.id);
		if (used && !confirm(`Remove crop "${label}" and its planted areas on every hydrological unit?`)) return;
		editor.removeCrop(crop.id);
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
			<fieldset>
				<legend>Crop factor by month <HelpTip key="crop.cropFactor" /></legend>
				<div class="months">
					{#each WATER_YEAR_MONTHS as m, i (m)}
						<div class="month">
							<span class="m" aria-hidden="true">{m}</span>
							<NumberInput label="{label} crop factor, {m}" min={0} step={0.01} disabled={readonly} bind:value={crop.cropFactor[i]} />
						</div>
					{/each}
				</div>
				<p class="muted small">Mean {fmtNum(mean, 2)} · water year, October → September</p>
			</fieldset>
			{#if high.length}
				<p class="alert alert-warning small" role="status">
					A factor above 1.0 ({high.join(', ')}) means the crop uses more water than an open A-pan loses. That can happen, but check it
					isn't an FAO Kc entered as it is.
				</p>
			{/if}
			<p class="muted small">
				Gross irrigation need (mm) = A-pan × crop factor. It is <strong>× A-pan, not an FAO Kc</strong>: FAO-56 Kc values multiply
				reference ET₀, about 0.7–0.85 × pan, so multiply a published Kc by the pan coefficient first. Use 0 for months the crop isn't
				irrigated.
			</p>
			<p class="small" data-testid="crop-planted-on">
				{plantedOn.length ? `Planted on ${joinNames(plantedOn)}.` : 'Not planted on any hydrological unit yet.'}
			</p>
			{#if !readonly}
				<p><button type="button" class="btn btn-sm btn-danger" aria-label="Remove {label}" onclick={remove}>Remove crop</button></p>
			{/if}
		</div>

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
