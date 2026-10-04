<script lang="ts">
	// A farm's supply rule and river pump (WP-3.8, docs/model.md §2.7e): where
	// its irrigation comes from, the pump's capacity, and the trigger rule's
	// switch levels. Only the m³/day is stored; the pump count and rate are a
	// calculator that fills it (the model stores one number that can't disagree
	// with itself), so a saved capacity reloads into the m³/day field with the
	// calculator empty. Below them, the hands-off flow (engine ≥ 1.32.0, issue
	// #204, §2.7h): a flow by month and/or the EWR left in the river before the
	// pump or River to dam takes anything. Then where the crops take their
	// water (engine ≥ 1.65.0, issue #344, §2.7j): the dam under the supply
	// rule, or a river abstraction of their own (WaterSourceFields), or split
	// between the dam, the river and another unit's dam by share (engine ≥
	// 1.73.0, issue #408, §2.7k: CropSupplyFields). The node is the editor's
	// own object, so edits land in the model directly.
	import { hasCropShares, SUPPLY_DEFAULTS, SUPPLY_RULE_LABEL, SUPPLY_RULES, type NetworkNode, type SupplyRule } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { operatingIssues, supplyIssues } from '$lib/model/validate';
	import MonthFields from './MonthFields.svelte';
	import WaterSourceFields from './WaterSourceFields.svelte';
	import CropSupplyFields from './CropSupplyFields.svelte';
	import { handsOffPreview, handsOffTicked, noDamSupplyHint, sharedPumpHint, SUPPLY_RULE_HELP } from './supply';
	import PumpCapacityField from './PumpCapacityField.svelte';
	import { supplyProblemFields, type SupplyField } from './problemFields';

	let { node, nodes, readonly }: { node: NetworkNode; nodes: readonly NetworkNode[]; readonly: boolean } = $props();

	const id = (k: string) => `sp-${k}-${node.id}`;
	// History's unit filter: a farm's own fields (a gauge or user keeps them only to clear).
	const unit = $derived(node.kind === 'farm' ? node.id : null);
	const rule = $derived<SupplyRule>(node.supplyRule ?? SUPPLY_DEFAULTS.supplyRule);
	const pump = $derived(node.pumpCapacityM3Day ?? null);
	const problems = $derived(supplyIssues(node));
	const operating = $derived(operatingIssues(node));
	const noDam = $derived(noDamSupplyHint(node));
	const shared = $derived(sharedPumpHint(node));

	/** The problems' ids for one field's aria-describedby (the field is marked invalid while it has any); the pump's own NumberInput says when it is negative. */
	const problemIds = (f: SupplyField) => problems.flatMap((p, k) => (supplyProblemFields(p).includes(f) ? [`${id('problem')}-${k}`] : []));
	const ruleProblems = $derived(problemIds('rule'));
	const levelProblems = $derived(problemIds('levels'));
	const cap = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

	// The hands-off flow by month (water-year order); null = no set flow.
	const label = $derived(node.name || 'this hydrological unit');
	const handsOff = $derived(node.handsOffM3Day ?? null);
</script>

<div class="supply" data-testid="supply-{node.id}">
	<div class="grid">
		<div class="field wide">
			<span class="lbl"><label for={id('rule')}>Supply rule</label><HelpTip key="node.supplyRule" /></span>
			<select
				id={id('rule')}
				disabled={readonly}
				value={rule}
				aria-describedby={[`${id('rule')}-h`, ...ruleProblems].join(' ')}
				aria-invalid={ruleProblems.length ? 'true' : undefined}
				onchange={(e) => (node.supplyRule = e.currentTarget.value as SupplyRule)}>
				{#each SUPPLY_RULES as r (r)}<option value={r}>{cap(SUPPLY_RULE_LABEL[r])}</option>{/each}
			</select>
			<span class="hint" id="{id('rule')}-h">{SUPPLY_RULE_HELP[rule]}</span>
			<FieldHistoryLine field="node:{node.id}:supplyRule" {unit} />
		</div>
		<!-- An other water user's pump capacity is its own field, with its user fields (engine ≥ 1.58.0). -->
		{#if rule !== 'damFirst' && node.kind !== 'user'}
			<PumpCapacityField
				idBase="sp-{node.id}"
				label="River pump capacity"
				helpKey="node.pumpCapacityM3Day"
				value={pump}
				{readonly}
				note={pump === null ? 'Blank is no limit: the pump takes whatever the river offers, and the run warns.' : readonly ? 'Pumps × m³/h per pump × 24 h.' : 'Or enter the pumps and their rate to work it out (pumps × m³/h × 24 h).'}
				noteTestId="pump-note"
				onchange={(v) => (node.pumpCapacityM3Day = v)}
			>
				{#snippet history()}<FieldHistoryLine field="node:{node.id}:pumpCapacityM3Day" {unit} />{/snippet}
			</PumpCapacityField>
		{/if}
		{#if rule === 'trigger'}
			<div class="field">
				<span class="lbl"><label for={id('trigger')}>Switch to river below <span class="u">(% of dam)</span></label><HelpTip key="node.supplyTriggerPct" /></span>
				<NumberInput id={id('trigger')} aria-invalid={levelProblems.length ? 'true' : undefined} aria-describedby={levelProblems.join(' ') || undefined} min={0} max={100} scale={100} disabled={readonly} value={node.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct} onchange={(v) => (node.supplyTriggerPct = v ?? 0)} />
				<FieldHistoryLine field="node:{node.id}:supplyTriggerPct" {unit} />
			</div>
			<div class="field">
				<span class="lbl"><label for={id('stop')}>Back to the dam at <span class="u">(% of dam)</span></label><HelpTip key="node.supplyStopPct" /></span>
				<NumberInput id={id('stop')} aria-invalid={levelProblems.length ? 'true' : undefined} aria-describedby={levelProblems.join(' ') || undefined} min={0} max={100} scale={100} disabled={readonly} value={node.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct} onchange={(v) => (node.supplyStopPct = v ?? 0)} />
				<FieldHistoryLine field="node:{node.id}:supplyStopPct" {unit} />
			</div>
		{/if}
	</div>
	{#if node.kind === 'farm'}
		<!-- Where the crops take their water (engine ≥ 1.65.0, issue #344): the unit's supply under the rule above, or their own river abstraction. -->
		<h3 class="sub">Water for the crops</h3>
		<CropSupplyFields {node} {nodes} rule={SUPPLY_RULE_LABEL[rule]} {readonly} />
		{#if !hasCropShares(node)}
		<div class="grid crops-source">
			<WaterSourceFields
				idBase="ws-crops-{node.id}"
				who="the crops"
				helpKey="node.cropWaterSource"
				rule={SUPPLY_RULE_LABEL[rule]}
				source={node.cropWaterSource}
				pump={node.cropRiverPumpM3Day}
				pool={node.cropRiverPoolM3}
				{readonly}
				onsource={(v) => (node.cropWaterSource = v)}
				onpump={(v) => (node.cropRiverPumpM3Day = v)}
				onpool={(v) => (node.cropRiverPoolM3 = v)}
			>
				{#snippet history(f: string)}<FieldHistoryLine field="node:{node.id}:{f === 'source' ? 'cropWaterSource' : f === 'pump' ? 'cropRiverPumpM3Day' : 'cropRiverPoolM3'}" {unit} />{/snippet}
			</WaterSourceFields>
		</div>
		{/if}
	{/if}
	<div class="hands-off" data-testid="hands-off-{node.id}">
		<h3 class="sub">Hands-off flow <HelpTip key="node.handsOffM3Day" /></h3>
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={handsOff !== null} onchange={(e) => (node.handsOffM3Day = handsOffTicked(e.currentTarget.checked))} />
			Leave a set flow in the river, by month
		</label>
		{#if handsOff !== null}
			<MonthFields
				values={handsOff}
				label={(m) => `Hands-off flow of ${label} in ${m}, m³/day`}
				caption="Hands-off flow, m³/day, per month"
				fillLabel="Use October’s flow for every month"
				{readonly}
				onchange={(next) => (node.handsOffM3Day = next)}
			/>
		{/if}
		<FieldHistoryLine field="node:{node.id}:handsOffM3Day" {unit} />
		<div class="check-row">
			<label class="check">
				<input type="checkbox" disabled={readonly} checked={node.handsOffEwr === true} onchange={(e) => (node.handsOffEwr = e.currentTarget.checked)} />
				Also leave the EWR in the river
			</label>
			<HelpTip key="node.handsOffEwr" />
		</div>
		<FieldHistoryLine field="node:{node.id}:handsOffEwr" {unit} />
		<p class="hint note" data-testid="hands-off-note">{handsOffPreview(node)}</p>
	</div>
	{#each problems as p, k (p)}
		<p class="problem" role="alert" id="{id('problem')}-{k}">{cap(p)}</p>
	{/each}
	{#each operating as p (p)}
		<div class="problem-row">
			<p class="problem" role="alert">{cap(p)}</p>
			{#if node.kind !== 'farm' && node.divertMonthlyM3Day != null && !readonly}
				<button type="button" class="btn btn-sm" onclick={() => (node.divertMonthlyM3Day = null)}>Clear River to dam by month</button>
			{/if}
		</div>
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
	.sub {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0.75rem 0 0.25rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.check-row .check {
		margin-bottom: 0;
	}
	.problem-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
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
		.field select,
		.problem-row .btn {
			min-height: 44px;
		}
	}
</style>
