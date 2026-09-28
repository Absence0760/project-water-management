<!-- i18n-section: farm.dam -->
<script lang="ts">
	// "Your dam" (design §3 Q3): how full, the stop mark, the 30-day change and
	// the days-left line, or the no-stop-level wording. Not rendered for a farm
	// with no dam (the page checks damCard() first).
	import { t } from '$lib/i18n/locale.svelte';
	import { damModelled, type DamVm } from './cards';
	import Rich from '$lib/i18n/Rich.svelte';

	let { vm, href }: { vm: DamVm; href: string } = $props();
</script>

<section class="card" aria-labelledby="dam-h">
	<h2 id="dam-h">{t('Your dam')}</h2>
	<p class="big"><span>{vm.pct}</span><span class="sub">{t('full')}</span></p>
	<div class="gauge" class:with-stop={vm.stopPct != null} aria-hidden="true">
		<div class="track"><span style:width="{vm.barPct}%"></span></div>
		{#if vm.stopPct != null}
			<div class="mark" style:left="{vm.stopPct}%"></div>
			<div class="mark-label" class:flip={vm.stopPct > 50} style:left="{vm.stopPct}%">{vm.stopLabel}</div>
		{/if}
	</div>
	{#if vm.stopLabel}<p class="visually-hidden">{vm.stopLabel}.</p>{/if}
	<p>{vm.volumes}</p>
	<p class="trend">
		<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2">
			{#if vm.trend.dir === 'up'}<path d="M12 19 V5" /><path d="M6 11 L12 5 L18 11" />
			{:else if vm.trend.dir === 'down'}<path d="M12 5 V19" /><path d="M6 13 L12 19 L18 13" />
			{:else}<path d="M5 12 H19" />{/if}
		</svg>
		{vm.trend.text}
	</p>
	{#if vm.daysLeft}<p class="note"><Rich text={vm.daysLeft} /></p>{/if}
	{#if vm.noStop}<p class="note">{vm.noStop}</p>{/if}
	<p class="fine">{damModelled()}</p>
	<a class="link" {href}>{t('Dam details')}<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 5 L16 12 L9 19" /></svg></a>
</section>

<style>
	.gauge {
		position: relative;
		height: 16px;
	}
	.gauge.with-stop {
		height: 38px;
	}
	.track {
		height: 16px;
		border-radius: 6px;
		background: var(--surface-sunken);
		overflow: hidden;
	}
	.track span {
		display: block;
		height: 100%;
		background: var(--brand-outlet);
	}
	.mark {
		position: absolute;
		top: -2px;
		width: 2px;
		height: 20px;
		background: var(--text);
	}
	.mark-label {
		position: absolute;
		top: 20px;
		font-size: 13px;
		color: var(--text-2);
		white-space: nowrap;
		transform: translateX(-4px);
	}
	/* A high stop level puts its label to the left of the mark, inside the card. */
	.mark-label.flip {
		transform: translateX(calc(-100% + 6px));
	}
	.trend {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-2);
	}
	.note {
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
	}
</style>
