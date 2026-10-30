<!--
	Calibration panel for a run: the scored window, fit metrics with one-line
	explanations (no pass marks: calibration research CR-6), the WR2012
	five-statistic table (CR-28), and the annual water balance (observed vs
	simulated volume per water year).
	Input: RunSummary.calibration; optional settings to show the requested window.
-->
<script lang="ts">
	import type { CalibrationStats } from '@water-management/engine';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import {
		FLOW_KIND_LABEL,
		SIMULATED_LABEL,
		describeWindow,
		isLegacyStats,
		isPartYear,
		kgeComponents,
		metricRows,
		volumeBiasText,
		waterYearLabel,
		WORSE_THAN_MEAN
	} from './metrics';
	import { calibrationSample } from './sample';
	import Wr2012FitTable from './Wr2012FitTable.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';

	let {
		calibration,
		requestedStart = null,
		requestedEnd = null,
		linked = false
	}: {
		calibration: CalibrationStats | null | undefined;
		/** settings.calibrationStart/End, to show what was asked for next to what was scored. */
		requestedStart?: string | null;
		requestedEnd?: string | null;
		/** On the Calibration page: the fixes link to Calibration record (on the page) and Data. A printed report keeps them as words. */
		linked?: boolean;
	} = $props();

	const uid = $props.id();
	const rows = $derived(calibration ? metricRows(calibration) : []);
	// In-sample only when the parameters were fitted on these days (issue #45).
	const sample = $derived(calibrationSample(calibration));
	const legacy = $derived(calibration ? isLegacyStats(calibration) : false);
	const years = $derived(calibration?.annualVolumes ?? []);
	const yearTotals = $derived({
		obs: years.reduce((a, y) => a + y.observedMm3, 0),
		sim: years.reduce((a, y) => a + y.simulatedMm3, 0)
	});
</script>

<section class="calibration" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Calibration against observed flow</h3>

	{#if calibration && calibration.days === 0 && calibration.excludedDays}
		<p class="muted">
			Every observed day inside the calibration window falls in a calibration exclusion
			({calibration.exclusions?.map((x) => `${fmtDay(x.start)} – ${fmtDay(x.end)}: ${x.reason}`).join('; ')}), so there are no calibration statistics.
			Change the exclusions in {#if linked}<a href="#set-record">Calibration record</a>{:else}Calibration record, on the Calibration page{/if}.
		</p>
	{:else if !calibration || calibration.days === 0}
		<p class="muted">
			No observed flow falls inside the calibration window{requestedStart || requestedEnd
				? ` (${describeWindow(requestedStart, requestedEnd, fmtDay)})`
				: ''}, so there are no calibration statistics. Add an observed or logger flow record on {#if linked}<a href="?tab=series">Data</a>{:else}Data{/if}, or
			widen the window in {#if linked}<a href="#set-record">Calibration record</a>{:else}Calibration record, on the Calibration page{/if}.
		</p>
	{:else}
		<p class="note muted in-sample" data-fit-status={sample.status}>
			<strong>{sample.label}.</strong> {sample.note} <HelpTip key="stats.fitStatus" label="About in-sample scores" />
		</p>
		<dl class="window">
			<div>
				<dt>Window <HelpTip key="calibration-window" /></dt>
				<dd>
					{describeWindow(calibration.windowStart ?? requestedStart, calibration.windowEnd ?? requestedEnd, fmtDay)}
					{#if !requestedStart && !requestedEnd && !legacy}<span class="muted">(no window set: whole overlap)</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Observations</dt>
				<dd>
					{fmtNum(calibration.days)} days{#if calibration.firstObservedDate}, {fmtDay(calibration.firstObservedDate)} – {fmtDay(calibration.lastObservedDate ?? '–')}{/if}
				</dd>
			</div>
			{#if calibration.flowKind}
				<div data-testid="calibration-compared-with">
					<dt>Compared with</dt>
					<dd>{FLOW_KIND_LABEL[calibration.flowKind] ?? calibration.flowKind}{#if calibration.siteNodeId}, at the gauge “{calibration.siteName ?? calibration.siteNodeId}” (the headline location){/if}</dd>
				</div>
			{/if}
			{#if calibration.simulatedKey}
				<div><dt>Scored against</dt><dd>{SIMULATED_LABEL[calibration.simulatedKey]}</dd></div>
			{/if}
			{#if calibration.exclusions?.length}
				<div>
					<dt>Excluded</dt>
					<dd>
						{fmtNum(calibration.excludedDays ?? 0)} observed days in
						{calibration.exclusions.map((x) => `${fmtDay(x.start)} – ${fmtDay(x.end)} (${x.reason})`).join('; ')}
					</dd>
				</div>
			{/if}
		</dl>

		{#if legacy}
			<p class="alert alert-info" role="status">
				This run was made before the calibration window and the extra metrics existed. Run the model again to see KGE,
				log-NSE and the annual water balance.
			</p>
		{/if}

		<ul class="metrics">
			{#each rows as r (r.key)}
				<li class="metric" class:flagged={r.worseThanMean}>
					<div class="top">
						<span class="label" id="{uid}-{r.key}">{r.label}</span> <HelpTip key={`stats.${r.key}`} label="About {r.label}" />
					</div>
					<div class="value">{r.value}{#if r.unit}<small>{r.unit}</small>{/if}</div>
					{#if r.worseThanMean}<p class="flag">{WORSE_THAN_MEAN[0]!.toUpperCase()}{WORSE_THAN_MEAN.slice(1)}.</p>{/if}
					<p class="help">{r.help}</p>
					{#if r.key === 'kge' && kgeComponents(calibration)}
						<p class="help">{kgeComponents(calibration)} (correlation, variability ratio, volume ratio; each 1 is ideal)</p>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="note muted">
			No pass marks: the published ones (Moriasi et al. 2007) were set for monthly flows and don't carry over to daily
			fits. Compare with the mean flow instead: it scores NSE 0 and KGE −0.41.
		</p>

		{#if calibration.wr2012Fit}
			<Wr2012FitTable periods={[{ id: 'run', label: 'This run', stats: calibration.wr2012Fit }]} />
		{/if}

		{#if years.length}
			<h4 id="{uid}-y">Annual water balance <HelpTip key="stats.annualVolumes" /></h4>
			<div class="table-wrap years-wrap">
				<table class="data years" aria-labelledby="{uid}-y">
					<thead>
						<tr>
							<th scope="col">Water year</th>
							<th scope="col" class="num">Days observed</th>
							<th scope="col" class="num">Observed<br /><span class="u">Mm³</span></th>
							<th scope="col" class="num">Simulated<br /><span class="u">Mm³</span></th>
							<th scope="col" class="num">Simulated vs observed</th>
						</tr>
					</thead>
					<tbody>
						{#each years as y (y.waterYear)}
							{@const part = isPartYear(y)}
							<tr>
								<th scope="row">
									{waterYearLabel(y.waterYear)}
									{#if part}<span class="badge badge-warn">part year</span>{/if}
								</th>
								<!-- data-label: each cell's name where the narrow layout stacks the row (below). -->
								<td class="num" data-label="Days observed">{fmtNum(y.days)}<span class="muted">{' '}of {fmtNum(y.daysInWindow)}</span></td>
								<td class="num" data-label="Observed (Mm³)">{fmtNum(y.observedMm3, 2)}</td>
								<td class="num" data-label="Simulated (Mm³)">{fmtNum(y.simulatedMm3, 2)}</td>
								<td class="num" data-label="Simulated vs observed">{volumeBiasText(y.diffPct)}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row">Window</th>
							<td class="num" data-label="Days observed">{fmtNum(calibration.days)}</td>
							<td class="num" data-label="Observed (Mm³)">{fmtNum(yearTotals.obs, 2)}</td>
							<td class="num" data-label="Simulated (Mm³)">{fmtNum(yearTotals.sim, 2)}</td>
							<td class="num" data-label="Simulated vs observed">{volumeBiasText(calibration.volumeErrorPct ?? (calibration.pbias == null ? null : -calibration.pbias))}</td>
						</tr>
					</tfoot>
				</table>
			</div>
			<p class="note muted">
				Volumes cover only the days with an observation, so a part year compares like with like but is not a full year's
				runoff. Water years run October to September.
			</p>
		{/if}
	{/if}
</section>

<style>
	/* The panel answers to its own width: the tiles' columns and the year table's layout (ui-playbook.md § 2). */
	.calibration {
		container: cal-panel / inline-size;
	}
	.window {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		margin: 0 0 0.75rem;
	}
	.window dt {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.window dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.metrics {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
	}
	/* Six tiles: 2 + 2 + 2, or 3 + 3 where there's room, never 4 + 2 beside an empty half row (#586 R4-A; the Summary's
	   cards learned the same, ui-playbook.md § 2). 28rem and 44rem are 392 and 616 px at 14 px. */
	@container cal-panel (min-width: 28rem) {
		.metrics {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@container cal-panel (min-width: 44rem) {
		.metrics {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	/* A narrow panel (a phone): each water year is a block, its cells two to a line under their names, instead of five
	   columns scrolling sideways in their box (YearTable.svelte's pattern; the table needs ~520 px, 38rem is 532). */
	@container cal-panel (max-width: 38rem) {
		.years-wrap {
			border: 0;
			background: none;
			overflow: visible;
		}
		.years,
		.years tbody,
		.years tfoot {
			display: block;
		}
		.years thead {
			display: none;
		}
		.years tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.3rem 0.75rem;
			padding: 0.5rem 0;
			border-bottom: 1px solid var(--border);
		}
		table.data.years th,
		table.data.years td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			white-space: normal;
			min-width: 0;
		}
		table.data.years th[scope='row'] {
			grid-column: 1 / -1;
			font-weight: 600;
		}
		/* The window's totals: one shaded block under a heavier rule, not a shaded box per cell. */
		.years tfoot tr {
			padding: 0.5rem;
			border-top: 2px solid var(--border-strong);
			border-bottom: none;
			background: var(--surface-2);
		}
		table.data.years tfoot th,
		table.data.years tfoot td {
			border-top: none;
			background: none;
		}
		.years td::before {
			content: attr(data-label);
			display: block;
			font-size: var(--font-xs);
			font-weight: 400;
			color: var(--text-2);
		}
	}
	.metric {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.8rem;
	}
	.top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.4rem;
	}
	.label {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.value {
		font-size: 1.2rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.value small {
		font-size: var(--font-xs);
		font-weight: 400;
		color: var(--text-muted);
		margin-left: 0.2rem;
	}
	/* No better than the mean flow: the Summary's tile carries the same edge and words (#586 D12). */
	.metric.flagged {
		border-color: color-mix(in srgb, var(--warning) 55%, var(--border));
		box-shadow: inset 3px 0 0 var(--warning);
	}
	.flag {
		margin: 0.1rem 0 0;
		font-size: var(--font-sm);
		font-weight: 600;
		color: var(--warning);
	}
	.help {
		font-size: var(--font-sm);
		color: var(--text-2);
		margin: 0.2rem 0 0;
	}
	.badge {
		white-space: nowrap;
	}
	h4 {
		margin-top: 1rem;
	}
	.note {
		font-size: var(--font-sm);
	}
</style>
