<script lang="ts">
	// A farm's supply rule and river pump (WP-3.8, docs/model.md §2.7e): where
	// its irrigation comes from, the pump's capacity, and the trigger rule's
	// switch levels. Only the m³/day is stored; the pump count and rate are a
	// calculator that fills it (the model stores one number that can't disagree
	// with itself), so a saved capacity reloads into the m³/day field with the
	// calculator empty. The node is the editor's own object, so edits land in
	// the model directly.
	import { SUPPLY_DEFAULTS, SUPPLY_RULE_LABEL, SUPPLY_RULES, type NetworkNode, type SupplyRule } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { supplyIssues } from '$lib/model/validate';
	import { noDamSupplyHint, pumpM3Day, sharedPumpHint, SUPPLY_RULE_HELP } from './supply';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const id = (k: string) => `sp-${k}-${node.id}`;
	const rule = $derived<SupplyRule>(node.supplyRule ?? SUPPLY_DEFAULTS.supplyRule);
	const pump = $derived(node.pumpCapacityM3Day ?? null);
	const problems = $derived(supplyIssues(node));
	const noDam = $derived(noDamSupplyHint(node));
	const shared = $derived(sharedPumpHint(node));

	// The calculator: not stored. Filling both sets the capacity; typing a capacity clears them.
	let pumps = $state<number | null>(null);
	let rate = $state<number | null>(null);
	function calc(p: number | null, r: number | null) {
		pumps = p;
		rate = r;
		const v = pumpM3Day(p, r);
		if (v !== null) node.pumpCapacityM3Day = v;
	}
	const cap = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
</script>

<div class="supply" data-testid="supply-{node.id}">
	<div class="grid">
		<div class="field wide">
			<span class="lbl"><label for={id('rule')}>Supply rule</label><HelpTip key="node.supplyRule" /></span>
			<select id={id('rule')} disabled={readonly} value={rule} aria-describedby="{id('rule')}-h" onchange={(e) => (node.supplyRule = e.currentTarget.value as SupplyRule)}>
				{#each SUPPLY_RULES as r (r)}<option value={r}>{cap(SUPPLY_RULE_LABEL[r])}</option>{/each}
			</select>
			<span class="hint" id="{id('rule')}-h">{SUPPLY_RULE_HELP[rule]}</span>
		</div>
		{#if rule !== 'damFirst'}
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
				<span class="lbl"><label for={id('cap')}>River pump capacity <span class="u">(m³/day)</span></label><HelpTip key="node.pumpCapacityM3Day" /></span>
				<NumberInput
					id={id('cap')}
					min={0}
					grouped
					nullable
					placeholder="no limit"
					disabled={readonly}
					aria-describedby="{id('cap')}-h"
					value={pump}
					onchange={(v) => {
						node.pumpCapacityM3Day = v;
						if (v !== pumpM3Day(pumps, rate)) {
							pumps = null;
							rate = null;
						}
					}}
				/>
				<span class="hint" id="{id('cap')}-h" data-testid="pump-note">
					{#if pumpM3Day(pumps, rate) !== null}
						{fmtNum(pumps, 0, true)} × {fmtNum(rate, 2, true)} m³/h × 24 h = {fmtNum(pumpM3Day(pumps, rate), 0)} m³/day.
					{:else if pump === null}
						Blank is no limit: the pump takes whatever the river offers, and the run warns.
					{:else}
						{readonly ? 'Pumps × m³/h per pump × 24 h.' : 'Or enter the pumps and their rate to work it out (pumps × m³/h × 24 h).'}
					{/if}
				</span>
			</div>
		{/if}
		{#if rule === 'trigger'}
			<div class="field">
				<span class="lbl"><label for={id('trigger')}>Switch to river below <span class="u">(% of dam)</span></label><HelpTip key="node.supplyTriggerPct" /></span>
				<NumberInput id={id('trigger')} min={0} max={100} scale={100} disabled={readonly} value={node.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct} onchange={(v) => (node.supplyTriggerPct = v ?? 0)} />
			</div>
			<div class="field">
				<span class="lbl"><label for={id('stop')}>Back to the dam at <span class="u">(% of dam)</span></label><HelpTip key="node.supplyStopPct" /></span>
				<NumberInput id={id('stop')} min={0} max={100} scale={100} disabled={readonly} value={node.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct} onchange={(v) => (node.supplyStopPct = v ?? 0)} />
			</div>
		{/if}
	</div>
	{#each problems as p (p)}
		<p class="problem" role="alert">{cap(p)}</p>
	{/each}
	{#if noDam}<p class="hint note" role="note">{noDam}</p>{/if}
	{#if shared}<p class="hint note" role="note" data-testid="shared-pump-note">{shared}</p>{/if}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 0 1rem;
		align-items: start;
	}
	.wide {
		grid-column: 1 / -1;
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
	.problem {
		margin: 0.25rem 0;
		font-size: 0.85rem;
		color: var(--danger);
	}
	.note {
		margin: 0.25rem 0 0.5rem;
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select {
			min-height: 44px;
		}
	}
</style>
