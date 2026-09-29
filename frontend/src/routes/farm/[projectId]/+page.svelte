<!-- i18n-section: farm.page -->
<script lang="ts">
	// The phone-first farmer view (WP-2.6, docs/design/farmer-view.md §6.1):
	// one farm's page, from the current publication. ?node= picks the farm when
	// the farmer has several here (a switcher lists them). Viewer+ opening it
	// sees it as the farmer does, under a preview banner (FarmPage).
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import CompareCard from '$lib/components/farm/CompareCard.svelte';
	import DamCard from '$lib/components/farm/DamCard.svelte';
	import ForecastCard from '$lib/components/farm/ForecastCard.svelte';
	import OutlookCard from '$lib/components/farm/OutlookCard.svelte';
	import { forecastCard } from '$lib/components/farm/forecastCard';
	import { outlookCard } from '$lib/components/farm/outlookCard';
	import DatesLine from '$lib/components/farm/DatesLine.svelte';
	import { farmToday } from '$lib/components/farm/numbers';
	import EstimateNote from '$lib/components/farm/EstimateNote.svelte';
	import FarmAlerts from '$lib/components/farm/FarmAlerts.svelte';
	import FarmNotes from '$lib/components/farm/FarmNotes.svelte';
	import FarmPage from '$lib/components/farm/FarmPage.svelte';
	import LookingBack from '$lib/components/farm/LookingBack.svelte';
	import MonthlyChart from '$lib/components/farm/MonthlyChart.svelte';
	import NoticeCard from '$lib/components/farm/NoticeCard.svelte';
	import RiverCard from '$lib/components/farm/RiverCard.svelte';
	import SupplyCard from '$lib/components/farm/SupplyCard.svelte';
	import { damCard, datesLine, disclaimer, levelWord, noRestriction, noticeCard, stateText, supplyCard } from '$lib/components/farm/cards';
	import { FarmState } from '$lib/components/farm/farmState.svelte';
	import { count, FARMS } from '$lib/components/farm/format';
	import { withNoteLine } from '$lib/components/farm/csvNote';
	import { farmHref } from '$lib/components/farm/load';
	import { fetchDownload, saveBlob } from '$lib/export/download';
	import { errorText } from '$lib/i18n/apiError';
	import { readUnit } from '$lib/components/farm/savedCopy';
	import { holdAnchor } from '$lib/help/anchor';
	import { t, wordsLang } from '$lib/i18n/locale.svelte';

	const projectId = $derived(page.params.projectId ?? '');
	const asked = $derived(page.url.searchParams.get('node'));
	const farm = new FarmState(api, () => session.user?.id ?? null);
	// The account's unit (app_user.volume_unit), else this phone's.
	let unit = $state(session.user?.volumeUnit ?? readUnit());

	// Up to this many farms here, the switcher is a row of chips above the
	// name; past it, they fold under "Your farms in this catchment (N farms)" (a WUA previewing sees
	// every farm in the catchment, and 30 chips pushed the notice a screen down).
	const SWITCH_CHIPS = 4;
	const several = $derived((farm.index?.farms.length ?? 0) > 1);
	// A link into the page ("Read the notice" on Why?, `#notice`) lands only
	// once the farm has loaded: on a fresh load the browser's own jump runs
	// before the cards exist. Held while the page settles
	// (lib/help/anchor.ts), as the words page does.
	const shown = $derived(farm.phase.kind === 'ready' && !!farm.view);
	$effect(() => {
		const id = decodeURIComponent(page.url.hash.slice(1));
		if (!id || !shown) return;
		let live = true;
		let release: (() => void) | undefined;
		tick().then(() => {
			const el = live ? document.getElementById(id) : null;
			if (el) release = holdAnchor(el);
		});
		return () => {
			live = false;
			release?.();
		};
	});
	const href = (sub: string) => farmHref(base, projectId, farm.nodeId, several || !!asked, sub);

	// The CSV goes through fetch so the farm disclaimer, in the reader's language, leads the file (csvNote.ts).
	let csvError = $state('');
	async function downloadCsv(e: MouseEvent, url: string) {
		e.preventDefault();
		csvError = '';
		try {
			const { blob, filename } = await fetchDownload(url);
			saveBlob(new Blob([withNoteLine(await blob.text(), disclaimer())], { type: 'text/csv;charset=utf-8' }), filename);
		} catch (err) {
			csvError = errorText(err);
		}
	}
</script>

<svelte:head><title>{t('{page} · My hydrological unit', { page: farm.farmName ?? t('My hydrological unit') })}</title></svelte:head>

<FarmPage {farm} {projectId} {asked}>
	{#snippet children(view)}
		{@const notice = noticeCard(view)}
		{@const dam = damCard(view.farm, unit)}
		{#if several && farm.index}
			{#snippet switcher(farms: { nodeId: string; name: string }[])}
				<nav class="switch" aria-label={t('Your hydrological units in this catchment')}>
					{#each farms as f (f.nodeId)}
						<a href={farmHref(base, projectId, f.nodeId, true)} aria-current={f.nodeId === farm.nodeId ? 'page' : undefined}>{f.name}</a>
					{/each}
				</nav>
			{/snippet}
			{#if farm.index.farms.length <= SWITCH_CHIPS}
				{@render switcher(farm.index.farms)}
			{:else}
				<!-- Many farms: folded, so the farm's name and the WUA's notice stay on the first screen (ui.md § Farmer view). -->
				<details class="switch-more">
					<!-- The nav's own (translated) name, with the count beside it: no new words to translate. -->
					<summary>{t('Your hydrological units in this catchment')} ({count(FARMS, farm.index.farms.length)})</summary>
					{@render switcher(farm.index.farms)}
				</details>
			{/if}
		{/if}
		<div>
			<h1>{view.farm.name}</h1>
			<p class="sub">{view.project.name}</p>
			<DatesLine line={datesLine(view, farmToday(view))} />
			{#if farm.updating && farm.fromSaved}<p class="fine" role="status">{stateText('updating')}</p>{/if}
		</div>

		{#if farm.offline}
			<!-- No signal: the reduced view over the saved copy (board 8). -->
			<section class="card" aria-labelledby="o-notice">
				<h2 id="o-notice">{t('WUA notice · {level}', { level: levelWord(view.publication.restriction.level) })}</h2>
				{#if notice?.title}<p lang={notice.lang && notice.lang !== wordsLang() ? notice.lang : undefined}>{notice.title}</p>{/if}
			</section>
			<!-- The estimate line before any figure (EstimateNote), here as on the full page. -->
			<EstimateNote />
			<section class="card" aria-labelledby="o-glance">
				<h2 id="o-glance">{t('At a glance')}</h2>
				<div class="glance">
					{#if view.farm.season.fraction != null}
						<div><p class="num-big">{supplyCard(view.farm, unit).pct}</p><p class="sub">{t('of the water you needed this season')}</p></div>
					{/if}
					{#if dam}<div><p class="num-big">{dam.pct}</p><p class="sub">{t('dam full')}</p></div>{/if}
				</div>
			</section>
			<p class="sub">{stateText('needsConnection')}</p>
		{:else}
			<NoticeCard {notice} noneText={noRestriction()} pageLang={wordsLang()} />
			<!-- The estimate line: after the WUA's notice, before the first figure (EstimateNote). -->
			<EstimateNote />
			<!-- The farm's own dam alert, while it is firing (WP-2.13). -->
			<FarmAlerts {projectId} nodeId={view.farm.nodeId} />
			<SupplyCard farm={view.farm} bind:unit />
			{#if dam}<DamCard vm={dam} href={href('dam')} />{/if}
			<LookingBack farm={view.farm} href={href('why')} collapsed={view.publication.restriction.level === 'restricted'} />
			<!-- "Next 14 days" (WP-2.12): only when the WUA published a forecast run. -->
			{@const forecast = forecastCard(view.farm, farmToday(view))}
			{#if forecast}<ForecastCard vm={forecast} />{/if}
			<!-- "This season" (issue #53 R5, E3): only while the WUA has a seasonal outlook published. -->
			{@const seasonOutlook = outlookCard(view, farmToday(view))}
			{#if seasonOutlook}<OutlookCard vm={seasonOutlook} />{/if}
			<MonthlyChart farm={view.farm} {unit} />
			<CompareCard farm={view.farm} />
			<RiverCard {view} />
			<FarmNotes {projectId} nodeId={view.farm.nodeId} farmName={view.farm.name} preview={farm.preview} />
			<nav class="more" aria-label={t('More')}>
				<a href={api.farm.exportUrl(projectId, view.farm.nodeId)} download onclick={(e) => downloadCsv(e, api.farm.exportUrl(projectId, view.farm.nodeId))}
					>{t('Download my figures (CSV)')}</a
				>
				<a href="{base}/farm/words">{t('What do these words mean?')}</a>
			</nav>
			{#if csvError}<p class="fine" role="alert">{csvError}</p>{/if}
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
	.switch-more > .switch {
		margin-top: 4px;
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
