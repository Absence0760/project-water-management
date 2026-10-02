<script lang="ts">
	// Where one demand of a hydrological unit takes its water (engine ≥ 1.65.0,
	// issue #344, docs/model.md §2.7j): the unit's own supply under its supply
	// rule (the dam side, the default), or a river abstraction of its own beside
	// the dam, with its pump capacity (PumpCapacityField: pumps × m³/h × 24,
	// blank = no limit) and an optional pool at the pump, capacity only (it
	// starts full; its surface is estimated from the capacity). Used for the
	// unit's crops (SupplyFields) and for each demand object
	// (DemandObjectFields). Every label names the demand, so a group that also
	// holds the unit's own pump reads each field apart. The pump and pool are
	// kept when the source goes back to the unit's supply, where they are inert.
	import type { Snippet } from 'svelte';
	import type { WaterSource } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import PumpCapacityField from './PumpCapacityField.svelte';

	let {
		idBase,
		who,
		helpKey,
		rule,
		source,
		pump,
		pool,
		readonly,
		history,
		onsource,
		onpump,
		onpool
	}: {
		/** Unique within the page, e.g. `ws-crops-<node id>`. */
		idBase: string;
		/** The demand in words, for the labels (e.g. "the crops", "Mill"). */
		who: string;
		/** The help key beside the source: node.cropWaterSource or demandObject.waterSource. */
		helpKey: string;
		/** The unit's supply rule in words (SUPPLY_RULE_LABEL), what the default source runs under. */
		rule: string;
		source: WaterSource | null | undefined;
		pump: number | null | undefined;
		pool: number | null | undefined;
		readonly: boolean;
		/** Each field's history line ('source', 'pump', 'pool'), when the demand has one. */
		history?: Snippet<[string]>;
		onsource: (s: WaterSource) => void;
		onpump: (v: number | null) => void;
		onpool: (v: number | null) => void;
	} = $props();

	const river = $derived(source === 'river');
	const id = (k: string) => `${idBase}-${k}`;
	const forWhom = $derived(` for ${who}`);
</script>

<div class="water-source" data-testid={idBase}>
	<div class="field">
		<span class="lbl"><label for={id('src')}>Water for {who}</label><HelpTip key={helpKey} /></span>
		<select id={id('src')} disabled={readonly} value={river ? 'river' : 'dam'} onchange={(e) => onsource(e.currentTarget.value as WaterSource)}>
			<option value="dam">The unit’s supply ({rule})</option>
			<option value="river">Its own river abstraction</option>
		</select>
		{@render history?.('source')}
	</div>
	{#if river}
		<PumpCapacityField
			idBase={id('pump')}
			label="River pump capacity"
			{forWhom}
			value={pump ?? null}
			{readonly}
			note={(pump ?? null) === null
				? 'Blank is no limit: it takes what the river offers, and the run warns.'
				: readonly
					? 'Pumps × m³/h per pump × 24 h.'
					: 'Or enter the pumps and their rate to work it out (pumps × m³/h × 24 h).'}
			onchange={onpump}
		>
			{#snippet history()}{@render historyOf('pump')}{/snippet}
		</PumpCapacityField>
		<div class="field">
			<label for={id('pool')}>Pool at the pump{forWhom} <span class="u">(m³)</span></label>
			<NumberInput id={id('pool')} min={0} grouped nullable placeholder="no pool" disabled={readonly} aria-describedby="{id('pool')}-h" value={pool ?? null} onchange={(v) => onpool(v)} />
			<span class="hint" id="{id('pool')}-h">Starts full; its surface is estimated from the capacity, for its evaporation.</span>
			{@render history?.('pool')}
		</div>
	{/if}
</div>

{#snippet historyOf(field: string)}{@render history?.(field)}{/snippet}

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
