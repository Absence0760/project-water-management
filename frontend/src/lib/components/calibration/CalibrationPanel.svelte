<!--
	Calibration panel for a run: the scored window, fit metrics with one-line
	explanations (no pass marks: calibration research CR-6), the WR2012
	five-statistic table (CR-28), and the annual water balance (observed vs
	simulated volume per water year).
	Input: RunSummary.calibration; optional settings to show the requested window.
-->
<script lang="ts">
	import type { CalibrationStats } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import {
		FLOW_KIND_LABEL,
		SIMULATED_LABEL,
		describeWindow,
		isLegacyStats,
		isPartYear,
		kgeComponents,
		metricRows,
		volumeBiasText,
		waterYearLabel
	} from './metrics';
	import { calibrationSample } from './sample';
	import Wr2012FitTable from './Wr2012FitTable.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let {
		calibration,
		requestedStart = null,
		requestedEnd = null
	}: {
		calibration: CalibrationStats | null | undefined;
		/** settings.calibrationStart/End, to show what was asked for next to what was scored. */
		requestedStart?: string | null;
		requestedEnd?: string | null;
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
			({calibration.exclusions?.map((x) => `${x.start} – ${x.end}: ${x.reason}`).join('; ')}), so there are no calibration statistics.
			Change the exclusions in Settings.
		</p>
	{:else if !calibration || calibration.days === 0}
		<p class="muted">
			No observed flow falls inside the calibration window{requestedStart || requestedEnd
				? ` (${describeWindow(requestedStart, requestedEnd)})`
				: ''}, so there are no calibration statistics. Upload an observed or logger flow series, or widen the window in
			Settings.
		</p>
	{:else}
		<p class="note muted in-sample" data-fit-status={sample.status}>
			<strong>{sample.label}.</strong> {sample.note} <HelpTip key="stats.fitStatus" label="About in-sample scores" />
		</p>
		<dl class="window">
			<div>
				<dt>Window <HelpTip key="calibration-window" /></dt>
				<dd>
					{describeWindow(calibration.windowStart ?? requestedStart, calibration.windowEnd ?? requestedEnd)}
					{#if !requestedStart && !requestedEnd && !legacy}<span class="muted">(no window set: whole overlap)</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Observations</dt>
				<dd>
					{fmtNum(calibration.days)} days{#if calibration.firstObservedDate}, {calibration.firstObservedDate} – {calibration.lastObservedDate}{/if}
				</dd>
			</div>
			{#if calibration.flowKind}
				<div data-testid="calibration-compared-with">
					<dt>Compared with</dt>
					<dd>{FLOW_KIND_LABEL[calibration.flowKind] ?? calibration.flowKind}{#if calibration.siteNodeId}, at the gauge “{calibration.siteName ?? calibration.siteNodeId}” (the calibration site){/if}</dd>
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
						{calibration.exclusions.map((x) => `${x.start} – ${x.end} (${x.reason})`).join('; ')}
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
				<li class="metric">
					<div class="top">
						<span class="label" id="{uid}-{r.key}">{r.label}</span> <HelpTip key={`stats.${r.key}`} label="About {r.label}" />
					</div>
					<div class="value">{r.value}{#if r.unit}<small>{r.unit}</small>{/if}</div>
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
			<div class="table-wrap">
				<table class="data" aria-labelledby="{uid}-y">
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
								<td class="num">{fmtNum(y.days)}<span class="muted"> / {fmtNum(y.daysInWindow)}</span></td>
								<td class="num">{fmtNum(y.observedMm3, 2)}</td>
								<td class="num">{fmtNum(y.simulatedMm3, 2)}</td>
								<td class="num">{volumeBiasText(y.diffPct)}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row">Window</th>
							<td class="num">{fmtNum(calibration.days)}</td>
							<td class="num">{fmtNum(yearTotals.obs, 2)}</td>
							<td class="num">{fmtNum(yearTotals.sim, 2)}</td>
							<td class="num">{volumeBiasText(calibration.volumeErrorPct ?? (calibration.pbias == null ? null : -calibration.pbias))}</td>
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
	.window {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		margin: 0 0 0.75rem;
	}
	.window dt {
		font-size: 0.78rem;
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
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 0.75rem;
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
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.value {
		font-size: 1.2rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.value small {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-muted);
		margin-left: 0.2rem;
	}
	.help {
		font-size: 0.78rem;
		color: var(--text-2);
		margin: 0.2rem 0 0;
	}
	.badge {
		text-transform: none;
		white-space: nowrap;
	}
	h4 {
		margin-top: 1rem;
	}
	.note {
		font-size: 0.8rem;
	}
</style>
