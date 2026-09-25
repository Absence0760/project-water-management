<script lang="ts">
	// Overview → the newest run's headline figures, each with its change from
	// the run before (overview/latestRun.ts has the rules). Only this section
	// waits for the run's summary; the rest of the tab renders at once.
	import type { Run, RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import Delta from '$lib/components/compare/Delta.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtDay } from '$lib/format/number';
	import { runHref } from './attention';
	import { headlines, ranAgo, runDays } from './latestRun';

	let {
		meta,
		run,
		previousMeta,
		previous,
		evidence,
		loading,
		error,
		previousError,
		retry
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
	} = $props();

	const cards = $derived(run ? headlines(run.summary, runDays(run), previous?.summary ?? null) : []);
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
					<dd class:none={h.value === '–'}>{h.value}{#if h.unit}<small>{h.unit}</small>{/if}</dd>
					{#each h.sub as line, i (i)}<dd class="sub">{line}</dd>{/each}
					{#if h.delta}<dd class="sub change"><Delta m={h.delta} spec={h.spec} /> vs previous run</dd>{/if}
				</div>
			{/each}
		</dl>
		{#if previousMeta}
			<p class="muted small after">
				{#if previousError}
					The previous run couldn’t be loaded ({previousError}), so no changes are shown.
				{:else}
					Changes are against the previous run, <a href={runHref(previousMeta.id)}>{name(previousMeta)}</a>{#if previousMeta.legacy}
						(workbook comparison){/if}.
				{/if}
			</p>
		{/if}
	</LoadState>
</section>

<style>
	.latest {
		margin: 0 0 1rem;
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
	.small {
		font-size: 0.8rem;
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
</style>
