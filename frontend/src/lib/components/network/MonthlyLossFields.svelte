<script lang="ts">
	// Bed losses or a unit's base-flow loss and gain by water-year month
	// (engine 1.116.0, docs/model.md §2.6b), under the section's one-value
	// fields in the one-node form: a "Vary by month" switch and, when it is on,
	// a row of twelve months for each value. The one values stay stored (shown
	// under "Not used: set by month below") and count again when it is cleared
	// (./monthlyLosses.ts).
	import type { NetworkNode } from '@water-management/engine';
	import FieldHistoryLine from '#lib/components/history/FieldHistoryLine.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtNum } from '#lib/format/number.js';
	import MonthFields from './MonthFields.svelte';
	import { capByMonth, sectionByMonth, varyByMonth } from './monthlyLosses';

	let { node, group, readonly }: { node: NetworkNode; group: 'reach' | 'baseflow'; readonly: boolean } = $props();

	const unit = $derived(node.kind === 'farm' ? node.id : null);
	const name = $derived(node.name || 'this hydrological unit');
	const on = $derived(sectionByMonth(group, node));
</script>

<div class="by-month" data-testid="{group}-by-month">
	<div class="check-row">
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={on} onchange={(e) => varyByMonth(node, group, e.currentTarget.checked)} data-testid="{group}-vary" />
			Vary by month
		</label>
		<HelpTip key={group === 'reach' ? 'node.reachLossFracMonthly' : 'node.baseflowLossMonthlyM3Day'} label="About varying it by month" />
	</div>
	{#if on && group === 'reach'}
		<p class="hint explain">
			A share of the whole flow leaving {name} (what reaches it from upstream included), up to the month’s cap. In the wet months a small share with a high
			cap can still lose a lot of a big flow; in the dry months a larger share with a small cap fits a low flow. A month at 0 % loses nothing.
		</p>
		<MonthFields
			values={node.reachLossFracMonthly}
			label={(m) => `Share of the flow lost below ${name} in ${m}, %`}
			caption="Share of the flow lost, %, per month"
			help="node.reachLossFracMonthly"
			fillLabel="Use October’s share for every month"
			scale={100}
			{readonly}
			testid="reach-frac-months"
			onchange={(next) => (node.reachLossFracMonthly = next)}
		/>
		<FieldHistoryLine field="node:{node.id}:reachLossFracMonthly" {unit} />
		<label class="check">
			<input type="checkbox" disabled={readonly} checked={node.reachLossMaxMonthlyM3Day != null} onchange={(e) => capByMonth(node, e.currentTarget.checked)} data-testid="reach-cap-vary" />
			A daily cap by month
		</label>
		{#if node.reachLossMaxMonthlyM3Day != null}
			<MonthFields
				values={node.reachLossMaxMonthlyM3Day}
				label={(m) => `Most lost below ${name} in a day in ${m}, m³/day`}
				caption="Most lost in a day, m³/day, per month"
				help="node.reachLossMaxMonthlyM3Day"
				fillLabel="Use October’s cap for every month"
				{readonly}
				testid="reach-cap-months"
				onchange={(next) => (node.reachLossMaxMonthlyM3Day = next)}
			/>
			<FieldHistoryLine field="node:{node.id}:reachLossMaxMonthlyM3Day" {unit} />
		{:else}
			<p class="hint">
				{node.reachLossMaxM3Day == null ? 'No cap: each month loses its share of the flow, however high.' : `The one cap, ${fmtNum(node.reachLossMaxM3Day)} m³/day, in every month.`}
			</p>
		{/if}
	{:else if on}
		<p class="hint explain">
			Each day takes its month’s values: a loss in the wet months, when a full river feeds the groundwater, and a gain in the dry months, when the
			groundwater feeds the river.
		</p>
		<MonthFields
			values={node.baseflowLossMonthlyM3Day}
			label={(m) => `Base flow ${name} loses in ${m}, m³/day`}
			caption="Base-flow loss, m³/day, per month"
			help="node.baseflowLossMonthlyM3Day"
			fillLabel="Use October’s loss for every month"
			{readonly}
			testid="baseflow-loss-months"
			onchange={(next) => (node.baseflowLossMonthlyM3Day = next)}
		/>
		<FieldHistoryLine field="node:{node.id}:baseflowLossMonthlyM3Day" {unit} />
		<MonthFields
			values={node.baseflowGainMonthlyM3Day}
			label={(m) => `Base flow ${name} gains in ${m}, m³/day`}
			caption="Base-flow gain, m³/day, per month"
			help="node.baseflowGainMonthlyM3Day"
			fillLabel="Use October’s gain for every month"
			{readonly}
			testid="baseflow-gain-months"
			onchange={(next) => (node.baseflowGainMonthlyM3Day = next)}
		/>
		<FieldHistoryLine field="node:{node.id}:baseflowGainMonthlyM3Day" {unit} />
	{/if}
</div>

<style>
	.by-month {
		margin-top: 0.5rem;
	}
	.check {
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.check-row .check {
		margin-bottom: 0;
	}
	.explain {
		margin: 0 0 0.5rem;
	}
</style>
