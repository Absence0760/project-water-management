<script lang="ts">
	// The compare page's "Scenario overrides" section (docs/run-comparison.md
	// § Scenario runs): for each side made by a scenario, the ops exactly as
	// that run recorded them and how each was classed, with the red
	// "Baseline assumptions changed" callout. When the other side is the
	// scenario's own base, each op is described against it (the value it
	// replaced); otherwise only what it set.
	import type { CompareSide, RunCompareResponse } from '$lib/api';
	import OpList from './OpList.svelte';
	import { namesOf, opItems, snapshotInput } from './ops';

	let { data }: { data: RunCompareResponse } = $props();

	const names = $derived(namesOf([data.a.run.inputs.model, data.b.run.inputs.model]));
	function sideView(label: 'A' | 'B', side: CompareSide, other: CompareSide) {
		const sc = side.scenario;
		if (!sc) return null;
		const onBase = other.run.id === sc.baseRunId;
		const base = onBase ? snapshotInput(other.run.inputs.model, other.run.inputs.settings) : null;
		const { items } = opItems(sc.ops, sc.classified, null, base, new Map([...names, ...namesOf([], sc.ops)]));
		return { label, name: sc.name, onBase, items };
	}
	const sides = $derived([sideView('A', data.a, data.b), sideView('B', data.b, data.a)].filter((x) => x !== null));
</script>

{#each sides as v (v.label)}
	<div class="side" data-testid="scenario-overrides-{v.label.toLowerCase()}">
		<p class="head">
			Run {v.label} is the scenario <strong>{v.name}</strong>{v.onBase ? `, on run ${v.label === 'A' ? 'B' : 'A'} as its base` : ', on a base run not shown here'}:
			{v.items.length} change{v.items.length === 1 ? '' : 's'}.
		</p>
		<OpList items={v.items} label="Changes in scenario {v.name} (run {v.label})" />
	</div>
{/each}

<style>
	.side + .side {
		margin-top: 1rem;
	}
	.head {
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
	}
</style>
