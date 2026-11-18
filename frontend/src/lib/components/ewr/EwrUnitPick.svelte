<!--
	"At": where the daily EWR months-met panel is judged, the outlet or a hydrological unit with an EWR share
	(unitMonths.ts unitChoices). Shown only when there is a unit to pick. The EWR page puts it under the panel's
	heading; the scenario page above its pair, so one pick moves both sides.
-->
<script lang="ts">
	import type { UnitChoice } from './unitMonths';

	let { choices, value, onpick }: { choices: readonly UnitChoice[]; value: string | null; onpick: (nodeId: string | null) => void } = $props();

	const uid = $props.id();
</script>

{#if choices.length}
	<div class="at">
		<label for="{uid}-at">At</label>
		<select id="{uid}-at" value={value ?? ''} onchange={(e) => onpick(e.currentTarget.value || null)} data-testid="ewr-months-at">
			<option value="">The outlet</option>
			{#each choices as c (c.nodeId)}<option value={c.nodeId}>{c.name}</option>{/each}
		</select>
	</div>
{/if}

<style>
	.at {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0.25rem 0 0.5rem;
	}
	.at select {
		max-width: 100%;
		min-width: 0;
	}
</style>
