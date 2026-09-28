<!-- i18n-section: farm.alerts -->
<script lang="ts">
	// The farm's own alert (WP-2.13): shown while its dam is below the WUA's
	// alert level, in the words of the alert email. The API returns a farmer
	// only their own farms' alerts (RLS); this picks the farm on the page.
	// Nothing shows while there is none, or if the alerts can't be loaded (the
	// dam card says the same figures).
	import { base } from '$app/paths';
	import { api, type AlertEvent } from '$lib/api';
	import { farmAlertText } from '$lib/components/alerts/words';
	import { t } from '$lib/i18n/locale.svelte';
	import { fmtDay, fmtPct } from './format';

	let { projectId, nodeId }: { projectId: string; nodeId: string } = $props();

	let events = $state<AlertEvent[]>([]);
	$effect(() => {
		const id = projectId;
		api.alerts
			.events(id)
			.then((e) => {
				if (id === projectId) events = e;
			})
			.catch(() => {
				events = [];
			});
	});
	const text = $derived(farmAlertText(events, nodeId, { pct: fmtPct, date: fmtDay }));
</script>

{#if text}
	<section class="card farm-alert" aria-labelledby="farm-alert-h" data-testid="farm-alert">
		<h2 id="farm-alert-h">{t('Alerts')}</h2>
		<p>{text}</p>
		<p class="fine"><a href="{base}/account/alerts">{t('Choose your alert emails')}</a></p>
	</section>
{/if}

<style>
	.farm-alert {
		border-left: 4px solid var(--warning, currentColor);
	}
</style>
