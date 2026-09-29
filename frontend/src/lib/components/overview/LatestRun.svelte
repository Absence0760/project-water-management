<script lang="ts">
	// Summary → the newest run's KPI row (issue #17 A1): the Reserve, irrigation
	// supplied, Dams today and the calibration NSE, each with its change from
	// the run before (Dams: over the run's last 30 days, and the card opens the
	// Dams page); overview/latestRun.ts has the rules. The mean simulated outflow
	// is the line under the cards, a short mention: its change and the rest of the
	// river are on River & reserve.
	// Only this section waits for the run's summary; the rest of the tab
	// renders at once. Which run it is (label, period, engine, age, a link to
	// it) is the section header's context line (OverviewTab, RunContext).
	import type { Run, RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { runHref } from './attention';
	import { riverHref } from '$lib/components/river/links';
	import { dataEndOf } from '$lib/format/age';
	import { localIsoDate } from '$lib/format/number';
	import { damsEnd, damsHeadline, headlines, historyDays, ranAgo, type DamsState } from './latestRun';

	let {
		meta,
		run,
		previousMeta,
		previous,
		evidence,
		loading,
		error,
		previousError,
		retry,
		dams
	}: {
		/** The run shown (from the page's list). */
		meta: RunMeta;
		/** Its full record (summary), once loaded. */
		run: Run | null;
		/** The run before it, if any. */
		previousMeta: RunMeta | null;
		previous: Run | null;
		/** The nominated evidence run when it isn't the one shown. */
		evidence: RunMeta | null;
		loading: boolean;
		error: string | null;
		/** The previous run couldn't be loaded: the cards show without changes. */
		previousError: string | null;
		retry: () => void;
		/** All dams at the end of the run (their series load after the summary). */
		dams: DamsState;
	} = $props();

	const all = $derived(run ? headlines(run.summary, historyDays(run), previous?.summary ?? null) : []);
	// Reserve · Irrigation supplied · Dams today ("Dams on <date>" once the dams' last day is stale) · NSE; the outflow goes under them.
	const cards = $derived(all.length ? [...all.filter((h) => h.id !== 'nse' && h.id !== 'outflow'), damsHeadline(dams, dataEndOf(damsEnd(dams, meta), localIsoDate())), ...all.filter((h) => h.id === 'nse')] : []);
	const outflow = $derived(all.find((h) => h.id === 'outflow') ?? null);
	const name = (r: RunMeta) => r.label || 'Untitled run';
</script>

<section class="latest" aria-label="Latest run" aria-busy={loading}>
	{#if meta.legacy}
		<p class="alert alert-warning" role="note">
			This run used the legacy runoff model of the b023 workbook, which does not conserve water at the event scale. Its
			figures are for comparison with the workbook only, not evidence. Engine 1.0.0 removed that model, so the run can’t be
			re-run: a new run uses GR4J.
		</p>
	{/if}
	{#if evidence}
		<p class="muted small">
			The nominated evidence run is an older one: <a href={runHref(evidence.id)}>{name(evidence)}</a>, ran
			{ranAgo(evidence.createdAt)}.
		</p>
	{/if}
	<LoadState loading={loading && !run} error={run ? null : error} {retry}>
		<dl class="stats">
			{#each cards as h (h.id)}
				<div class="stat" class:flagged={h.flagged} class:linked={!!h.href} data-headline={h.id}>
					<dt>{#if h.href}<a href={h.href}>{h.term}</a>{:else}{h.term}{/if}{#if h.help} <HelpTip key={h.help} />{/if}</dt>
					<dd class="value" class:none={h.value === '–' || h.value === '…'}>{h.value}{#if h.unit}<small>{h.unit}</small>{/if}</dd>
					{#each h.sub as line, i (i)}<dd class="sub">{line}</dd>{/each}
					{#if h.delta}<dd class="sub change"><Delta m={h.delta} spec={h.spec} /> {h.deltaLabel ?? 'vs previous run'}</dd>{/if}
				</div>
			{/each}
		</dl>
		<p class="muted small after">
			{#if outflow}
				<span data-headline="outflow"
					>Mean simulated outflow <strong class="v">{outflow.value} {outflow.unit}</strong>{#if outflow.sub.length}{' '}({outflow.sub.join(', ')}){/if}: its change and the reserve in detail are on <a href={riverHref(meta.id)}>River &amp; reserve</a>.</span
				>
			{/if}
			{#if previousMeta}
				{#if previousError}
					The previous run couldn’t be loaded ({previousError}), so no changes are shown.
				{:else}
					Changes are against the previous run, <a href={runHref(previousMeta.id)}>{name(previousMeta)}</a>{#if previousMeta.legacy}
						(workbook comparison){/if}.
				{/if}
			{/if}
		</p>
	</LoadState>
</section>

<style>
	.latest {
		margin: 0;
	}
/* Four cards: one row, then 2 × 2 on narrow screens. */
	.stats {
		grid-template-columns: repeat(4, minmax(0, 1fr));
		margin-bottom: 0.4rem;
	}
	@media (max-width: 760px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.stat dt {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat {
		padding: 0.75rem 0.95rem;
	}
	.stat dd.value {
		font-size: 1.6rem;
		line-height: 1.2;
		margin: 0.1rem 0;
	}
	.stat dd.sub {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.stat dd.none {
		color: var(--text-muted);
	}
	/* A card with a page behind it (Dams today → Dams): the term's link is stretched over the card, as the model facts'. */
	.stat.linked {
		position: relative;
	}
	.stat.linked:hover {
		border-color: var(--accent);
	}
	.stat.linked:has(dt a:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.stat dt a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	.stat dt a:focus-visible {
		outline: none;
	}
	.stat dt a::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.stat.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	.after {
		margin: 0;
	}
	.after .v {
		color: var(--text);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
