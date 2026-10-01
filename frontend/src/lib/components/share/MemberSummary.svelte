<!-- i18n-section: share.summary -->
<script lang="ts">
	// The member summary on paper (issue #118, docs/ui.md § Share page): the
	// share page's catchment view over the chosen period, laid out for one or
	// two sheets of A4. It shows only in print (the page hides everything else
	// there, and this on screen), so the browser's Print or Save as PDF makes
	// it. Its words are summary.ts's and the page's own; never the link, which
	// is the credential.
	import type { ShareView } from '$lib/api/types';
	import { CHART_FONT_PX, LABEL_Y } from '$lib/components/farm/chartGeometry';
	import type { NoticeVm } from '$lib/components/farm/notice';
	import { t } from '$lib/i18n/locale.svelte';
	import { flowCaption, flowChart, flowVerdict, type FlowMonth } from './chart';
	import { farmsLine, publishedLine, shareCaveat } from './share';
	import { printedLine, summaryMonths, summaryRows, windowLine, type SummaryWindow } from './summary';

	let {
		view,
		notice,
		months,
		chartFailed,
		period: w,
		today,
		pageLang
	}: { view: ShareView; notice: NoticeVm | null; months: FlowMonth[] | null; chartFailed: boolean; period: SummaryWindow; today: string; pageLang: string } = $props();

	/** The drawing's width in CSS px: A4's printable width (186 mm) is about 700, so its words print near their screen size. */
	const PAPER_WIDTH = 680;
	const cv = $derived(view.publication.catchmentView);
	const shown = $derived(months ? summaryMonths(months, cv, w) : []);
	const chart = $derived(shown.length ? flowChart(shown, PAPER_WIDTH) : null);
	const noticeLang = $derived(notice?.lang && notice.lang !== pageLang ? notice.lang : undefined);
</script>

<article class="paper" data-testid="member-summary" data-window={w}>
	<header class="p-head">
		<p class="brand">Water Management · {t('Member summary')}</p>
		<h1>{view.project.name}</h1>
		<p class="period">{windowLine(cv, w)}</p>
		<p class="fine">{publishedLine(view)} {printedLine(today)}</p>
		<p class="caveat">{shareCaveat()}</p>
	</header>

	<section class="block notice {notice?.level ?? 'none'}">
		{#if notice}
			{#if notice.label}<p class="label">{notice.label}</p>{/if}
			<h2 lang={notice.label ? noticeLang : undefined}>{notice.heading}</h2>
			{#if notice.body}
				{#each notice.body.split('\n') as para, i (i)}<p lang={noticeLang}>{para}</p>{/each}
			{/if}
			{#if notice.langNote}<p class="fine">{notice.langNote}</p>{/if}
			{#if notice.pctLine}<p>{notice.pctLine}</p>{/if}
			<p class="fine">{notice.byline}</p>
		{:else}
			<h2>{t('No restriction from the WUA')}</h2>
		{/if}
	</section>

	<section class="block">
		<h2>{t('The river’s ecological reserve')}</h2>
		<ul class="sites">
			{#each summaryRows(cv, w) as row, i (i)}
				<li class={row.state}>
					<span class="mark" aria-hidden="true">{row.state === 'met' ? '✓' : '!'}</span>
					<span><strong>{row.place}</strong> {row.line}</span>
				</li>
			{/each}
		</ul>
	</section>

	<section class="block chart">
		<h2>{t('River flow each month, in m³ a day')}</h2>
		{#if chart}
			<div class="legend" aria-hidden="true">
				<span><span class="key flow"></span>{t('Flow at the outlet')}</span>
				<span><span class="key ewr"></span>{t('Ecological reserve')}</span>
			</div>
			<svg viewBox="0 0 {chart.width} {chart.height}" aria-hidden="true" font-size={CHART_FONT_PX}>
				{#each chart.ticks as tk, i (i)}
					<line x1={chart.axisLeft} x2={chart.width} y1={tk.y} y2={tk.y} class={i === chart.ticks.length - 1 ? 'axis' : 'grid'} />
					<text x="0" y={tk.y + 5} class="tick">{tk.label}</text>
				{/each}
				{#each chart.ewr as pts, i (i)}<polyline points={pts} class="ewr" />{/each}
				{#each chart.flow as pts, i (i)}<polyline points={pts} class="flow" />{/each}
				{#each chart.labels as l, i (i)}
					<text x={l.x} y={LABEL_Y} text-anchor="middle" class="tick">{l.label}</text>
				{/each}
			</svg>
			<p class="fine">{flowCaption(shown)} {flowVerdict(shown)}</p>
		{:else}
			<p class="fine">{chartFailed ? t('Couldn’t load the flow chart just now.') : t('The flow chart isn’t shown for this catchment: with so few hydrological units, the river’s flows could reveal a hydrological unit’s water use.')}</p>
		{/if}
	</section>

	<footer class="block about">
		<p>{t('This is the catchment’s published result from its water balance model: whether the river kept its ecological reserve (the flow it needs to stay healthy) and the Water User Association’s notice. It is read-only, and it shows no hydrological unit’s figures.')}</p>
		<p>{farmsLine(cv)}</p>
		<p class="fine">{t('It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.')}</p>
	</footer>
</article>

<style>
	/* Paper only: the page shows its own screen layout, and hides the rest in print. */
	.paper {
		display: none;
	}
	@media print {
		.paper {
			display: flex;
		}
	}
	.paper {
		color: #000;
		background: #fff;
		font-size: 10.5pt;
		line-height: 1.35;
		flex-direction: column;
		gap: 10pt;
		print-color-adjust: exact;
		-webkit-print-color-adjust: exact;
	}
	.paper :global(p) {
		margin: 0;
	}
	.paper h1 {
		margin: 2pt 0 0;
		font-family: var(--font-display);
		font-size: 20pt;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}
	.paper h2 {
		margin: 0 0 4pt;
		font-size: 12.5pt;
		line-height: 1.25;
		break-after: avoid;
	}
	.paper .brand {
		font-size: 9pt;
		color: #444;
	}
	.paper .period {
		font-weight: 600;
		font-size: 12pt;
	}
	.paper .fine {
		font-size: 9pt;
		color: #444;
	}
	.paper .caveat {
		margin-top: 4pt;
		font-size: 9.5pt;
	}
	.paper .p-head {
		display: flex;
		flex-direction: column;
		gap: 2pt;
		padding-bottom: 8pt;
		border-bottom: 1px solid #999;
	}
	.paper .block {
		display: flex;
		flex-direction: column;
		gap: 3pt;
		break-inside: avoid;
	}
	/* The notice keeps the page's fills, lighter on paper; the level is in its words too. */
	.paper .notice {
		padding: 8pt 10pt;
		border: 1px solid #999;
		border-radius: 4px;
	}
	.paper .notice.advisory {
		background: #fdf3dc;
		border-color: #b07a10;
	}
	.paper .notice.restricted {
		background: #fbe3e0;
		border-color: #b3261e;
	}
	.paper .notice .label {
		font-size: 9pt;
		font-weight: 600;
	}
	.paper .sites {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4pt;
	}
	.paper .sites li {
		display: flex;
		gap: 6pt;
		break-inside: avoid;
	}
	.paper .mark {
		flex: 0 0 12pt;
		font-weight: 700;
		text-align: center;
	}
	.paper .met .mark {
		color: #1b6e35;
	}
	.paper .partly .mark {
		color: #8a5a00;
	}
	.paper .missed .mark {
		color: #b3261e;
	}
	.paper .legend {
		display: flex;
		gap: 12pt;
		font-size: 9pt;
	}
	.paper .legend > span {
		display: inline-flex;
		align-items: center;
		gap: 4pt;
	}
	.paper .key {
		width: 16px;
		height: 0;
		border-top: 3px solid #1f6fb2;
	}
	.paper .key.ewr {
		border-top: 2px dashed #555;
	}
	.paper svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.paper .grid {
		stroke: #ddd;
	}
	.paper .axis {
		stroke: #555;
	}
	.paper .tick {
		fill: #444;
	}
	.paper polyline {
		fill: none;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.paper .flow {
		stroke: #1f6fb2;
		stroke-width: 2.5;
	}
	.paper .ewr {
		stroke: #555;
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.paper .about {
		padding-top: 8pt;
		border-top: 1px solid #999;
	}
</style>
