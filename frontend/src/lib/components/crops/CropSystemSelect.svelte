<script lang="ts">
	// One project crop's irrigation system in Load crop factors (docs/ui.md §
	// Load crop factors): a select of the SABI 2021 systems that sets the
	// crop's own efficiency, '' keeping the one it has. Self-contained, so the
	// system choice can change shape without touching the dialog's layout: the
	// dialog passes the crop, the current choice and a typical system to hint,
	// and turns the chosen id into what Apply writes.
	import type { CropDef, IrrigationSystemId } from '@water-management/engine';
	import { fmtPct } from '$lib/format/number';
	import { LIBRARY_SYSTEMS } from './library';

	let {
		crop,
		value,
		typical = null,
		onchange
	}: {
		crop: CropDef;
		/** The chosen system's id; '' keeps the crop's efficiency. */
		value: string;
		/** A typical system for the source crop (a hint, never applied unasked). */
		typical?: IrrigationSystemId | null;
		onchange: (id: string) => void;
	} = $props();

	const uid = $props.id();
	const name = $derived(crop.name || 'unnamed crop');
	const keep = $derived(crop.irrigationEfficiency == null ? 'hydrological unit’s' : fmtPct(crop.irrigationEfficiency, 0));
	const typicalLabel = $derived(typical ? (LIBRARY_SYSTEMS.find((s) => s.id === typical)?.label.toLowerCase() ?? typical) : null);
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
		{#each LIBRARY_SYSTEMS as s (s.id)}<option value={s.id}>{s.label}, {fmtPct(s.efficiency, 0)}</option>{/each}
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
