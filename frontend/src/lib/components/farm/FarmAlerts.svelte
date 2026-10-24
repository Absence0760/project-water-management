<!-- i18n-section: farm.alerts -->
<script lang="ts">
	// The farm's own alert (WP-2.13): shown while its dam is below the WUA's
	// alert level, in the words of the alert email. The API returns a farmer
	// only their own farms' alerts (RLS); this picks the farm on the page.
	// Nothing shows while there is none, or if the alerts can't be loaded (the
	// dam card says the same figures).
	import { resolve } from '$app/paths';
	import { api, type AlertEvent } from '#lib/api/index.js';
	import { farmAlertText } from '#lib/components/alerts/words.js';
	import { t } from '#lib/i18n/locale.svelte.js';
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
		<!-- A link of its own, not a line of small print: a 44 px target like the page's other links. -->
		<a class="link" href={resolve('account/alerts')}>{t('Choose your alert emails')}</a>
	</section>
{/if}

<style>
	.farm-alert {
		border-left: 4px solid var(--warning, currentColor);
	}
</style>
