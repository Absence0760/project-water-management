<script lang="ts">
	// River to dam by month (engine ≥ 1.31.0, issue #204, docs/model.md
	// §2.7h), under the River to dam field in the one-node form's Routing: a
	// capacity for each water-year month in place of the one value, so 0 in
	// the summer months fills the dam in winter only. Unticked is null: the one
	// value all year, as on a model from before 1.31.0.
	import type { NetworkNode } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import MonthFields from './MonthFields.svelte';
	import { divertMonthsPreview, divertMonthsTicked } from './supply';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const label = $derived(node.name || 'this hydrological unit');
	const months = $derived(node.divertMonthlyM3Day ?? null);
	const preview = $derived(divertMonthsPreview(node));
</script>

<div class="by-month" data-testid="river-to-dam-months-{node.id}">
	<div class="check-row">
		<label class="check">
			<input
				type="checkbox"
				disabled={readonly}
				checked={months !== null}
				onchange={(e) => (node.divertMonthlyM3Day = divertMonthsTicked(e.currentTarget.checked, node.divertCapacityM3Day))}
			/>
			Set River to dam by month
		</label>
		<HelpTip key="node.divertMonthlyM3Day" />
	</div>
	{#if months !== null}
		<MonthFields
			values={months}
			label={(m) => `River to dam of ${label} in ${m}, m³/day`}
			caption="River to dam, m³/day, per month"
			fillLabel="Use October’s capacity for every month"
			{readonly}
			onchange={(next) => (node.divertMonthlyM3Day = next)}
		/>
	{/if}
	{#if preview}<p class="hint note" data-testid="river-to-dam-months-note">{preview}</p>{/if}
</div>

<style>
	.by-month {
		grid-column: 1 / -1;
		margin-bottom: 0.5rem;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.note {
		margin: 0.25rem 0;
		font-size: 0.85rem;
	}
</style>
