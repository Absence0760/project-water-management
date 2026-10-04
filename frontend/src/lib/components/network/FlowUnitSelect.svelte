<script lang="ts">
	// A flow rate's unit as a small select beside it: m³/s, l/s or m³/day, the
	// same choice for every field of its kind (./flowUnit.svelte.ts). Display
	// only, so a viewer gets it too. At least 24 px tall (WCAG 2.5.8).
	import { FLOW_UNITS, type FlowUnit, type FlowUnitId } from './flowUnit.svelte';

	let { unit, label }: { unit: FlowUnit; label: string } = $props();
</script>

<select class="flow-unit" aria-label={label} value={unit.id} onchange={(e) => unit.set(e.currentTarget.value as FlowUnitId)}>
	{#each FLOW_UNITS as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
</select>

<style>
	.flow-unit {
		font-size: 0.75rem;
		padding: 0 0.2rem;
		min-height: 24px;
		width: auto;
		color: var(--text-muted);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
</style>
