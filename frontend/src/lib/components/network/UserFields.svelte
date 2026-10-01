<script lang="ts">
	// An other water user's fields (WP-1.33, docs/model.md §2.7c): priority,
	// the share returned below it, its river pump's capacity (engine ≥ 1.58.0,
	// WP-3.8) and its demand per water-year month. Used by the one-node form
	// and the "Other water users" panel. As on a hydrological unit's supply
	// fields, only the m³/day is stored; the pumps × m³/h is a calculator.
	import { USER_PRIORITIES, type NetworkNode, type UserPriority } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import MonthFields from './MonthFields.svelte';
	import { pumpM3Day } from './supply';
	import { userDemandOf, userPumpNote } from './users';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const id = (k: string) => `usr-${k}-${node.id}`;
	const label = $derived(node.name || 'this user');
	const PRIORITY_LABEL: Record<UserPriority, string> = {
		senior: 'Senior: hydrological units upstream pass its demand first',
		junior: 'Junior: takes what reaches it'
	};
	const demand = $derived(userDemandOf(node));
	const pump = $derived(node.pumpCapacityM3Day ?? null);

	// The calculator: not stored. Filling both sets the capacity; typing a capacity clears them.
	let pumps = $state<number | null>(null);
	let rate = $state<number | null>(null);
	function calc(p: number | null, r: number | null) {
		pumps = p;
		rate = r;
		const v = pumpM3Day(p, r);
		if (v !== null) node.pumpCapacityM3Day = v;
	}
</script>

<div class="user" data-testid="user-fields-{node.id}">
	<div class="row">
		<div class="field">
			<span class="lbl"><label for={id('priority')}>Priority</label><HelpTip key="node.userPriority" /></span>
			<select id={id('priority')} disabled={readonly} value={node.userPriority ?? 'senior'} onchange={(e) => (node.userPriority = e.currentTarget.value as UserPriority)}>
				{#each USER_PRIORITIES as p (p)}<option value={p}>{PRIORITY_LABEL[p]}</option>{/each}
			</select>
		</div>
		<div class="field">
			<span class="lbl"><label for={id('return')}>Share returned <span class="u">(%)</span></label><HelpTip key="node.userReturnPct" /></span>
			<NumberInput
				id={id('return')}
				min={0}
				max={100}
				scale={100}
				disabled={readonly}
				value={node.userReturnPct ?? 0}
				onchange={(v) => (node.userReturnPct = v ?? 0)}
			/>
		</div>
	</div>
	<div class="row pump" data-testid="user-pump-{node.id}">
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
			<span class="lbl"><label for={id('pump')}>Pump capacity <span class="u">(m³/day)</span></label><HelpTip key="run.pump_limited" /></span>
			<NumberInput
				id={id('pump')}
				min={0}
				grouped
				nullable
				placeholder="no limit"
				disabled={readonly}
				aria-describedby="{id('pump')}-h"
				value={pump}
				onchange={(v) => {
					node.pumpCapacityM3Day = v;
					if (v !== pumpM3Day(pumps, rate)) {
						pumps = null;
						rate = null;
					}
				}}
			/>
			<span class="hint" id="{id('pump')}-h" data-testid="user-pump-note">
				{#if pumpM3Day(pumps, rate) !== null}
					{fmtNum(pumps, 0, true)} × {fmtNum(rate, 2, true)} m³/h × 24 h = {fmtNum(pumpM3Day(pumps, rate), 0)} m³/day.
				{:else}
					{userPumpNote(node, readonly)}
				{/if}
			</span>
			<FieldHistoryLine field="node:{node.id}:pumpCapacityM3Day" unit={null} />
		</div>
	</div>
	<MonthFields
		values={demand}
		label={(m) => `Demand of ${label} in ${m}, m³/day`}
		caption="Demand from the river, m³/day, per month"
		help="node.userDemandM3Day"
		fillLabel="Use October’s demand for every month"
		{readonly}
		onchange={(next) => (node.userDemandM3Day = next)}
	/>
</div>

<style>
	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0 1rem;
	}
	.field select,
	.field :global(input) {
		width: 100%;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.pump {
		margin-top: 0.5rem;
	}
	@media (max-width: 640px) {
		.field select,
		.field :global(input) {
			min-height: 44px;
		}
	}
</style>
