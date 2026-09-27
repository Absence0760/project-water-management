<script lang="ts">
	// Summary → the newest run's KPI row (issue #17 A1): the Reserve, irrigation
	// supplied, Dams today and the calibration NSE, each with its change from
	// the run before (Dams: over the run's last 30 days); overview/latestRun.ts
	// has the rules. The mean simulated outflow is the line under the cards, a
	// short mention: its change and the rest of the river are on River & reserve.
	// Only this section waits for the run's summary; the rest of the tab
	// renders at once.
	import type { Run, RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtDay } from '$lib/format/number';
	import { runHref } from './attention';
	import { riverHref } from '$lib/components/river/links';
	import { damsHeadline, headlines, ranAgo, runDays, type DamsState } from './latestRun';

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
		/** The run shown (from the page's list, so the context line is there on the first frame). */
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

	const all = $derived(run ? headlines(run.summary, runDays(run), previous?.summary ?? null) : []);
	// Reserve · Irrigation supplied · Dams today · NSE; the outflow goes under them.
	const cards = $derived(all.length ? [...all.filter((h) => h.id !== 'nse' && h.id !== 'outflow'), damsHeadline(dams), ...all.filter((h) => h.id === 'nse')] : []);
	const outflow = $derived(all.find((h) => h.id === 'outflow') ?? null);
	const name = (r: RunMeta) => r.label || 'Untitled run';
	const LEGACY_TITLE =
		'Legacy runoff model (b023 workbook): does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence.';
</script>

<section class="latest" aria-labelledby="latest-h" aria-busy={loading}>
	<div class="head">
		<h2 id="latest-h">Latest run</h2>
		<a href={runHref(meta.id)}>Open in Runs</a>
	</div>
	<p class="context muted">
		<strong class="lbl">{name(meta)}</strong>
		{#if meta.legacy}<span class="badge badge-warn" title={LEGACY_TITLE}>Workbook comparison</span>{/if}
		{#if meta.evidence === 'current'}<span class="badge badge-owner">Evidence</span>{/if}
		<span>· {fmtDay(meta.startDate)} – {fmtDay(meta.endDate)}</span>
		<span>· engine {meta.engineVersion}</span>
		<span>· ran {ranAgo(meta.createdAt)}</span>
	</p>
	{#if meta.legacy}
		<p class="alert alert-warning" role="note">
			This run used the legacy runoff model of the b023 workbook, which does not conserve water at the event scale. Its
			figures are for comparison with the workbook only, not evidence.
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
				<div class="stat" class:flagged={h.flagged} data-headline={h.id}>
					<dt>{h.term}{#if h.help} <HelpTip key={h.help} />{/if}</dt>
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
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.head h2 {
		margin: 0;
	}
	.context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.4rem;
		margin: 0.25rem 0 0.6rem;
		font-size: 0.85rem;
	}
	.context .lbl {
		color: var(--text);
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
