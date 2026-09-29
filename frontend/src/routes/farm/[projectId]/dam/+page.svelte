<!-- i18n-section: farm.damPage -->
<script lang="ts">
	// The dam page (docs/design/farmer-view.md §3 Q3, §6.3, board 3). A farm
	// with no dam has no dam page: it says so and links back.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import DamChart from '$lib/components/farm/DamChart.svelte';
	import DatesLine from '$lib/components/farm/DatesLine.svelte';
	import { farmToday } from '$lib/components/farm/numbers';
	import EstimateNote from '$lib/components/farm/EstimateNote.svelte';
	import FarmPage from '$lib/components/farm/FarmPage.svelte';
	import ForecastCard from '$lib/components/farm/ForecastCard.svelte';
	import { forecastCard } from '$lib/components/farm/forecastCard';
	import Rich from '$lib/i18n/Rich.svelte';
	import { datesLine, staleUntil } from '$lib/components/farm/cards';
	import { damPage, damSource } from '$lib/components/farm/dam';
	import { FarmState } from '$lib/components/farm/farmState.svelte';
	import { farmHref } from '$lib/components/farm/load';
	import { readUnit } from '$lib/components/farm/savedCopy';
	import { t } from '$lib/i18n/locale.svelte';

	const projectId = $derived(page.params.projectId ?? '');
	const asked = $derived(page.url.searchParams.get('node'));
	const farm = new FarmState(api, () => session.user?.id ?? null);
	// The account's unit (app_user.volume_unit), else this phone's.
	const unit = $derived(session.user?.volumeUnit ?? readUnit());
	const main = $derived(farmHref(base, projectId, farm.nodeId, !!asked));
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: t('Your dam') })}</title></svelte:head>

<FarmPage {farm} {projectId} {asked} back={{ href: main, label: t('My hydrological unit') }}>
	{#snippet children(view)}
		{@const d = damPage(view.farm, unit, staleUntil(view, farmToday(view)))}
		<div>
			<h1>{t('Your dam')}</h1>
			<p class="sub">{view.farm.name}</p>
			<DatesLine line={datesLine(view, farmToday(view))} />
		</div>
		<EstimateNote />
		{#if !d}
			<p>{t('{farm} has no dam in the model.', { farm: view.farm.name })}</p>
			<a class="link" href={main}>{t('Back to my hydrological unit')}</a>
		{:else}
			<section class="card" aria-labelledby="now-h">
				<h2 id="now-h" class="visually-hidden">{t('How full it is')}</h2>
				<p class="big"><span>{d.pct}</span><span class="sub">{d.asOf}</span></p>
				<div class="gauge" class:with-stop={d.stopPct != null} aria-hidden="true">
					<div class="track"><span style:width="{d.barPct}%"></span></div>
					{#if d.stopPct != null}
						<div class="mark" style:left="{d.stopPct}%"></div>
						<div class="mark-label" class:flip={d.stopPct > 50} style:left="{d.stopPct}%">{d.stopLabel}</div>
					{/if}
				</div>
				{#if d.stopLabel}<p class="visually-hidden">{d.stopLabel}.</p>{/if}
				<dl class="facts">
					{#each d.facts as f (f.label)}
						<div><dt>{f.label}</dt><dd>{f.value}</dd></div>
					{/each}
				</dl>
				{#if d.usableNote}<p class="fine">{d.usableNote}</p>{/if}
				{#if d.daysLeft}<p class="note"><Rich text={d.daysLeft} /></p>{/if}
				{#if d.noStop}<p class="note">{d.noStop}</p>{/if}
			</section>

			<DamChart farm={view.farm} caption={d.chartCaption} />
			<!-- "Next 14 days" (WP-2.12): only when the WUA published a forecast run. -->
			{@const forecast = forecastCard(view.farm, farmToday(view))}
			{#if forecast}<ForecastCard vm={forecast} />{/if}

			<section class="card" aria-labelledby="about-h">
				<h2 id="about-h">{t('Where these figures come from')}</h2>
				{#each damSource() as p (p)}<p>{p}</p>{/each}
				<a class="link" href="{base}/farm/words#farm-modelled">{t('What is “modelled”?')}</a>
			</section>
		{/if}
	{/snippet}
</FarmPage>

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
	.mark-label.flip {
		transform: translateX(calc(-100% + 6px));
	}
	.facts {
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.facts div {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 12px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
	.facts dt {
		color: var(--text-2);
	}
	.facts dd {
		margin: 0;
		font-weight: 600;
	}
	.note {
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
	}
</style>
