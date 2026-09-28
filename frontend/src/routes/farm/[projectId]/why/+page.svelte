<!-- i18n-section: farm.why -->
<script lang="ts">
	// "Why about 83 %?" (docs/design/farmer-view.md §5, §6.4, board 4): the
	// model's look back in three steps a farmer can check by hand. Each step is
	// a section with an h2, so a screen-reader user can jump by heading.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { localIsoDate } from '$lib/format/number';
	import DatesLine from '$lib/components/farm/DatesLine.svelte';
	import EstimateNote from '$lib/components/farm/EstimateNote.svelte';
	import FarmPage from '$lib/components/farm/FarmPage.svelte';
	import Rich from '$lib/i18n/Rich.svelte';
	import { datesLine } from '$lib/components/farm/cards';
	import { FarmState } from '$lib/components/farm/farmState.svelte';
	import { farmHref } from '$lib/components/farm/load';
	import { step1, step2, step3, whatThisIsNot, whyIntro, whyTitle, wuaDecided } from '$lib/components/farm/why';
	import { t } from '$lib/i18n/locale.svelte';

	const projectId = $derived(page.params.projectId ?? '');
	const asked = $derived(page.url.searchParams.get('node'));
	const farm = new FarmState(api, () => session.user?.id ?? null);
	const today = localIsoDate();
	const main = $derived(farmHref(base, projectId, farm.nodeId, !!asked));
</script>

<svelte:head><title>{t('{page} · My farm', { page: farm.view ? whyTitle(farm.view.farm) : t('Why?') })}</title></svelte:head>

<FarmPage {farm} {projectId} {asked} back={{ href: main, label: t('My farm') }}>
	{#snippet children(view)}
		{@const s1 = step1(view.farm)}
		{@const s2 = step2(view.farm)}
		{@const s3 = step3(view.farm)}
		<div class="intro">
			<h1>{whyTitle(view.farm)}</h1>
			<div><p class="sub">{view.farm.name}</p><DatesLine line={datesLine(view, today)} /></div>
			<p>{whyIntro(view.farm)}</p>
		</div>
		<EstimateNote />

		<section class="card" aria-labelledby="s1-h">
			<h2 id="s1-h">{t('1. Was water shared fairly?')}</h2>
			{#if s1.shown}
				<p><Rich text={s1.catchment} /></p>
				<div class="share" aria-hidden="true">
					<div class="track"><span style:width="{s1.youPct}%"></span></div>
					<div class="marker" style:left="{s1.sharePct}%"></div>
					<div class="labels"><span>{s1.youLabel}</span><span>{s1.shareLabel}</span></div>
				</div>
				<p><Rich text={s1.you} /></p>
				<p class="check"><Rich text={s1.check} /></p>
			{:else}
				<p>{s1.text}</p>
			{/if}
		</section>

		<section class="card" aria-labelledby="s2-h">
			<h2 id="s2-h">{t('2. Did the river keep flowing?')}</h2>
			<p><Rich text={s2.intro} /></p>
			<p><Rich text={s2.sites} />{#if s2.reason}{' '}{s2.reason}{/if}</p>
			{#if s2.rule}<p>{s2.rule}</p>{/if}
			<p>{s2.asked}</p>
			{#if s2.pump || s2.dam}
				<ul class="asks">
					{#if s2.pump}
						<li>
							<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 C12 3 6 10 6 14 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z" /><path d="M9 14 H15" /></svg>
							<span><Rich text={s2.pump} /></span>
						</li>
					{/if}
					{#if s2.dam}
						<li>
							<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8 H21" /><path d="M6 8 V20 H18 V8" /><path d="M9 12 L12 15 L15 12" /></svg>
							<span><Rich text={s2.dam} /></span>
						</li>
					{/if}
				</ul>
			{/if}
			{#if s2.beyondShare}<p class="check">{s2.beyondShare}</p>{/if}
		</section>

		{#if s3}
			<section class="card" aria-labelledby="s3-h">
				<h2 id="s3-h">{s3.heading}</h2>
				<p class="fine">{s3.caption}</p>
				<dl class="sum">
					{#each s3.rows as r (r.label)}
						<div><dt>{r.label}</dt><dd>{r.value}</dd></div>
					{/each}
				</dl>
				<p><Rich text={s3.sum} /></p>
				{#if s3.damNote}<p class="fine">{s3.damNote}</p>{/if}
			</section>
		{/if}

		<section class="card" aria-labelledby="s4-h">
			<h2 id="s4-h">{t('What the WUA decided')}</h2>
			<p><Rich text={wuaDecided(view)} /></p>
			<a class="link" href="{main}#notice">{t('Read the notice')}</a>
		</section>

		<section class="card" aria-labelledby="s5-h">
			<h2 id="s5-h">{t('What this is not')}</h2>
			<ul class="not">
				{#each whatThisIsNot(view.farm) as line (line)}<li>{line}</li>{/each}
			</ul>
			<a class="link" href="{base}/farm/words#farm-reserve">{t('What is the river’s reserve?')}</a>
		</section>
	{/snippet}
</FarmPage>

<style>
	.intro {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.share {
		position: relative;
		padding-bottom: 22px;
	}
	.track {
		height: 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
		overflow: hidden;
	}
	.track span {
		display: block;
		height: 100%;
		background: var(--series-1);
	}
	.marker {
		position: absolute;
		top: -3px;
		width: 2px;
		height: 18px;
		background: var(--text);
	}
	.labels {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		margin-top: 6px;
		font-size: 13px;
		color: var(--text-2);
	}
	.check {
		padding: 10px 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
	}
	.asks {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.asks li {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}
	.asks svg {
		flex-shrink: 0;
	}
	.sum {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-variant-numeric: tabular-nums;
	}
	.sum div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		border-bottom: 1px solid var(--border);
		padding: 4px 0;
	}
	.sum dt {
		color: var(--text-2);
	}
	.sum dd {
		margin: 0;
		text-align: right;
		white-space: nowrap;
	}
	.not {
		margin: 0;
		padding-left: 20px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
