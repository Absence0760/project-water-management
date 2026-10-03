<!--
	The rivers a Start or Divide proposal asks about (start-7; placement.ts):
	every point at a confluence at once, each with its rivers to pick from, as
	Delineate's sheet asks for one click. Propose again once each has its
	river; the picks stay in the sheet's draft for later proposals.
-->
<script lang="ts">
	import type { ConfluencePoint } from '$lib/api/types';
	import { choiceText } from './largerChannel';

	let {
		points,
		picked = $bindable(),
		busy,
		onsubmit,
		testid
	}: {
		points: ConfluencePoint[];
		/** The rivers picked so far, by the point's key ('' for the outlet gauge). */
		picked: Record<string, { dataset: string; reachId: number }>;
		busy: boolean;
		onsubmit: () => void;
		testid: string;
	} = $props();
	const uid = $props.id();
	const done = $derived(points.every((p) => !!picked[p.featureId]));
	const keyOf = (c: { dataset: string; reachId: number }) => `${c.dataset}:${c.reachId}`;
</script>

<div class="ask" role="group" aria-labelledby="{uid}-lead" data-testid={testid}>
	<p id="{uid}-lead">
		{points.length === 1 ? 'This point is' : 'These points are'} at a confluence of rivers of different sizes, so the elevation model can’t tell which river {points.length === 1 ? 'it is' : 'each is'} on. Pick the river for {points.length === 1 ? 'it' : 'each'}: it goes on the channel matching that river.
	</p>
	{#each points as p (p.featureId)}
		<fieldset>
			<legend>{p.featureId === '' ? `The outlet (${p.name})` : p.name}</legend>
			{#each p.choices as c (keyOf(c))}
				<label class="choice">
					<input
						type="radio"
						name="{uid}-{p.featureId || 'outlet'}"
						checked={!!picked[p.featureId] && keyOf(picked[p.featureId]!) === keyOf(c)}
						onchange={() => (picked[p.featureId] = { dataset: c.dataset, reachId: c.reachId })}
						data-reach={c.reachId}
					/>
					<span>{choiceText(c)}</span>
				</label>
			{/each}
		</fieldset>
	{/each}
	<p><button type="button" class="btn btn-primary btn-sm" disabled={busy || !done} onclick={onsubmit} data-testid="{testid}-submit">Propose with these rivers</button></p>
</div>

<style>
	.ask {
		border: 1px solid var(--warning);
		background: var(--warning-soft);
		border-radius: var(--radius-sm);
		padding: 0.6rem 0.8rem;
		margin: 0.6rem 0;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0.5rem 0;
	}
	legend {
		font-weight: 600;
		padding: 0;
	}
	.choice {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
		min-height: 24px;
	}
</style>
