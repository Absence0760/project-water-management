<script lang="ts">
	// "Your farm on the river" (design §3 Q4): counts only, no names or
	// positions (D1 b); the outlet's days below its reserve, never a flow; the
	// one privacy sentence, and "Who can see my farm".
	//
	// The list of people by name (§10.2) needs an API that doesn't exist yet,
	// so the panel lists who, by role, and says the WUA can name them.
	import type { FarmView } from '@water-management/engine';
	import { outletLine, positionLine, PRIVACY, WHO_CAN_SEE } from './cards';
	import Rich from './Rich.svelte';

	let { view }: { view: FarmView } = $props();
	let open = $state(false);
</script>

<section class="card" aria-labelledby="fair-h">
	<h2 id="fair-h">Your farm on the river</h2>
	<p>{positionLine(view)}</p>
	<p><Rich text={outletLine(view)} /></p>
	<p class="privacy">
		<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11 V8 a4 4 0 0 1 8 0 V11" /></svg>
		<span>{PRIVACY}</span>
	</p>
	<button type="button" class="link toggle" aria-expanded={open} aria-controls="who-can-see" onclick={() => (open = !open)}>
		{WHO_CAN_SEE.heading}
	</button>
	<div id="who-can-see" class="who" hidden={!open}>
		<ul>
			{#each WHO_CAN_SEE.people as p (p)}<li>{p}</li>{/each}
		</ul>
		<p>{WHO_CAN_SEE.not}</p>
		<p class="fine">{WHO_CAN_SEE.names}</p>
	</div>
</section>

<style>
	.privacy {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 15px;
		color: var(--text-2);
	}
	.privacy svg {
		flex-shrink: 0;
		margin-top: 2px;
	}
	.toggle {
		padding: 0;
		font: inherit;
		font-weight: 600;
		background: none;
		border: 0;
		cursor: pointer;
		text-align: left;
	}
	.who {
		padding: 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.who[hidden] {
		display: none;
	}
	.who ul {
		margin: 0;
		padding-left: 20px;
	}
</style>
