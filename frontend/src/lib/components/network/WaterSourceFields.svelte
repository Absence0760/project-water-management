<script lang="ts">
	// Where one demand of a hydrological unit takes its water (engine ≥ 1.65.0,
	// issue #344, docs/model.md §2.7j): the unit's dam side under its supply
	// rule (the default), or a river abstraction of its own beside the dam,
	// with its pump capacity (pumps × m³/h × 24, blank = no limit) and an
	// optional pool at the pump, capacity only (it starts full; its surface is
	// estimated from the capacity). Used for the unit's crops (SupplyFields) and
	// for each demand object (DemandObjectFields). The pump and pool are kept
	// when the source goes back to the dam, where they are inert.
	import type { WaterSource } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { pumpM3Day } from './supply';

	let {
		idBase,
		who,
		helpKey,
		source,
		pump,
		pool,
		readonly,
		onsource,
		onpump,
		onpool
	}: {
		/** Unique within the page, e.g. `ws-crops-<node id>`. */
		idBase: string;
		/** The demand in words, for the labels (e.g. "the crops", "Town"). */
		who: string;
		/** The help key beside the source: node.cropWaterSource or demandObject.waterSource. */
		helpKey: string;
		source: WaterSource | null | undefined;
		pump: number | null | undefined;
		pool: number | null | undefined;
		readonly: boolean;
		onsource: (s: WaterSource) => void;
		onpump: (v: number | null) => void;
		onpool: (v: number | null) => void;
	} = $props();

	const river = $derived(source === 'river');
	const id = (k: string) => `${idBase}-${k}`;
	// The calculator: not stored, as the unit's own pump (SupplyFields).
	let pumps = $state<number | null>(null);
	let rate = $state<number | null>(null);
	function calc(p: number | null, r: number | null) {
		pumps = p;
		rate = r;
		const v = pumpM3Day(p, r);
		if (v !== null) onpump(v);
	}
</script>

<div class="water-source" data-testid="{idBase}">
	<div class="field">
		<span class="lbl"><label for={id('src')}>Water for {who}</label><HelpTip key={helpKey} /></span>
		<select id={id('src')} disabled={readonly} value={river ? 'river' : 'dam'} onchange={(e) => onsource(e.currentTarget.value as WaterSource)}>
			<option value="dam">From the dam (the supply rule)</option>
			<option value="river">Its own river abstraction</option>
		</select>
	</div>
	{#if river}
		{#if !readonly}
			<div class="field">
				<label for={id('pumps')}>Number of pumps</label>
				<NumberInput id={id('pumps')} min={0} value={pumps} nullable placeholder="–" onchange={(v) => calc(v, rate)} />
			</div>
			<div class="field">
				<label for={id('rate')}>m³/h per pump</label>
				<NumberInput id={id('rate')} min={0} value={rate} nullable placeholder="–" onchange={(v) => calc(pumps, v)} />
			</div>
		{/if}
		<div class="field">
			<label for={id('pump')}>River pump capacity <span class="u">(m³/day)</span></label>
			<NumberInput
				id={id('pump')}
				min={0}
				grouped
				nullable
				placeholder="no limit"
				disabled={readonly}
				aria-describedby="{id('pump')}-h"
				value={pump ?? null}
				onchange={(v) => {
					onpump(v);
					if (v !== pumpM3Day(pumps, rate)) {
						pumps = null;
						rate = null;
					}
				}}
			/>
			<span class="hint" id="{id('pump')}-h">
				{#if pumpM3Day(pumps, rate) !== null}
					{fmtNum(pumps, 0, true)} × {fmtNum(rate, 2, true)} m³/h × 24 h = {fmtNum(pumpM3Day(pumps, rate), 0)} m³/day.
				{:else if (pump ?? null) === null}
					Blank is no limit: it takes what the river offers, and the run warns.
				{:else}
					Pumps × m³/h per pump × 24 h.
				{/if}
			</span>
		</div>
		<div class="field">
			<label for={id('pool')}>Pool at the pump <span class="u">(m³)</span></label>
			<NumberInput id={id('pool')} min={0} grouped nullable placeholder="no pool" disabled={readonly} aria-describedby="{id('pool')}-h" value={pool ?? null} onchange={(v) => onpool(v)} />
			<span class="hint" id="{id('pool')}-h">Starts full; its surface is estimated from the capacity, for its evaporation.</span>
		</div>
	{/if}
</div>

<style>
	.water-source {
		display: contents;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select {
			min-height: 44px;
		}
	}
</style>
