<!-- i18n-section: share -->
<script lang="ts">
	// A read-only share link's page (roadmap WP-2.3 phase 2; docs/ui.md § Share
	// page): the catchment's published result for someone outside the project,
	// signed out, on a phone. The token is in the fragment (/share#t=…), which a
	// browser never sends to a server; it is read once, dropped from the
	// address bar (as the reset pages drop ?token=), and POSTed. Its words come
	// from the message catalogue (WP-2.5): lib/components/share/share.ts and
	// the share.* keys. The page is in the language this device chose, else
	// the browser's (the root layout), with the EN | AF switch in its header.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import NoticeCard from '$lib/components/farm/NoticeCard.svelte';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import FlowChart from '$lib/components/share/FlowChart.svelte';
	import { loadShare, type ShareLoad } from '$lib/components/share/load';
	import { farmsLine, publishedLine, readShareToken, reserveRows, shareNotice } from '$lib/components/share/share';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t, wordsLang } from '$lib/i18n/locale.svelte';

	let token: string | null = null;
	let result = $state<ShareLoad | null>(null);

	async function load() {
		result = null;
		result = await loadShare(api.share, token);
	}

	/** Read the token from the fragment, drop it from the address bar, and load. */
	function open() {
		token = readShareToken(location.hash);
		if (location.hash) replaceState(`${base}/share`, {});
		load();
	}

	onMount(() => {
		open();
		// A link pasted into this tab changes only the fragment, which is no new page load.
		const onHash = () => {
			if (location.hash) open();
		};
		window.addEventListener('hashchange', onHash);
		return () => window.removeEventListener('hashchange', onHash);
	});
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: result?.state === 'ready' ? t('{name} · Shared catchment view', { name: result.view.project.name }) : t('Shared catchment view') })}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="share">
	<header class="share-header">
		<span class="brand"><BrandMark size={26} /><span class="title">Water Management</span></span>
		<div class="end"><span class="tag">{t('Shared view')}</span><LanguageSwitch compact /></div>
	</header>

	<main class="share-main" data-share-state={result?.state ?? 'loading'} aria-busy={result ? undefined : 'true'}>
		{#if !result}
			<p class="sub" role="status">{t('Loading…')}</p>
		{:else if result.state === 'nolink' || result.state === 'dead'}
			<section class="card dead" aria-labelledby="dead-h">
				<h1 id="dead-h">{t('This link doesn’t open anything')}</h1>
				<p role="alert">{result.state === 'dead' ? t('This link has expired or was withdrawn. Ask whoever sent it for a new one.') : t('This page needs the whole link. Open the link you were sent again, or ask whoever sent it for a new one.')}</p>
			</section>
		{:else if result.state === 'error'}
			<section class="card" aria-labelledby="err-h">
				<h1 id="err-h">{t('Shared catchment view')}</h1>
				<p role="alert">{t('Couldn’t load this just now. Check your connection and try again.')}</p>
				<button type="button" class="btn" onclick={load}>{t('Try again')}</button>
			</section>
		{:else}
			{@const view = result.view}
			{@const cv = view.publication.catchmentView}
			{@const notice = shareNotice(view)}
			<div>
				<h1>{view.project.name}</h1>
				<p class="sub">{t('Catchment water balance, shared read-only')}</p>
				<p class="dates">{publishedLine(view)}</p>
			</div>

			<NoticeCard {notice} noneText={t('No restriction from the WUA')} pageLang={wordsLang()} />

			<section class="card" aria-labelledby="reserve-h">
				<h2 id="reserve-h">{t('The river’s ecological reserve')}</h2>
				<ul class="sites">
					{#each reserveRows(cv) as row, i (i)}
						<li class="site {row.state}">
							<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
								{#if row.state === 'met'}
									<circle cx="12" cy="12" r="9" /><path d="M7.5 12.5 L10.5 15.5 L16.5 9" />
								{:else}
									<path d="M12 3 L22 20 H2 Z" /><path d="M12 10 V14" /><path d="M12 17.5 V17.6" />
								{/if}
							</svg>
							<div>
								<p class="place">{row.place}</p>
								<p>{row.last30}</p>
								<p class="fine">{row.season}</p>
							</div>
						</li>
					{/each}
				</ul>
			</section>

			{#if result.months}
				<FlowChart months={result.months} />
			{:else}
				<p class="fine" role={result.chartFailed ? 'status' : undefined}>{result.chartFailed ? t('Couldn’t load the flow chart just now.') : t('The flow chart isn’t shown for this catchment: with so few farms, the river’s flows could reveal a farm’s water use.')}</p>
			{/if}

			<section class="card" aria-labelledby="about-h">
				<h2 id="about-h">{t('About this page')}</h2>
				<p>{t('This is the catchment’s published result from its water balance model: whether the river kept its ecological reserve (the flow it needs to stay healthy) and the Water User Association’s notice. It is read-only, and it shows no farm’s figures.')}</p>
				<p class="sub">{farmsLine(cv)}</p>
				<p class="fine">{t('A model of the catchment, not measurements; it can be wrong. This link works until it expires or is withdrawn.')}</p>
			</section>
		{/if}
	</main>
</div>

<style>
	.share {
		font-size: 16px;
		line-height: 1.45;
		min-height: 100vh;
		background: var(--bg);
	}
	.share-header {
		min-height: 56px;
		padding: 0 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 17px;
	}
	.end {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.tag {
		font-size: 14px;
		color: var(--text-2);
	}
	.share-main {
		max-width: 560px;
		margin: 0 auto;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.sites {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.site {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}
	.site svg {
		flex-shrink: 0;
		margin-top: 2px;
	}
	.site.met svg {
		color: var(--success);
	}
	.site.partly svg {
		color: var(--warning);
	}
	.site.missed svg {
		color: var(--danger);
	}
	.place {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.dead {
		gap: 12px;
	}

	/* The farm view's card language (FarmShell), for this page and the cards it borrows. */
	.share :global(h1) {
		margin: 0;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 26px;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.share :global(h2) {
		margin: 0;
		font-size: 17px;
		line-height: 1.3;
	}
	.share :global(p) {
		margin: 0;
	}
	.share :global(.card) {
		padding: 16px;
		border-radius: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.share :global(.sub) {
		color: var(--text-2);
	}
	.share :global(.fine) {
		font-size: 14px;
		color: var(--text-muted);
	}
	.share :global(.dates) {
		margin-top: 8px;
		font-size: 14px;
		color: var(--text-muted);
	}
	.share :global(details > summary) {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		color: var(--accent);
		font-weight: 600;
		cursor: pointer;
	}
	.share :global(table.numbers) {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}
	.share :global(table.numbers th),
	.share :global(table.numbers td) {
		padding: 4px 0;
		text-align: right;
		border-bottom: 1px solid var(--border);
	}
	.share :global(table.numbers th:first-child) {
		text-align: left;
		font-weight: 400;
	}
	.share :global(table.numbers thead th) {
		font-weight: 600;
	}
</style>
