<!-- i18n-section: farm.river -->
<script lang="ts">
	// "Your farm on the river" (design §3 Q4): counts only, no names or
	// positions (D1 b); the outlet's days below its reserve, never a flow; the
	// one privacy sentence, and "Who can see my farm".
	//
	// "Who can see my farm" loads the people by name when first opened
	// (GET …/access, §10.2); if that fails it falls back to who, by role.
	import type { FarmView } from '@water-management/engine';
	import { api, type FarmAccessPerson } from '$lib/api';
	import { t } from '$lib/i18n/locale.svelte';
	import { accessLine, outletLine, positionLine, privacy, whoCanSee } from './cards';
	import Rich from '$lib/i18n/Rich.svelte';

	let { view }: { view: FarmView } = $props();
	let open = $state(false);
	let people = $state<FarmAccessPerson[] | null>(null);
	let failed = $state(false);
	const who = $derived(whoCanSee());

	async function toggle() {
		open = !open;
		if (!open || people) return;
		failed = false;
		try {
			people = await api.farm.access(view.project.id, view.farm.nodeId);
		} catch {
			failed = true; // shown: the roles-only list and whoCanSee().failed
		}
	}
</script>

<section class="card" aria-labelledby="fair-h">
	<h2 id="fair-h">{t('Your hydrological unit on the river')}</h2>
	<p>{positionLine(view)}</p>
	<p><Rich text={outletLine(view)} /></p>
	<p class="privacy">
		<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11 V8 a4 4 0 0 1 8 0 V11" /></svg>
		<span>{privacy()}</span>
	</p>
	<button type="button" class="link toggle" aria-expanded={open} aria-controls="who-can-see" onclick={toggle}>
		{who.heading}
	</button>
	<div id="who-can-see" class="who" hidden={!open}>
		{#if people}
			<ul>
				{#each people as p, i (i)}<li>{accessLine(p)}</li>{/each}
			</ul>
		{:else if failed}
			<ul>
				{#each who.people as p (p)}<li>{p}</li>{/each}
			</ul>
			<p class="fine" role="status">{who.failed}</p>
		{:else}
			<p class="fine" role="status">{who.loading}</p>
		{/if}
		<p>{who.not}</p>
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
