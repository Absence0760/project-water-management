<script lang="ts">
	// Headline numbers and calibration fit of one run. The per-unit table moved to
	// Hydrological units (supply/UnitResultsTable.svelte, issue #17), and so did the
	// land-cover, groundwater, demand-object and other-user tables (issue #137,
	// its Other uses section); the printable report passes them back in through
	// `units`, in their old place.
	import type { Snippet } from 'svelte';
	import type { RunSummary } from '@water-management/engine';
	import type { EwrHeadline } from '#lib/api/types.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import WithheldUnitsNote from './WithheldUnitsNote.svelte';
	import { fmtNum, fmtPct, fmtQty } from '#lib/format/number.js';
	import { m3DayToM3s, m3DayToMm3a, outletEwrLine, SUPPLY_TARGET } from './results';
	import { runSentence } from './runSentence';
	import { headlineSite } from './ewrAssurance';
	import { credibility, warningGroups } from './credibility';
	import { otherUsesLink } from './humanImpacts';
	import { calibrationSample } from '#lib/components/calibration/sample.js';
	import { volumeBiasText, worseThanMean, WORSE_THAN_MEAN } from '#lib/components/calibration/metrics.js';

	let {
		summary,
		days,
		units,
		reserveHref = '#res-reserve',
		otherUsesHref,
		headline = null,
		foldChecks = false,
		calibrationHref
	}: {
		summary: RunSummary;
		/** Days in the run (for "% of days"). */
		days: number;
		/** Drawn after the catchment cards: the printable report's unit table. */
		units?: Snippet;
		/** Where "by month of the year" goes: the Reserve compliance panel, on EWR in the workspace (issue #17). */
		reserveHref?: string;
		/** A link to a panel of Hydrological units by its anchor: where the land-cover, groundwater, demand-object and other-user tables are in the workspace (issue #137). */
		otherUsesHref?: (hash: string) => string;
		/** The project's settings.ewrHeadline (issue #444): which test the headline reports; null = automatic. */
		headline?: EwrHeadline | null;
		/**
		 * Show the first CHECKS_SHOWN things to check and a "Show all N" button, so the
		 * results reach the first screen (the workspace; issue #521). The report lists them all.
		 */
		foldChecks?: boolean;
		/**
		 * A link to a Model quality panel on the Calibration page by its anchor, for this run (calibration/links.ts):
		 * where the model-checks line's calibration, plausibility and WR2012 items go (issue #586 Round 3).
		 */
		calibrationHref?: (anchor: string) => string;
	} = $props();

	const CHECKS_SHOWN = 3;
	const uid = $props.id();
	let checksOpen = $state(false);

	const farms = $derived(summary.farms ?? []);
	const shortCount = $derived(farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length);
	const totals = $derived({
		demand: farms.reduce((s, f) => s + f.avgDemandM3Day, 0),
		supplied: farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0)
	});
	const cal = $derived(summary.calibration);
	// "in-sample" only when the parameters were fitted on the days scored (issue #45).
	const sample = $derived(calibrationSample(cal));
	// Toned and worded as the Calibration panel's tiles are (#586 D12): NSE no better than the mean flow is flagged,
	// and the volume bias reads "12.3% too wet", the panel's words, not a signed PBIAS.
	const nseFlag = $derived(worseThanMean('nse', cal?.nse));
	// Reserve compliance by month (engine ≥ 0.21.0): the headline when the project judges by a rule table.
	const reserve = $derived(headlineSite(summary, headline));
	const c = $derived(summary.catchment);
	// The cards below in one or two plain sentences (runs/runSentence.ts).
	const lede = $derived(runSentence(summary, headline));
	const groups = $derived(warningGroups(summary.warnings));
	const checksFolded = $derived(foldChecks && groups.check.length > CHECKS_SHOWN);
	const shownChecks = $derived(checksFolded && !checksOpen ? groups.check.slice(0, CHECKS_SHOWN) : groups.check);
	const checkItems = $derived(credibility(summary, calibrationHref));
	const otherUses = $derived(otherUsesHref ? otherUsesLink(summary) : null);
</script>

<!-- A cap or full-allocation run's units bound to a volume this reader can't see: left out, and said (issue #523 I). -->
<WithheldUnitsNote {summary} />
<!-- What to check before relying on the run, then how its data were handled (runs/credibility.ts). -->
{#if groups.check.length}
	<div class="alert alert-warning" role="status" data-testid="warnings-check">
		<strong>{groups.check.length === 1 ? '1 thing' : `${groups.check.length} things`} to check before relying on this run</strong>
		<ul id="{uid}-checks">{#each shownChecks as w, i (i)}<li>{w}</li>{/each}</ul>
		{#if checksFolded}
			<button type="button" class="checks-toggle" aria-expanded={checksOpen} aria-controls="{uid}-checks" onclick={() => (checksOpen = !checksOpen)}
				>{checksOpen ? 'Show only the first 3 things to check' : `Show all ${groups.check.length} things to check`}</button
			>
		{/if}
	</div>
{/if}
{#if groups.data.length}
	<details class="data-notes" data-testid="warnings-data">
		<summary>{groups.data.length === 1 ? '1 note' : `${groups.data.length} notes`} on how the input data were handled</summary>
		<ul>{#each groups.data as w, i (i)}<li>{w}</li>{/each}</ul>
	</details>
{/if}
<ul class="cred" aria-label="Model checks" data-testid="credibility">
	{#each checkItems as c (c.label)}
		<li class="tone-{c.tone}"><a href={c.href}><strong>{c.label}</strong> {c.text}</a></li>
	{/each}
</ul>

<p class="lede">{lede}</p>

<h3>Catchment</h3>
<dl class="stats">
	<div class="stat">
		<dt>Mean natural flow <HelpTip key="catchment.meanNaturalFlowM3Day" /></dt>
		<dd>{fmtQty(m3DayToM3s(c.meanNaturalFlowM3Day), 3)}<small>m³/s</small></dd>
		<dd class="sub">{fmtQty(m3DayToMm3a(c.meanNaturalFlowM3Day), 2)} Mm³/a · {fmtNum(c.meanNaturalFlowM3Day)} m³/day</dd>
	</div>
	<div class="stat">
		<dt>Mean simulated outflow</dt>
		<dd>{fmtQty(m3DayToM3s(c.meanSimulatedOutflowM3Day), 3)}<small>m³/s</small></dd>
		<dd class="sub">
			{fmtQty(m3DayToMm3a(c.meanSimulatedOutflowM3Day), 2)} Mm³/a{#if c.meanNaturalFlowM3Day > 0}{' '}·
				{fmtPct(c.meanSimulatedOutflowM3Day / c.meanNaturalFlowM3Day, 0)} of natural{/if}
		</dd>
	</div>
	{#if reserve}
		<div class="stat" class:flagged={reserve.overall.rate !== null && reserve.overall.rate < 1}>
			<dt>Reserve rules met <HelpTip key="reserve-compliance" /></dt>
			<dd>{reserve.overall.rate === null ? '–' : fmtPct(reserve.overall.rate)}<small>of months</small></dd>
			<dd class="sub">
				{fmtNum(reserve.overall.met)} of {fmtNum(reserve.overall.months)} months at {reserve.isOutlet ? 'the outlet' : reserve.name}{#if reserve.overall.longestNotMetRun > 1}{' '}·
					up to {fmtNum(reserve.overall.longestNotMetRun)} in a row not met{/if}
			</dd>
			<dd class="sub"><a href={reserveHref}>by month of the year</a></dd>
		</div>
	{/if}
	<div class="stat" class:flagged={c.ewrFractionDaysNotMet > 0.05}>
		<dt>{reserve ? `Days below ${c.outletEwr ? 'the daily EWR' : 'the pragmatic EWR'}` : 'EWR not met'} <HelpTip key="catchment.ewrFractionDaysNotMet" /></dt>
		<dd>{fmtPct(c.ewrFractionDaysNotMet)}<small>of days</small></dd>
		<dd class="sub">{fmtNum(c.ewrDaysNotMet)} of {fmtNum(days)} days at the outflow gauge</dd>
		<!-- Which EWR the run was judged by (engine ≥ 1.77.0, settings.ewrDailySource); absent = the pragmatic EWR. -->
		<dd class="sub" data-testid="outlet-ewr-source">{outletEwrLine(c.outletEwr)}</dd>
	</div>
	<div class="stat" class:flagged={shortCount > 0}>
		<dt>Irrigation supplied <HelpTip key="summary.fractionSupplied" /></dt>
		<dd>{totals.demand > 0 ? fmtPct(totals.supplied / totals.demand) : '–'}<small>of demand</small></dd>
		<dd class="sub">
			{shortCount ? `${shortCount} of ${farms.length} hydrological units below ${fmtPct(SUPPLY_TARGET, 0)}` : `all hydrological units ≥ ${fmtPct(SUPPLY_TARGET, 0)}`}
		</dd>
		<dd class="sub">over the whole record</dd>
	</div>
	{#if cal && cal.days > 0}
		<div class="stat" class:flagged={nseFlag}>
			<dt><span>Calibration NSE</span> <HelpTip key="stats.nse" /></dt>
			<dd>{fmtNum(cal.nse, 2)}</dd>
			{#if nseFlag}<dd class="sub flag">{WORSE_THAN_MEAN}</dd>{/if}
			<dd class="sub">{fmtNum(cal.days)} days observed{#if cal.siteName} at {cal.siteName}{/if}</dd>
			<dd class="sub">{sample.short}</dd>
		</div>
		<div class="stat">
			<dt><span>Calibration volume bias</span> <HelpTip key="stats.pbias" /></dt>
			<!-- PBIAS is 100 × Σ(obs − sim)/Σobs, the volume error's negative (calibration/metrics.ts volumeBiasText). -->
			<dd>{volumeBiasText(cal.pbias == null ? null : -cal.pbias)}</dd>
			<dd class="sub">{sample.short}</dd>
		</div>
	{:else}
		<div class="stat">
			<dt>Calibration</dt>
			<dd class="none">–</dd>
			<dd class="sub">no observed flow in the run</dd>
		</div>
	{/if}
</dl>

{#if units}{@render units()}{/if}

{#if otherUses && otherUsesHref}
	<p class="muted small other-uses" data-testid="other-uses-link">
		{otherUses.what}: <a href={otherUsesHref(otherUses.hash)}>{otherUses.where}</a>.
	</p>
{/if}

<style>
	/* A link-like button in the alert's own text colour (its contrast is the alert's), a 24 px target (WCAG 2.5.8). */
	.checks-toggle {
		all: unset;
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		margin-top: 0.15rem;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.checks-toggle:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.other-uses {
		margin: 1rem 0 0;
	}
	.data-notes {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.data-notes summary {
		cursor: pointer;
	}
	.data-notes ul {
		margin: 0.35rem 0 0;
	}
	.cred {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 1rem;
		font-size: 0.85rem;
	}
	/* The tone is in the words too (passed, failed, found something); the edge only repeats it. */
	.cred li {
		border-left: 3px solid var(--border);
		padding-left: 0.4rem;
	}
	/* ≥ 24px tall: a touch target (WCAG 2.2), and the lines wrap on a phone. */
	.cred a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 24px;
		color: var(--text-2);
		text-decoration: none;
	}
	.cred a:hover {
		text-decoration: underline;
	}
	.cred .tone-ok {
		border-left-color: var(--success);
	}
	.cred .tone-warn {
		border-left-color: var(--warning);
	}
	.cred .tone-bad {
		border-left-color: var(--danger);
	}
	.lede {
		margin: 0 0 0.9rem;
		max-width: 72ch;
		color: var(--text-2);
		font-size: 1rem;
		line-height: 1.55;
	}
	h3 {
		margin-top: 1.1rem;
	}
	h3:first-of-type {
		margin-top: 0;
	}
	/* Six headline cards: 3 + 3 on a desktop results column, 2 + … on phones. */
	.stats {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
	}
	@media (max-width: 640px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.5rem;
		}
	}
	.stat dd.sub {
		font-size: var(--font-xs);
		font-weight: 400;
		color: var(--text-muted);
		margin-top: 0.15rem;
	}
	.stat.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	.stat dt {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat dd.sub.flag {
		color: var(--warning);
		font-weight: 600;
	}
	.stat dd.none {
		color: var(--text-muted);
	}
</style>
