<!--
	A run's WR2012 check (RunSummary.wr2012; issue #4 phase 8): the simulated
	natural flow against the entered WR2012 naturalised flow, scaled to the
	modelled catchment. MAR ratios, the 12 monthly ratios with the dry season
	marked, the pattern correlation and the deviation flag.
-->
<script lang="ts">
	import type { Wr2012Report } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtQty } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import { describeScaling, FLAG_LABEL, monthsText, ratioText, waterYear, yearsText } from './wr2012';

	let { report }: { report: Wr2012Report } = $props();

	const uid = $props.id();
	const flagClass = $derived({ ok: 'good', note: 'ok', query: 'warn', unusable: 'bad' }[report.flag.level]);
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">WR2012 check: {report.quaternary} <HelpTip key="settings.wr2012" /></h3>
	<p class="muted small">
		Simulated <strong>natural flow</strong> against the WR2012 naturalised flow for {report.quaternary}
		({waterYear(report.referencePeriod.start)} – {waterYear(report.referencePeriod.end)}) · Source: {report.source}
	</p>
	<p class="small">
		<span class="lbl">Scaled to the modelled catchment:</span> {describeScaling(report)}. WR2012 MAR {fmtQty(report.referenceMarMm3, 3)} Mm³/a →
		<strong>{fmtQty(report.scaledMarMm3, 3)} Mm³/a</strong>.
	</p>

	<p class="flag {flagClass}" role="status">
		<strong>{FLAG_LABEL[report.flag.level]}</strong>
		{#if report.flag.text}· {report.flag.text}{:else}· The simulated MAR is within {fmtNum(report.flag.thresholds.notePct, 0)} % of the scaled WR2012 MAR.{/if}
	</p>

	<div class="table-wrap">
		<table class="data compact" aria-labelledby="{uid}-mar">
			<caption id="{uid}-mar">Mean annual runoff, simulated natural ÷ scaled WR2012</caption>
			<thead>
				<tr>
					<th scope="col">Over</th>
					<th scope="col" class="num">Simulated <span class="u">Mm³/a</span></th>
					<th scope="col" class="num">WR2012 <span class="u">Mm³/a</span></th>
					<th scope="col" class="num">Ratio</th>
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row">Overlapping years{#if report.overlap}: {yearsText(report.overlap.years)}{/if}</th>
					{#if report.overlap}
						<td class="num">{fmtQty(report.overlap.simulatedMarMm3, 3)}</td>
						<td class="num">{fmtQty(report.scaledMarMm3, 3)}</td>
						<td class="num">{ratioText(report.overlap.ratio)}</td>
					{:else}
						<td class="num muted" colspan="3">no complete water year inside the reference period</td>
					{/if}
				</tr>
				<tr>
					<th scope="row">Whole run ({fmtNum(report.whole.days)} days)</th>
					<td class="num">{fmtQty(report.whole.simulatedMarMm3, 3)}</td>
					<td class="num">{fmtQty(report.scaledMarMm3, 3)}</td>
					<td class="num">{ratioText(report.whole.ratio)}</td>
				</tr>
			</tbody>
		</table>
	</div>

	<div class="table-wrap">
		<table class="data compact monthly" aria-labelledby="{uid}-m">
			<caption id="{uid}-m">
				Monthly means over {report.monthlyBasis === 'overlap' ? 'the overlapping years' : 'the whole run'}, Mm³ per month (dry-season months marked “dry”)
			</caption>
			<thead>
				<tr>
					<th scope="col">Month</th>
					{#each report.months as m (m.month)}
						<th scope="col" class="num" class:dry={m.lowFlow}>{monthName(m.month)}{#if m.lowFlow}<br /><span class="tag">dry</span>{/if}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				<tr>
					<th scope="row">Simulated</th>
					{#each report.months as m (m.month)}<td class="num" class:dry={m.lowFlow}>{fmtQty(m.simulatedMm3, 3)}</td>{/each}
				</tr>
				<tr>
					<th scope="row">WR2012 (scaled)</th>
					{#each report.months as m (m.month)}<td class="num" class:dry={m.lowFlow}>{fmtQty(m.referenceMm3, 3)}</td>{/each}
				</tr>
				<tr>
					<th scope="row">Ratio</th>
					{#each report.months as m (m.month)}<td class="num" class:dry={m.lowFlow}>{m.ratio === null ? '–' : fmtNum(m.ratio, 2)}</td>{/each}
				</tr>
			</tbody>
		</table>
	</div>
	<dl class="stats">
		<div class="stat">
			<dt>Dry season ({monthsText(report.lowFlowMonths)})</dt>
			<dd>{ratioText(report.lowFlowRatio)}</dd>
			<dd class="sub">{report.lowFlowSource === 'setting' ? 'months set in Settings' : 'the months this run’s natural flow is lowest'}</dd>
		</div>
		<div class="stat">
			<dt>Monthly pattern correlation</dt>
			<dd>{fmtNum(report.patternCorrelation, 2)}</dd>
			<dd class="sub">Pearson r of the 12 monthly means (1 = same seasonal shape)</dd>
		</div>
	</dl>
</section>

<style>
	.small {
		font-size: 0.85rem;
	}
	.lbl {
		font-weight: 500;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
	.flag {
		border-left: 4px solid var(--border);
		padding: 0.4rem 0.6rem;
		background: var(--surface-2);
		max-width: 90ch;
	}
	.flag.good {
		border-left-color: var(--success, var(--accent));
	}
	.flag.ok {
		border-left-color: var(--accent);
	}
	.flag.warn {
		border-left-color: var(--warning);
	}
	.flag.bad {
		border-left-color: var(--danger);
	}
	.dry {
		background: var(--accent-soft);
	}
	.tag {
		font-size: 0.7rem;
		font-weight: 400;
	}
	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem 2rem;
		margin: 0.75rem 0 0;
	}
	.stat dt {
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.stat dd {
		margin: 0;
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
	}
	.stat dd.sub {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
