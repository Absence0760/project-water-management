<script lang="ts">
	// "Water you received this season" (design §3 Q1), with the volume-unit
	// switch. The switch's choice is kept on the phone (savedCopy.writeUnit)
	// until the account preference exists (WP-2.5).
	import type { FarmProjection } from '@water-management/engine';
	import { LITTLE_NEED, supplyCard } from './cards';
	import type { VolumeUnit } from './format';
	import Rich from './Rich.svelte';
	import { writeUnit } from './savedCopy';

	let { farm, unit = $bindable() }: { farm: FarmProjection; unit: VolumeUnit } = $props();
	const vm = $derived(supplyCard(farm, unit));

	function choose(u: VolumeUnit) {
		unit = u;
		writeUnit(u);
	}
</script>

<section class="card" aria-labelledby="supply-h">
	<h2 id="supply-h">Water you received this season</h2>
	{#if vm.pct}
		<p class="big"><span>{vm.pct}</span><span class="sub">of what you needed</span></p>
		<div class="meter" aria-hidden="true"><span style:width="{vm.barPct}%"></span></div>
	{:else}
		<p>{LITTLE_NEED}</p>
	{/if}
	<p>{vm.volumes}</p>
	<p>{vm.short}</p>
	<p class="last30"><Rich text={vm.last30} /></p>
	<p class="fine">{vm.efficiency}</p>
	<div class="units" role="group" aria-label="Show volumes in">
		<span>Show in</span>
		<button type="button" aria-pressed={unit === 'ML'} onclick={() => choose('ML')}>ML</button>
		<button type="button" aria-pressed={unit === 'm3'} onclick={() => choose('m3')}>m³</button>
	</div>
</section>

<style>
	.last30 {
		padding-top: 8px;
		border-top: 1px solid var(--border);
		color: var(--text-2);
	}
	.last30 :global(strong) {
		color: var(--text);
	}
	.units {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		color: var(--text-2);
	}
	.units button {
		min-height: var(--tap);
		min-width: 56px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		font: inherit;
		font-weight: 600;
		border: 1px solid var(--border-input);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.units button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
</style>
