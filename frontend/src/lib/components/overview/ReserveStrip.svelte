<script lang="ts">
	import type { DailyEwrSource } from '$lib/components/ewr/notMet';
	// Summary → the reserve at a glance (issue #162, item 10): the days below
	// the pragmatic EWR at the outlet in each of the run's last twelve months
	// (reserveStrip.ts), a small bar and its count per month, and a link to
	// River & reserve, which has the flow chart itself. Built from the run
	// summary's monthly grid, so it draws with the KPI cards (no series to
	// fetch, no chart library). The count is always written, so the bar's
	// height is never the only cue. Beside a rule table it is headed by the
	// test it counts, the pragmatic EWR, since the headline card's Reserve is
	// the table's (reserveStrip.ts stripWords, issue #177).
	import type { EwrCompliance } from '@water-management/engine';
	import { bandLabels, EWR_BANDS } from '$lib/components/ewr/bands';
	import { monthText, recentMonths, stripSpan, stripWhat, stripWords } from './reserveStrip';

	let {
		compliance,
		forecastFrom = null,
		ruleTable = false,
		daily = null,
		more
	}: {
		/** The run summary's monthly grid; absent on a run older than it. */
		compliance: EwrCompliance | null | undefined;
		/** A forecast run's first forecast day: the strip stops before its month. */
		forecastFrom?: string | null;
		/** The headline card judges the Reserve by a rule table (ewrAssurance.ts headlineSite). */
		ruleTable?: boolean;
		/** The run's daily outlet EWR source (summary.catchment.outletEwr, engine ≥ 1.77.0); absent = the pragmatic EWR. */
		daily?: DailyEwrSource;
		/** River & reserve, for the same run. */
		more: { href: string; label: string };
	} = $props();

	const months = $derived(compliance ? recentMonths(compliance, forecastFrom) : []);
	const span = $derived(stripSpan(months));
	const words = $derived(stripWords(ruleTable, daily));
	// The key names what the strip counts: days below the EWR, or the pragmatic EWR beside a rule table.
	const bands = $derived(bandLabels(undefined, `days below ${words.test}`));
</script>

<section class="panel strip" aria-labelledby="strip-h" data-testid="reserve-strip">
	<div class="head">
		<h2 id="strip-h">{words.heading}</h2>
		<a class="small" href={more.href}>{more.label}</a>
	</div>
	{#if !compliance}
		<p class="muted small">This run was made before the monthly EWR record existed. Run the model again to see it by month.</p>
	{:else if !months.length}
		<p class="muted small">The run has no whole month before its forecast to show.</p>
	{:else}
		<p class="what" data-testid="reserve-strip-what">{stripWhat(months, words)}</p>
		<ol class="months" aria-label="{words.list}, {span}">
			{#each months as x, i (`${x.year}-${x.month}`)}
				<li data-month="{x.year}-{String(x.month).padStart(2, '0')}" data-not-met={x.notMet} data-band={x.band} title={monthText(x, words.test)}>
					<span class="visually-hidden">{monthText(x, words.test)}</span>
					<span class="n" class:zero={x.notMet === 0} aria-hidden="true">{x.notMet}</span>
					<span class="track" aria-hidden="true"><span class="fill {x.band}" style:height="{Math.round(x.fraction * 100)}%"></span></span>
					<span class="m" aria-hidden="true">{x.label}</span>
					<span class="y" aria-hidden="true">{i === 0 || x.month === 1 ? x.year : ''}</span>
				</li>
			{/each}
		</ol>
		<!-- A line of text, not a list: the strip's one list is its months. -->
		<p class="key" data-testid="reserve-strip-key">
			<span class="visually-hidden">Bar colours:</span>
			{#each EWR_BANDS as b (b)}<span class="item"><span class="swatch {b}" aria-hidden="true"></span>{bands[b]}</span>{/each}
		</p>
	{/if}
</section>

<style>
	.strip {
		margin: 0;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.25rem;
	}
	/* A 24 px target (WCAG 2.5.8). */
	.head a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.what {
		margin: 0 0 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.months {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 0.3rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.months li {
		display: flex;
		flex-direction: column;
		align-items: center;
		min-width: 0;
		font-size: 0.75rem;
		line-height: 1.2;
	}
	.n {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.n.zero {
		font-weight: 400;
		color: var(--text-muted);
	}
	/* The bar's height is the share of the month's days below the EWR. */
	.track {
		position: relative;
		width: min(100%, 1.6rem);
		height: 2.5rem;
		margin: 0.15rem 0;
		border-radius: 3px;
		background: var(--surface-2);
		box-shadow: inset 0 -1px 0 var(--chart-axis);
		overflow: hidden;
	}
	.fill {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
	}
	/* The traffic light's tokens: each ≥ 5:1 on the track (--surface-2) in both themes. */
	.green {
		background: var(--success);
	}
	.amber {
		background: var(--warning);
	}
	.red {
		background: var(--danger);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.key .item {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.swatch {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 2px;
	}
	.m {
		color: var(--text-2);
	}
	.y {
		min-height: 1.2em;
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	/* A phone: two rows of six. */
	@media (max-width: 520px) {
		.months {
			grid-template-columns: repeat(6, minmax(0, 1fr));
			row-gap: 0.6rem;
		}
	}
	@media (forced-colors: active) {
		.fill,
		.swatch {
			background: CanvasText;
		}
	}
</style>
