<!-- i18n-section: farm.supply -->
<script lang="ts">
	// "Water you received this season" (design §3 Q1), with the volume-unit
	// switch. The choice is the account's (app_user.volume_unit, PATCH
	// /auth/me, WP-2.5) and is also kept on the phone (savedCopy.writeUnit),
	// for the saved copy and a signed-out moment.
	import type { FarmProjection } from '@water-management/engine';
	import { basePath } from '#lib/nav/base.js';
	import { page } from '$app/state';
	import { api } from '#lib/api/index.js';
	import { session } from '#lib/auth/session.svelte.js';
	import { t } from '#lib/i18n/locale.svelte.js';
	import Rich from '#lib/i18n/Rich.svelte';
	import { littleNeed, supplyCard } from './cards';
	import { wordsHref } from './load';
	import type { VolumeUnit } from './format';
	import { writeUnit } from './savedCopy';

	let {
		farm,
		unit = $bindable(),
		staleEnd = null
	}: {
		farm: FarmProjection;
		unit: VolumeUnit;
		/** The figures' last day once they are stale (cards.ts staleUntil): "30 days to …", not "Last 30 days". */
		staleEnd?: string | null;
	} = $props();
	const vm = $derived(supplyCard(farm, unit, staleEnd));
	let failed = $state(false);

	// Saves go to the server one after another, and only the latest choice's
	// answer is kept: a quick m³ → ML → m³ sent side by side could reach the
	// server in either order and leave the account on ML, and ML's late answer
	// would set session.user back (ui-playbook § 5, the language switch's trap).
	let latestChoice = 0;
	let saving: Promise<void> = Promise.resolve();
	async function choose(u: VolumeUnit) {
		if (u === unit) return;
		unit = u;
		writeUnit(u);
		failed = false;
		if (!session.user) return;
		const mine = ++latestChoice;
		saving = saving.then(async () => {
			// A later choice came before this one's turn: that one is saved instead.
			if (mine !== latestChoice || !session.user) return;
			try {
				const user = await api.auth.updateMe({ volumeUnit: u });
				if (mine === latestChoice) session.user = user;
			} catch {
				if (mine === latestChoice) failed = true; // the switch still applies on this phone
			}
		});
		await saving;
	}
</script>

<section class="card" aria-labelledby="supply-h">
	<h2 id="supply-h">{t('Water you received this season')}</h2>
	{#if vm.pct}
		<p class="big"><span>{vm.pct}</span><span class="sub">{t('of what you needed')}</span></p>
		<div class="meter" aria-hidden="true"><span style:width="{vm.barPct}%"></span></div>
	{:else}
		<p>{littleNeed()}</p>
	{/if}
	<p>{vm.volumes}</p>
	<p>{vm.short}</p>
	<p class="last30"><Rich text={vm.last30} /></p>
	<p class="fine">{vm.efficiency}</p>
	<div class="units" role="group" aria-label={t('Show volumes in')}>
		<span>{t('Show in')}</span>
		<button type="button" aria-pressed={unit === 'ML'} onclick={() => choose('ML')}>ML</button>
		<button type="button" aria-pressed={unit === 'm3'} onclick={() => choose('m3')}>m³</button>
	</div>
	{#if failed}<p class="fine" role="status">{t('Couldn’t save your choice to your account. It applies on this phone.')}</p>{/if}
	<a class="link" href={wordsHref(basePath(), page.url, 'farm-pct-volume')}>{t('What do %, m³ and ML mean?')}</a>
</section>

<style>
	.last30 {
		padding-top: 8px;
		border-top: 1px solid var(--border);
		color: var(--text-2);
	}
	.last30 :global(strong) {
		color: var(--text);
	}
	.units {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		color: var(--text-2);
	}
	.units button {
		min-height: var(--tap);
		min-width: 56px;
		padding: 0 12px;
		border-radius: var(--radius-sm);
		font: inherit;
		font-weight: 600;
		border: 1px solid var(--border-input);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.units button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--accent);
	}
</style>
