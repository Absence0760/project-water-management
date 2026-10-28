<!-- i18n-section: farm.damPage -->
<script lang="ts">
	// "Your dam, seen from space" on the dam page (issue #604 R5-B; docs/ui.md
	// § Farmer view): the newest clear satellite view of the farm's dam, from
	// GET …/farm/:nodeId/dam-observed, in words (damObserved.ts), with its
	// credit. Nothing at all when the farm's dam isn't drawn as an outline on
	// the map; a failed load says so in one line, as the map card does.
	import type { FarmDamObserved } from '#lib/api/index.js';
	import { api } from '#lib/api/index.js';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { damObservedCard } from './damObserved';

	let { projectId, nodeId }: { projectId: string; nodeId: string } = $props();

	let data = $state<FarmDamObserved | null>(null);
	let failed = $state(false);

	$effect(() => {
		const [p, n] = [projectId, nodeId];
		let live = true;
		data = null;
		failed = false;
		api.farm.damObserved(p, n).then(
			(r) => {
				if (live) data = r;
			},
			() => {
				if (live) failed = true;
			}
		);
		return () => {
			live = false;
		};
	});

	const vm = $derived(damObservedCard(data));
</script>

{#if failed}
	<p class="fine" role="status" data-testid="farm-dam-observed-failed">{t('The view of your dam from space could not be loaded. Check your connection, then reload the page.')}</p>
{:else if vm}
	<section class="card" aria-labelledby="space-h" data-testid="farm-dam-observed">
		<h2 id="space-h">{vm.heading}</h2>
		<p data-testid="farm-dam-observed-line">{vm.line}</p>
		<p class="fine">{vm.about}</p>
		<p class="fine" data-testid="farm-dam-observed-credit">{vm.credit}</p>
	</section>
{/if}
