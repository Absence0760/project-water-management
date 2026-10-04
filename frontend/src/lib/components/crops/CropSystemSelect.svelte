<script lang="ts">
	// One project crop's default irrigation system in Load crop factors
	// (docs/ui.md § Load crop factors; engine ≥ 1.72.0): a select of the
	// project's irrigation systems, '' keeping the one it has. Self-contained:
	// the dialog passes the crop, the project's table, the current choice and a
	// typical SABI system to hint, and takes the chosen row id.
	import type { CropDef, IrrigationSystemDef, IrrigationSystemId } from '@water-management/engine';
	import { findSystem, systemLabel } from '$lib/model/systems';

	let {
		crop,
		systems,
		value,
		typical = null,
		onchange
	}: {
		crop: CropDef;
		/** The project's irrigation systems (the model's table). */
		systems: readonly IrrigationSystemDef[];
		/** The chosen row's id; '' keeps the crop's system. */
		value: string;
		/** A typical SABI system for the source crop (a hint, never applied unasked). */
		typical?: IrrigationSystemId | null;
		onchange: (id: string) => void;
	} = $props();

	const uid = $props.id();
	const name = $derived(crop.name || 'unnamed crop');
	const current = $derived(findSystem({ irrigationSystems: [...systems] }, crop.irrigationSystemId));
	const keep = $derived(current ? systemLabel(current) : 'none: the unit’s efficiency for crops with no system');
	const typicalRow = $derived(typical ? (systems.find((s) => s.preset === typical) ?? null) : null);
	const typicalLabel = $derived(typicalRow ? typicalRow.name.toLowerCase() : null);
</script>

<div class="sys">
	<span class="lab" aria-hidden="true">Irrigation system</span>
	<select
		aria-label="Irrigation system for {name}"
		aria-describedby={typicalLabel ? `${uid}-typ` : undefined}
		{value}
		onchange={(e) => onchange(e.currentTarget.value)}
	>
		<option value="">Keep ({keep})</option>
		{#each systems as s (s.id)}<option value={s.id}>{systemLabel(s)}</option>{/each}
	</select>
	{#if typicalLabel}<span class="hint" id="{uid}-typ">Typical: {typicalLabel}</span>{/if}
</div>

<style>
	.sys {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.lab {
		font-size: 0.8rem;
		color: var(--text-2);
	}
	select {
		width: 100%;
		min-height: 2rem;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
</style>
