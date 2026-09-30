<script lang="ts">
	// River to dam by month (engine ≥ 1.31.0, issue #204, docs/model.md
	// §2.7h), under the River to dam field in the one-node form's Routing: a
	// capacity for each water-year month in place of the one value, so 0 in
	// the summer months fills the dam in winter only. Unticked is null: the one
	// value all year, as on a model from before 1.31.0.
	import type { NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { divertMonthsPreview } from './supply';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const label = $derived(node.name || 'this hydrological unit');
	const months = $derived(node.divertMonthlyM3Day ?? null);
	const preview = $derived(divertMonthsPreview(node));

	function setMonth(i: number, v: number | null) {
		const next = [...(months ?? new Array<number>(12).fill(0))];
		next[i] = v ?? 0;
		node.divertMonthlyM3Day = next;
	}
	function fillAll() {
		node.divertMonthlyM3Day = new Array(12).fill(months?.[0] ?? 0);
	}
</script>

<div class="by-month" data-testid="river-to-dam-months-{node.id}">
	<label class="check">
		<input
			type="checkbox"
			disabled={readonly}
			checked={months !== null}
			onchange={(e) => (node.divertMonthlyM3Day = e.currentTarget.checked ? new Array(12).fill(node.divertCapacityM3Day) : null)}
		/>
		Set River to dam by month
		<HelpTip key="node.divertMonthlyM3Day" />
	</label>
	{#if months !== null}
		<table class="data compact months">
			<caption>River to dam, m³/day, per month</caption>
			<thead>
				<tr>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr>
			</thead>
			<tbody>
				<tr>
					{#each WATER_YEAR_MONTHS as m, i (m)}
						<td>
							<NumberInput label="River to dam of {label} in {m}, m³/day" min={0} grouped={readonly} disabled={readonly} value={months[i] ?? 0} onchange={(v) => setMonth(i, v)} />
						</td>
					{/each}
				</tr>
			</tbody>
		</table>
		{#if !readonly}
			<button type="button" class="btn btn-sm" onclick={fillAll}>Use October’s capacity for every month</button>
		{/if}
	{/if}
	{#if preview}<p class="hint note" data-testid="river-to-dam-months-note">{preview}</p>{/if}
</div>

<style>
	.by-month {
		grid-column: 1 / -1;
		margin-bottom: 0.5rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
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
	.note {
		margin: 0.25rem 0;
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.btn {
			min-height: 44px;
		}
	}
</style>
