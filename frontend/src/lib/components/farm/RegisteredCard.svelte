<!-- i18n-section: farm.registered -->
<script lang="ts">
	// "Your registered water" (issue #72, docs/allocations.md § Who sees what):
	// the farm's own registered volumes and storage, never anyone else's, with
	// what a registration is not. Rendered only when something is registered
	// (registeredCard() is null otherwise).
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/locale.svelte';
	import { registeredNote, type RegisteredVm } from './cards';
	import { wordsHref } from './load';

	let { vm }: { vm: RegisteredVm } = $props();
</script>

<section class="card" aria-labelledby="registered-h">
	<h2 id="registered-h">{t('Your registered water')}</h2>
	<ul class="lines">
		{#each vm.lines as line (line)}<li>{line}</li>{/each}
	</ul>
	{#if vm.use}<p>{vm.use}</p>{/if}
	{#if vm.dam}<p>{vm.dam}</p>{/if}
	<p class="fine">{registeredNote()}</p>
	<a class="link" href={wordsHref(base, page.url, 'farm-registered')}>{t('What is registered water?')}</a>
</section>

<style>
	.lines {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-weight: 600;
	}
</style>
