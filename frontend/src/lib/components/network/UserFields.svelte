<script lang="ts">
	// An other water user's fields (WP-1.33, docs/model.md §2.7c): priority,
	// the share returned below it, and its demand per water-year month. Used
	// by the one-node form and the "Other water users" panel.
	import { USER_PRIORITIES, type NetworkNode, type UserPriority } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { userDemandOf } from './users';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const id = (k: string) => `usr-${k}-${node.id}`;
	const label = $derived(node.name || 'this user');
	const PRIORITY_LABEL: Record<UserPriority, string> = {
		senior: 'Senior: units upstream pass its demand first',
		junior: 'Junior: takes what reaches it'
	};
	const demand = $derived(userDemandOf(node));

	function setMonth(i: number, v: number | null) {
		const next = [...userDemandOf(node)];
		next[i] = v ?? 0;
		node.userDemandM3Day = next;
	}

	function fillAll() {
		const first = userDemandOf(node)[0] ?? 0;
		node.userDemandM3Day = new Array(12).fill(first);
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
	<table class="data compact months">
		<caption>
			Demand from the river, m³/day, per month <HelpTip key="node.userDemandM3Day" />
		</caption>
		<thead>
			<tr>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr>
		</thead>
		<tbody>
			<tr>
				{#each WATER_YEAR_MONTHS as m, i (m)}
					<td>
						<NumberInput label="Demand of {label} in {m}, m³/day" min={0} grouped={readonly} disabled={readonly} value={demand[i] ?? 0} onchange={(v) => setMonth(i, v)} />
					</td>
				{/each}
			</tr>
		</tbody>
	</table>
	{#if !readonly}
		<button type="button" class="btn btn-sm" onclick={fillAll}>Use October’s demand for every month</button>
	{/if}
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
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.months {
		display: block;
		overflow-x: auto;
		margin: 0.5rem 0;
	}
	.months caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-2);
		padding-bottom: 0.25rem;
	}
	.months td {
		min-width: 76px;
	}
	.months td :global(input) {
		width: 100%;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 640px) {
		.field select,
		.field :global(input) {
			min-height: 44px;
		}
	}
</style>
