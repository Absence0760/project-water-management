<script lang="ts">
	// The phone-first farmer view (WP-2.6, docs/design/farmer-view.md §6.1):
	// one farm's page, from the current publication. ?node= picks the farm when
	// the farmer has several here (a switcher lists them). Viewer+ opening it
	// sees it as the farmer does, under a preview banner (FarmPage).
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { localIsoDate } from '$lib/format/number';
	import CompareCard from '$lib/components/farm/CompareCard.svelte';
	import DamCard from '$lib/components/farm/DamCard.svelte';
	import DatesLine from '$lib/components/farm/DatesLine.svelte';
	import FarmNotes from '$lib/components/farm/FarmNotes.svelte';
	import FarmPage from '$lib/components/farm/FarmPage.svelte';
	import LookingBack from '$lib/components/farm/LookingBack.svelte';
	import MonthlyChart from '$lib/components/farm/MonthlyChart.svelte';
	import NoticeCard from '$lib/components/farm/NoticeCard.svelte';
	import RiverCard from '$lib/components/farm/RiverCard.svelte';
	import SupplyCard from '$lib/components/farm/SupplyCard.svelte';
	import { damCard, datesLine, disclaimer, levelWord, noticeCard, stateText, supplyCard } from '$lib/components/farm/cards';
	import { FarmState } from '$lib/components/farm/farmState.svelte';
	import { farmHref } from '$lib/components/farm/load';
	import { readUnit } from '$lib/components/farm/savedCopy';
	import { t } from '$lib/i18n/locale.svelte';

	const projectId = $derived(page.params.projectId ?? '');
	const asked = $derived(page.url.searchParams.get('node'));
	const farm = new FarmState(api, () => session.user?.id ?? null);
	// The account's unit (app_user.volume_unit), else this phone's.
	let unit = $state(session.user?.volumeUnit ?? readUnit());
	const today = localIsoDate();

	const several = $derived((farm.index?.farms.length ?? 0) > 1);
	const href = (sub: string) => farmHref(base, projectId, farm.nodeId, several || !!asked, sub);
</script>

<svelte:head><title>{t('farm.pageTitle', { page: farm.farmName ?? t('farm.myFarm') })}</title></svelte:head>

<FarmPage {farm} {projectId} {asked}>
	{#snippet children(view)}
		{@const notice = noticeCard(view)}
		{@const dam = damCard(view.farm, unit)}
		{#if several && farm.index}
			<nav class="switch" aria-label={t('farm.page.switch')}>
				{#each farm.index.farms as f (f.nodeId)}
					<a href={farmHref(base, projectId, f.nodeId, true)} aria-current={f.nodeId === farm.nodeId ? 'page' : undefined}>{f.name}</a>
				{/each}
			</nav>
		{/if}
		<div>
			<h1>{view.farm.name}</h1>
			<p class="sub">{view.project.name}</p>
			<DatesLine line={datesLine(view, today)} />
			{#if farm.updating && farm.fromSaved}<p class="fine" role="status">{stateText('updating')}</p>{/if}
		</div>

		{#if farm.offline}
			<!-- No signal: the reduced view over the saved copy (board 8). -->
			<section class="card" aria-labelledby="o-notice">
				<h2 id="o-notice">{t('farm.page.offlineNotice', { level: levelWord(view.publication.restriction.level) })}</h2>
				{#if notice?.title}<p>{notice.title}</p>{/if}
			</section>
			<section class="card" aria-labelledby="o-glance">
				<h2 id="o-glance">{t('farm.page.glance')}</h2>
				<div class="glance">
					{#if view.farm.season.fraction != null}
						<div><p class="num-big">{supplyCard(view.farm, unit).pct}</p><p class="sub">{t('farm.page.glanceSupply')}</p></div>
					{/if}
					{#if dam}<div><p class="num-big">{dam.pct}</p><p class="sub">{t('farm.page.glanceDam')}</p></div>{/if}
				</div>
			</section>
			<p class="sub">{stateText('needsConnection')}</p>
		{:else}
			<NoticeCard {notice} />
			<SupplyCard farm={view.farm} bind:unit />
			{#if dam}<DamCard vm={dam} href={href('dam')} />{/if}
			<LookingBack farm={view.farm} href={href('why')} collapsed={view.publication.restriction.level === 'restricted'} />
			<!-- "Next 14 days" (ForecastCard) stays out until forecast mode exists (WP-2.12): the FarmView contract has no forecast yet. -->
			<MonthlyChart farm={view.farm} />
			<CompareCard farm={view.farm} />
			<RiverCard {view} />
			<FarmNotes {projectId} nodeId={view.farm.nodeId} farmName={view.farm.name} preview={farm.preview} />
			<nav class="more" aria-label={t('farm.page.more')}>
				<a href={api.farm.exportUrl(projectId, view.farm.nodeId)} download>{t('farm.page.download')}</a>
				<a href="{base}/farm/words">{t('farm.words')}</a>
			</nav>
			<p class="fine">{disclaimer()}</p>
		{/if}
	{/snippet}
</FarmPage>

<style>
	.switch {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.switch a {
		min-height: var(--tap);
		padding: 0 14px;
		display: inline-flex;
		align-items: center;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.switch a[aria-current='page'] {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-contrast);
		font-weight: 600;
	}
	.glance {
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
	}
	.num-big {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 40px;
		line-height: 1.1;
	}
	.more {
		display: flex;
		flex-direction: column;
	}
	.more a {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		align-self: flex-start;
		font-weight: 600;
	}
</style>
