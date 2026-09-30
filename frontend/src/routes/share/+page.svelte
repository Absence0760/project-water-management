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
	// One column on a phone; two on a laptop, so the result fits the window
	// (issue #17, docs/ui.md § Share page).
	// A scenario link (WP-3.15) says so in its fragment (`k=scenario`) and
	// opens ScenarioView in the same shell; its reader signing in to comment
	// comes back here with the token from this tab's sessionStorage.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import NoticeCard from '$lib/components/farm/NoticeCard.svelte';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import FlowChart from '$lib/components/share/FlowChart.svelte';
	import { loadScenarioShare, loadShare, type ScenarioShareLoad, type ShareLoad } from '$lib/components/share/load';
	import { readShareKind, SHARE_RETURN_KEY } from '$lib/components/share/scenario';
	import ScenarioView from '$lib/components/share/ScenarioView.svelte';
	import { farmsLine, publishedLine, readShareToken, reserveRows, shareCaveat, shareNotice } from '$lib/components/share/share';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t, wordsLang } from '$lib/i18n/locale.svelte';

	let token = $state<string | null>(null);
	let kind: 'scenario' | null = null;
	let result = $state<ShareLoad | ScenarioShareLoad | null>(null);
	let scenario = $state(false);

	async function load() {
		result = null;
		scenario = kind === 'scenario';
		result = kind === 'scenario' ? await loadScenarioShare(api.share, token) : await loadShare(api.share, token);
	}

	const sview = $derived(scenario && result?.state === 'ready' ? (result as Extract<ScenarioShareLoad, { state: 'ready' }>).view : null);
	const ready = $derived(!scenario && result?.state === 'ready' ? (result as Extract<ShareLoad, { state: 'ready' }>) : null);
	const title = $derived(sview ? t('{name} · Shared application', { name: sview.scenario.name }) : ready ? t('{name} · Shared catchment view', { name: ready.view.project.name }) : scenario ? t('Shared application') : t('Shared catchment view'));

	/** A scenario link kept while its reader signed in (ScenarioView), once. */
	function returning(): string {
		try {
			const kept = sessionStorage.getItem(SHARE_RETURN_KEY);
			sessionStorage.removeItem(SHARE_RETURN_KEY);
			const v = kept ? (JSON.parse(kept) as { t?: unknown; k?: unknown; exp?: unknown }) : null;
			return v && typeof v.t === 'string' && typeof v.exp === 'number' && v.exp > Date.now() ? `#t=${v.t}${v.k === 'scenario' ? '&k=scenario' : ''}` : '';
		} catch {
			return '';
		}
	}

	/** Read the token from the fragment, drop it from the address bar, and load. */
	function open() {
		const hash = location.hash || returning();
		token = readShareToken(hash);
		kind = readShareKind(hash);
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
	<title>{t('{page} · Water Management', { page: title })}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="share">
	<!-- The app's name with "Shared view" under it, so the header stays one
	     row on a 360 px phone with the EN | AF switch beside it. -->
	<header class="share-header">
		<div class="header-in">
			<span class="brand"><BrandMark size={26} /><span class="names"><span class="title">Water Management</span><span class="tag">{t('Shared view')}</span></span></span>
			<LanguageSwitch compact />
		</div>
	</header>

	<main class="share-main" class:wide={result?.state === 'ready'} data-share-state={result?.state ?? 'loading'} aria-busy={result ? undefined : 'true'}>
		{#if !result}
			<p class="sub" role="status">{t('Loading…')}</p>
		{:else if result.state === 'nolink' || result.state === 'dead'}
			<section class="card dead" aria-labelledby="dead-h">
				<h1 id="dead-h">{t('This link doesn’t open anything')}</h1>
				<p role="alert">{result.state === 'dead' ? t('This link has expired or was withdrawn. Ask whoever sent it for a new one.') : t('This page needs the whole link. Open the link you were sent again, or ask whoever sent it for a new one.')}</p>
			</section>
		{:else if result.state === 'error'}
			<section class="card" aria-labelledby="err-h">
				<h1 id="err-h">{scenario ? t('Shared application') : t('Shared catchment view')}</h1>
				<p role="alert">{t('Couldn’t load this just now. Check your connection and try again.')}</p>
				<button type="button" class="btn" onclick={load}>{t('Try again')}</button>
			</section>
		{:else if sview}
			<ScenarioView view={sview} token={token ?? ''} />
		{:else if ready}
			{@const view = ready.view}
			{@const cv = view.publication.catchmentView}
			{@const notice = shareNotice(view)}
			<div class="head">
				<h1>{view.project.name}</h1>
				<p class="sub">{t('Catchment water balance, shared read-only')}</p>
				<p class="dates">{publishedLine(view)}</p>
				<!-- Where the reliance happens, in body type (delict review §5.3): someone here accepted no terms. -->
				<p class="caveat" data-testid="share-caveat">{shareCaveat()}</p>
			</div>

			<!-- Phone: one column, the notice and the reserve first. From 860 px
			     wide: those two on the left, the flow chart and About on the
			     right, so the whole result fits a laptop screen. -->
			<div class="cols">
				<div class="col">
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
				</div>

				<div class="col">
					{#if ready.months}
						<FlowChart months={ready.months} />
					{:else}
						<p class="fine" role={ready.chartFailed ? 'status' : undefined}>{ready.chartFailed ? t('Couldn’t load the flow chart just now.') : t('The flow chart isn’t shown for this catchment: with so few hydrological units, the river’s flows could reveal a hydrological unit’s water use.')}</p>
					{/if}

					<section class="card" aria-labelledby="about-h">
						<h2 id="about-h">{t('About this page')}</h2>
						<p>{t('This is the catchment’s published result from its water balance model: whether the river kept its ecological reserve (the flow it needs to stay healthy) and the Water User Association’s notice. It is read-only, and it shows no hydrological unit’s figures.')}</p>
						<p class="sub">{farmsLine(cv)}</p>
						<!-- That it is a model estimate that can be wrong is the caveat under the heading. -->
						<p class="fine">{t('This link works until it expires or is withdrawn.')}</p>
						<!-- The one page that shows model results to someone who accepted no terms (a licence assessor, a neighbour): what the result is not, and the legal pages. -->
						<p class="fine">{t('It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.')}</p>
						<p class="fine legal-links"><a href="{base}/terms">{t('Terms of use')}</a> · <a href="{base}/privacy">{t('Privacy notice')}</a></p>
					</section>
				</div>
			</div>
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
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	/* The header's content lines up with the page's (1120 px on a wide
	   screen) rather than sitting at the window's far edges. */
	.header-in {
		max-width: 1120px;
		min-height: 56px;
		margin: 0 auto;
		padding: 4px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.names {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.2;
	}
	.title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 17px;
		white-space: nowrap;
	}
	.tag {
		font-size: 13px;
		color: var(--text-2);
	}
	.share-main {
		max-width: 560px;
		margin: 0 auto;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		container: share / inline-size;
	}
	/* The result is wider than a message: room for two columns. */
	.share-main.wide {
		max-width: 1120px;
	}
	.cols,
	.col {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	@container share (min-width: 860px) {
		.cols {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
			gap: 16px;
		}
		.col {
			gap: 16px;
		}
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
	/* The page's full width, not a reading measure: at 72ch it wrapped to a
	   third line and pushed About below a 1440 × 960 laptop screen. Two lines
	   at 1120 px; the phone's 560 px column is narrower than any measure. */
	.caveat {
		margin: 8px 0 0;
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
