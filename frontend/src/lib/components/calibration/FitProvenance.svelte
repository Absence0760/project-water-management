<!--
	Where a set of parameters came from (issue #4): the fit record Apply
	stored, with how the fit was made and its in-sample score next to its
	validation scores, plus anything that has changed since. Used on the Runs
	page (the run's own snapshot) and under Fit automatically in Settings (the
	form as it stands).
-->
<script lang="ts">
	import { arealRainText, exclusionLabel, fitPeriodText, fitRecordCaveats, fitRecordStatus, gapFillRecordLabel, originLabel, provenanceLabel, rainSourceText, resolveArealRain, type ApanDailyFingerprint, type ChirpsFactorSet, type FitRecord, type PeInput, type ProjectSettings, type SeriesOrigin, type SeriesProvenance } from '@water-management/engine';
	import { fittedAtText, objectiveName, rankedByText, scoreCellText, scoreColumns, waterYearsText } from '$lib/calibration/fit';
	import { FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { CHIRPS_BIAS_OPTIONS, describeZeroRain } from '$lib/components/settings/rain';
	import { describeRainChecks } from '$lib/components/settings/dataQuality';
	import { peText } from '$lib/components/settings/peInput';
	import { fmtNum } from '$lib/format/number';
	import { apanDailyText, chirpsFactorsText, fitModelLabel, monthsText, paramLabel } from './provenance';
	import { dayQualityGist, ratingLine } from './dayQuality';

	const chirpsBiasLabel = (mode: string) => CHIRPS_BIAS_OPTIONS.find((o) => o.value === mode)?.label ?? mode;

	let {
		record,
		settings,
		heading = 'Where the parameters came from',
		headingLevel = 3,
		context = 'run',
		chirpsSource,
		apanDaily,
		chirpsFactors,
		observedOrigin,
		nodeName
	}: {
		record: FitRecord | null | undefined;
		/** The settings the record sits in (a run's snapshot, or the form). */
		settings: Partial<ProjectSettings>;
		heading?: string;
		headingLevel?: 3 | 4;
		/** 'run': a stored run; 'form': the unsaved Settings form. */
		context?: 'run' | 'form';
		/** The CHIRPS series' product and version now (the run's, or the project's); undefined when not known. */
		chirpsSource?: SeriesProvenance | null;
		/** The daily A-pan series now (the run's, or the project's; issue #45); undefined when not known. */
		apanDaily?: ApanDailyFingerprint | null;
		/** The CHIRPS factor sets the run applied (runChirpsFactors, issue #51); undefined when not known (the form). */
		chirpsFactors?: ChirpsFactorSet[] | null;
		/** The fitted record's source and given unit now (107_series_source.sql); undefined when not known. */
		observedOrigin?: SeriesOrigin | null;
		/** A node's name by id, to name the gauge a fit was scored at (engine ≥ 1.41.0); omitted = not known. */
		nodeName?: (id: string) => string | undefined;
	} = $props();
	// Where the fit was scored (engine ≥ 1.41.0): nothing for the outlet.
	const siteText = (id: string | null | undefined) => (id ? ` at the gauge ${nodeName?.(id) ? `“${nodeName(id)}”` : 'inside the network'}` : '');
	// The fitted record's gap filling (engine ≥ 1.23.0), in words.
	const fillText = (f: FitRecord['flowGapFill']) => {
		if (!f?.spec) return 'none';
		const parts: string[] = [];
		if (f.spec.interpolateMaxDays) parts.push(`interpolated up to ${f.spec.interpolateMaxDays} days`);
		if (f.spec.donor) parts.push(`from the ${gapFillRecordLabel(f.spec.donor)} up to ${f.spec.donorMaxDays} days`);
		// Whether the fit scored the filled days is the quality-flag row's infilled treatment.
		return parts.join(', ') || 'none';
	};

	const uid = $props.id();
	const status = $derived(record ? fitRecordStatus(settings, record, { chirpsSource, apanDaily, ...(chirpsFactors !== undefined ? { chirpsFactors } : {}), ...(observedOrigin !== undefined ? { observedOrigin } : {}) }) : null);
	const caveats = $derived(status ? fitRecordCaveats(status, (k) => paramLabel(record!.model, k)) : []);
	// The in-sample fit, then the validation parts: the columns a reader should judge by.
	const columns = $derived(record ? scoreColumns(record).filter((c) => c.id !== 'before' && (c.id === 'fit' || c.id === 'fit-all' || c.validation)) : []);
	const windowText = (r: FitRecord) =>
		r.calibrationStart || r.calibrationEnd ? `${r.calibrationStart ?? 'start of record'} – ${r.calibrationEnd ?? 'end of record'}` : 'whole record';
	// GR4J's PE input the fit ran under (engine ≥ 0.31.0, issue #39); a forcing without it ran on pan coefficient × A-pan.
	const recordedPe = $derived((record?.forcing as { pe?: PeInput } | undefined)?.pe ?? { kind: 'pan' as const });
	const exclusions = $derived((settings.calibrationExclusions ?? []) as FitRecord['exclusions']);
</script>

<section class="prov" aria-labelledby="{uid}-h">
	<svelte:element this={`h${headingLevel}`} id="{uid}-h">{heading} <HelpTip key="settings.fitRecord" /></svelte:element>
	{#if !record}
		<p class="muted small">
			No fit record: {context === 'run' ? 'this run’s' : 'these'} parameters were set by hand, imported, or saved before fit records existed. Nothing
			shows how they were validated.
		</p>
	{:else}
		<p class="small">
			<strong>{fitModelLabel(record.model)} fit of {fittedAtText(record.fittedAt)}</strong>
			{#if record.auto}<span class="badge" data-testid="fit-auto-badge">Automated</span>{/if}
			{#if status && status.rulesChanged}<span class="badge badge-warn">Rules changed since fit</span>{/if}
			{#if status && status.editedParams.length}<span class="badge badge-warn">Parameters edited since fit</span>{/if}
			{#if status && status.forcingChanged}<span class="badge badge-warn">Forcing changed since fit</span>{/if}
			{#if status && status.qualityFlagsChanged}<span class="badge badge-warn">Quality flags changed since fit</span>{/if}
		</p>
		{#each caveats as c (c)}<p class="alert alert-warning small" role="status">{c}</p>{/each}
		<dl class="meta">
			<div><dt>Objective</dt><dd>{objectiveName(record.objective)}</dd></div>
			<div><dt>Bounds</dt><dd>{record.bounds === 'typical' ? 'typical (Perrin et al. 80 %)' : 'wide'}</dd></div>
			<div><dt>Seed</dt><dd>{record.seed}</dd></div>
			<div><dt>Model runs</dt><dd>{fmtNum(record.budget)} per fit{(record.starts ?? 1) > 1 ? `, ${record.starts} starts` : ''}, {fmtNum(record.evaluations)} in all{record.cancelled ? ' (cancelled)' : ''}</dd></div>
			<div><dt>Engine</dt><dd>{record.engineVersion}</dd></div>
			<!-- Issue #153: the fit automated calibration kept, under which rules, and what they left out. -->
			{#if record.auto}
				{@const a = record.auto}
				<div data-testid="fit-auto">
					<dt>Picked by <HelpTip key="settings.calibrationRules" /></dt>
					<dd>
						calibration rules revision {a.rules.revision} ({a.rules.signedOff ? `signed off by ${a.rules.signedOff.by} on ${a.rules.signedOff.on}` : 'draft, not signed off'}): kept
						{a.cases[a.chosen]?.label ?? '–'} of {a.cases.length} fit{a.cases.length === 1 ? '' : 's'}, {a.cases.filter((c) => c.eligible).length} passing the filters
					</dd>
				</div>
				<div data-testid="fit-auto-exclusions">
					<dt>Left out by rule</dt>
					<dd>{a.ruleExclusions.length ? a.ruleExclusions.map((x) => `${exclusionLabel(x)} (${x.reason})`).join('; ') : 'none'}</dd>
				</div>
			{/if}
			<div data-testid="fit-record-to"><dt>Fitted to</dt><dd>{FLOW_KIND_LABEL[record.flowKind] ?? record.flowKind}{siteText(record.siteNodeId)}, {windowText(record)}</dd></div>
			{#if record.forcing}
				<div data-testid="fit-pe">
					<dt>GR4J potential evaporation <HelpTip key="settings.pe" /></dt>
					<dd>{peText(recordedPe)}{#if recordedPe.kind === 'monthly'}: {monthsText(recordedPe.mm, 0)} mm{/if}</dd>
				</div>
				<!-- Engine ≥ 1.13.0 (docs/model.md §2.4g): a forcing without it ran with none. -->
				<div data-testid="fit-areal-rain">
					<dt>Areal rainfall correction <HelpTip key="settings.arealRain" /></dt>
					<dd>{arealRainText(resolveArealRain(record.forcing.arealRain, []))}</dd>
				</div>
				<div>
					<dt>Pan coefficient <HelpTip key="settings.panCoefficient" /></dt>
					<dd>{monthsText(record.forcing.panCoefficient)}{recordedPe.kind === 'monthly' ? ' (not used by GR4J under a monthly PE)' : ''}</dd>
				</div>
				{#if record.forcing.panCoefficientSource}
					<div data-testid="fit-pan-source"><dt>Pan coefficient source</dt><dd>{record.forcing.panCoefficientSource}</dd></div>
				{/if}
				<div><dt>A-pan evaporation <HelpTip key="settings.apanMm" /></dt><dd>{monthsText(record.forcing.apanMm, 0)} mm</dd></div>
				<!-- Issue #45: the daily A-pan series the fit ran on, and the series now when it differs. -->
				<div data-testid="fit-apan-daily">
					<dt>Daily A-pan series <HelpTip key="series.evap_apan_mm" /></dt>
					<dd>{apanDailyText(record.forcing.apanDaily)}{#if status?.apanDailyChanged}{' '}(now {apanDailyText(apanDaily)}){/if}</dd>
				</div>
				<div>
					<dt>CHIRPS bias correction <HelpTip key="settings.chirpsBiasCorrection" /></dt>
					<dd>{record.forcing.chirpsBiasCorrection ? chirpsBiasLabel(record.forcing.chirpsBiasCorrection) : 'not recorded (fit made before this was tracked)'}</dd>
				</div>
				<div>
					<dt>CHIRPS fit period <HelpTip key="settings.chirpsFitPeriod" /></dt>
					<dd>{record.forcing.chirpsFitPeriod !== undefined ? fitPeriodText(record.forcing.chirpsFitPeriod) : 'not recorded (fit made before this was tracked)'}</dd>
				</div>
				<!-- Engine ≥ 1.47.0 (CR-23): recorded only when on; absent = off, as every fit before it. -->
				<div>
					<dt>CHIRPS quantile map <HelpTip key="settings.chirpsQuantileMap" /></dt>
					<dd>{record.forcing.chirpsQuantileMap ? `on (wet days ≥ ${record.forcing.chirpsQuantileMap.wetDayMm} mm)` : 'off'}</dd>
				</div>
				<!-- Issue #66: the fitted record's source and given unit, and its gap filling (engine ≥ 1.23.0). -->
				{#if record.observedOrigin !== undefined}
					<div data-testid="fit-observed-source">
						<dt>Calibration record source</dt>
						<dd>{originLabel(record.observedOrigin)}{#if status?.observedOriginChanged}{' '}(now {originLabel(observedOrigin)}){/if}</dd>
					</div>
				{/if}
				{#if record.flowGapFill}
					<div data-testid="fit-gap-fill">
						<dt>Gaps in the calibration record <HelpTip key="settings.flowGapFill" /></dt>
						<dd>{fillText(record.flowGapFill)}</dd>
					</div>
				{/if}
				<!-- Issue #40c: the CHIRPS product and version the fit ran on, and the series' now when it differs. -->
				<div data-testid="fit-chirps-source">
					<dt>CHIRPS series</dt>
					<dd>
						{record.forcing.chirpsSource !== undefined ? provenanceLabel(record.forcing.chirpsSource) : 'not recorded (fit made before this was tracked)'}{#if status?.chirpsSourceChanged}{' '}(now {provenanceLabel(chirpsSource)}){/if}
					</dd>
				</div>
				{#if record.forcing.chirpsFactors?.length}
					<div>
						<dt>CHIRPS factors</dt>
						<dd>
							{#each record.forcing.chirpsFactors as f (f.label)}<span class="factor-set">{f.label}{f.fittedOn ? ` (fitted on ${f.fittedOn})` : ''}: {chirpsFactorsText(f.factors)}</span>{/each}
						</dd>
					</div>
				{/if}
				<!-- Engine ≥ 0.30.0 (issue #40 b): a forcing without it ran with none. -->
				<div data-testid="fit-rain-source">
					<dt>Rain source periods <HelpTip key="settings.rainSource" /></dt>
					<dd>{rainSourceText(record.forcing.rainSource ?? [])}</dd>
				</div>
				<div>
					<dt>Zero-rain runs <HelpTip key="settings.zeroRainRuns" /></dt>
					<dd>{record.forcing.zeroRainRuns ? describeZeroRain(record.forcing.zeroRainRuns) : 'not recorded (fit made before this was tracked)'}</dd>
				</div>
				<!-- Engine ≥ 1.20.0 (issue #66): the data-quality limits that decide which rain is suspect; absent = the defaults. -->
				<div data-testid="fit-rain-checks">
					<dt>Rain data-quality limits <HelpTip key="settings.dataQuality" /></dt>
					<dd>{describeRainChecks(record.forcing.rainChecks)}</dd>
				</div>
			{:else}
				<div><dt>Forcing</dt><dd>not recorded (fit made before this was tracked)</dd></div>
			{/if}
			<div>
				<dt>Excluded</dt>
				<dd>
					{#if record.exclusions.length}
						{record.exclusions.map((x) => `${exclusionLabel(x)} (${x.reason})`).join('; ')}
					{:else}none{/if}
				</dd>
			</div>
			{#if record.marPenalty}
				{@const m = record.marPenalty}
				{@const target = m.marLowMm3 !== null && m.marHighMm3 !== null ? `${fmtNum(m.marLowMm3, 3)}–${fmtNum(m.marHighMm3, 3)} Mm³/a band` : 'WR2012'}
				<div>
					<dt>WR2012 MAR penalty</dt>
					<dd>
						weight {fmtNum(m.weight, 2)}: simulated MAR {fmtNum(m.marRatio, 2)} × {target}{m.unpenalised ? ` (${fmtNum(m.unpenalised.marRatio, 2)} × without the penalty)` : ''}
					</dd>
				</div>
			{/if}
			{#if record.dayQuality}
				<!-- Engine ≥ 1.22.0 (CR-18/19): which days the quality flags let the fit score. -->
				<div data-testid="fit-quality-flags">
					<dt>Quality flags <HelpTip key="settings.qualityFlags" /></dt>
					<dd>{dayQualityGist(record.dayQuality)}. {ratingLine(record.dayQuality)}</dd>
				</div>
			{/if}
			<div><dt>Parameters fitted</dt><dd>{record.free.map((k) => `${paramLabel(record.model, k)} ${fmtNum(record.params[k], 3)}`).join(', ')}</dd></div>
		</dl>
		<div class="table-wrap">
			<table class="data compact">
				<caption>{objectiveName(record.objective)}: the fit to the calibration period (in-sample), and on days it never saw</caption>
				<thead>
					<tr>
						{#each columns as c (c.id)}
							<th scope="col" class="num" class:val={c.validation}>
								{c.id === 'fit' ? 'Calibration period (in-sample)' : c.id === 'fit-all' ? 'All days (flags ignored)' : c.label}<br /><span class="period">{c.period}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						{#each columns as c (c.id)}
							<td class="num" class:val={c.validation}>{scoreCellText(c, record.objective)}</td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
		{#if columns.length === 1}
			<p class="alert alert-warning small">This fit was not validated: nothing shows how it does on days it wasn’t fitted to.</p>
		{/if}
		{#if record.differential}
			<p class="muted small">
				Dry → wet: fitted on {waterYearsText(record.differential.dryYears)}, scored on {waterYearsText(record.differential.wetYears)};
				{rankedByText(record.differential)}.
			</p>
		{/if}
		{#each record.notes as n (n)}<p class="muted small note">{n}</p>{/each}
	{/if}
	{#if context === 'run' && exclusions.length}
		<p class="small">
			This run’s calibration statistics leave out {exclusions.map((x) => `${exclusionLabel(x)} (${x.reason})`).join('; ')}.
		</p>
	{/if}
</section>

<style>
	.prov {
		margin: 0.25rem 0 0.75rem;
	}
	h3,
	h4 {
		margin: 0 0 0.35rem;
	}
	.factor-set {
		display: block;
	}
	.meta {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0.25rem 1rem;
		margin: 0.4rem 0;
		font-size: 0.8rem;
	}
	.meta dt {
		color: var(--text-muted);
	}
	.meta dd {
		margin: 0;
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
		font-size: 0.85rem;
	}
	th.val,
	td.val {
		background: var(--accent-soft);
	}
	.period {
		font-weight: 400;
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.badge {
		margin-left: 0.4rem;
	}
	.note {
		margin: 0.2rem 0;
	}
</style>
