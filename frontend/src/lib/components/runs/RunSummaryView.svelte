<script lang="ts">
	// Headline numbers and calibration fit of one run. The per-unit table moved to
	// Units & supply (supply/UnitResultsTable.svelte, issue #17); the printable
	// report passes it back in through `units`, in its old place.
	import type { Snippet } from 'svelte';
	import type { RunSummary } from '@water-management/engine';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { describePbias, NSE_HELP, PBIAS_HELP } from './rating';
	import { m3DayToM3s, m3DayToMm3a, SUPPLY_TARGET } from './results';
	import { runSentence } from './runSentence';
	import { headlineSite } from './ewrAssurance';
	import { credibility, warningGroups } from './credibility';
	import { loadHumanImpacts } from './humanImpacts';
	import { calibrationSample } from '$lib/components/calibration/sample';

	let {
		summary,
		days,
		units,
		reserveHref = '#res-reserve'
	}: {
		summary: RunSummary;
		/** Days in the run (for "% of days"). */
		days: number;
		/** Drawn after the catchment cards: the printable report's unit table. */
		units?: Snippet;
		/** Where "by month of the year" goes: the Reserve compliance panel, on River & reserve in the workspace (issue #17). */
		reserveHref?: string;
	} = $props();

	const farms = $derived(summary.farms ?? []);
	// Farms and other users with boreholes (engine ≥ 0.23.0, WP-1.34).
	const pumping = $derived([...farms, ...(summary.users ?? [])].filter((f) => f.avgGroundwaterM3Day !== undefined));
	const shortCount = $derived(farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET).length);
	const totals = $derived({
		demand: farms.reduce((s, f) => s + f.avgDemandM3Day, 0),
		supplied: farms.reduce((s, f) => s + f.avgSuppliedM3Day, 0),
		deficit: farms.reduce((s, f) => s + f.avgDeficitM3Day, 0),
		ewr: farms.reduce((s, f) => s + f.avgEwrShortfallM3Day, 0)
	});
	const cal = $derived(summary.calibration);
	// "in-sample" only when the parameters were fitted on the days scored (issue #45).
	const sample = $derived(calibrationSample(cal));
	// Reserve compliance by month (engine ≥ 0.21.0): the headline when the project has a rule table.
	const reserve = $derived(headlineSite(summary));
	const c = $derived(summary.catchment);
	// The cards below in one or two plain sentences (runs/runSentence.ts).
	const lede = $derived(runSentence(summary));
	const groups = $derived(warningGroups(summary.warnings));
	const checkItems = $derived(credibility(summary));
</script>

<!-- What to check before relying on the run, then how its data were handled (runs/credibility.ts). -->
{#if groups.check.length}
	<div class="alert alert-warning" role="status" data-testid="warnings-check">
		<strong>{groups.check.length === 1 ? '1 thing' : `${groups.check.length} things`} to check before relying on this run</strong>
		<ul>{#each groups.check as w, i (i)}<li>{w}</li>{/each}</ul>
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
			{fmtQty(m3DayToMm3a(c.meanSimulatedOutflowM3Day), 2)} Mm³/a{#if c.meanNaturalFlowM3Day > 0} ·
				{fmtPct(c.meanSimulatedOutflowM3Day / c.meanNaturalFlowM3Day, 0)} of natural{/if}
		</dd>
	</div>
	{#if reserve}
		<div class="stat" class:flagged={reserve.overall.rate !== null && reserve.overall.rate < 1}>
			<dt>Reserve rules met <HelpTip key="reserve-compliance" /></dt>
			<dd>{reserve.overall.rate === null ? '–' : fmtPct(reserve.overall.rate)}<small>of months</small></dd>
			<dd class="sub">
				{fmtNum(reserve.overall.met)} of {fmtNum(reserve.overall.months)} months at {reserve.isOutlet ? 'the outlet' : reserve.name}{#if reserve.overall.longestNotMetRun > 1}
					· up to {fmtNum(reserve.overall.longestNotMetRun)} in a row not met{/if}
			</dd>
			<dd class="sub"><a href={reserveHref}>by month of the year</a></dd>
		</div>
	{/if}
	<div class="stat" class:flagged={c.ewrFractionDaysNotMet > 0.05}>
		<dt>{reserve ? 'Days below the pragmatic EWR' : 'EWR not met'} <HelpTip key="catchment.ewrFractionDaysNotMet" /></dt>
		<dd>{fmtPct(c.ewrFractionDaysNotMet)}<small>of days</small></dd>
		<dd class="sub">{fmtNum(c.ewrDaysNotMet)} of {fmtNum(days)} days at the outflow gauge</dd>
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
		<div class="stat">
			<dt><span title={NSE_HELP}>Calibration NSE</span> <HelpTip key="stats.nse" /></dt>
			<dd>{fmtNum(cal.nse, 2)}</dd>
			<dd class="sub">{fmtNum(cal.days)} days observed</dd>
			<dd class="sub">{sample.short}</dd>
		</div>
		<div class="stat">
			<dt><span title={PBIAS_HELP}>Calibration PBIAS</span> <HelpTip key="stats.pbias" /></dt>
			<dd>{cal.pbias == null ? '–' : `${cal.pbias > 0 ? '+' : ''}${fmtNum(cal.pbias, 1)}`}<small>%</small></dd>
			{#if cal.pbias != null}<dd class="sub">{describePbias(cal.pbias)}</dd>{/if}
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

{#if summary.landCover || summary.users?.length || pumping.length || farms.some((f) => f.demandObjects?.length)}
	<Lazy load={loadHumanImpacts}>
		{#snippet children(HumanImpactTables)}
			<HumanImpactTables {summary} />
		{/snippet}
	</Lazy>
{/if}

<style>
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
		font-size: 0.75rem;
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
	.stat dd.none {
		color: var(--text-muted);
	}
</style>
