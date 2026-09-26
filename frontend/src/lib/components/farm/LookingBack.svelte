<script lang="ts">
	// "Looking back" (design §3 Q2, §6.2): the model's card, neutral and dashed,
	// with the "Model: …" chip that never uses the notice's fills. Under a
	// `restricted` notice it collapses to one link line, so only the WUA's
	// percentage competes for attention.
	import type { FarmProjection } from '@water-management/engine';
	import { lookingBack, lookingBackShort, notOfficial } from './cards';
	import Rich from '$lib/i18n/Rich.svelte';

	let { farm, href, collapsed }: { farm: FarmProjection; href: string; collapsed: boolean } = $props();
	const vm = $derived(lookingBack(farm));
</script>

{#if collapsed}
	<a class="collapsed" {href}>
		<span>{lookingBackShort()}</span>
		<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 5 L16 12 L9 19" /></svg>
	</a>
{:else}
	<section class="card model" aria-labelledby="model-h">
		<div class="head">
			<h2 id="model-h">{vm.heading}</h2>
			{#if vm.chip}
				<span class="chip">
					<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 15 L11 11 L13 13 L16 9" /></svg>
					{vm.chip}
				</span>
			{/if}
		</div>
		<p><Rich text={vm.text} /></p>
		<p class="fine official">{notOfficial()}</p>
		<a class="link" {href}>{vm.link}<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 5 L16 12 L9 19" /></svg></a>
	</section>
{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border-radius: 999px;
		font-size: 14px;
		font-weight: 600;
		border: 1px solid var(--border-strong);
		color: var(--text-2);
	}
	.official {
		color: var(--text-2);
	}
	.collapsed {
		min-height: var(--tap);
		padding: 10px 16px;
		border-radius: 8px;
		border: 1px dashed var(--border-strong);
		background: var(--surface);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--text);
	}
	.collapsed svg {
		flex-shrink: 0;
		color: var(--accent);
	}
</style>
