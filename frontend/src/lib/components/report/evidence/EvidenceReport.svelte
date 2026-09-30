<script lang="ts">
	// The licensing evidence report (issue #71, docs/design/evidence-report.md,
	// docs/ui.md § Evidence report): the report route's evidence mode, and the
	// layout an issued pack renders from its frozen manifest (WP-3.14), so
	// there is one layout. Everything comes from one EvidenceReport document
	// the engine built (evidenceReport); this component only lays it out.
	// Its own chunk: loaded only for an evidence report.
	import { ALLOCATION_MODE_LABEL, declaredRuleText, describeFitRecord, ENSEMBLE_MEASURES_SINCE, type Band, type EvidenceReport, type EwrAssuranceSite, type ModelInput } from '@water-management/engine';
	import type { PackSignoffList, SignoffList } from '$lib/api';
	import type { SignoffTarget } from '$lib/components/liability/signoffForm';
	import { packVerifyLine, type VerifyRef } from '$lib/components/packs/pack';
	import { evidenceBoard } from '../licenceImpact';
	import CalibrationPanel from '$lib/components/calibration/CalibrationPanel.svelte';
	import FitProvenance from '$lib/components/calibration/FitProvenance.svelte';
	import Disclaimer from '$lib/components/liability/Disclaimer.svelte';
	import SignoffSection from '$lib/components/liability/SignoffSection.svelte';
	import ValidationStatement from '$lib/components/liability/ValidationStatement.svelte';
	import { effectiveSettings, monthlyRows, settingsRows, type RunSettings } from '$lib/components/report/inputs';
	import { CLASS_LABEL, describeOp, namesOf, snapshotInput, stepInputs } from '$lib/components/scenarios/ops';
	import { apanDailyOfInput, chirpsSourceOfInput, originOfFit, runChirpsFactors } from '$lib/series/provenance';
	import { WATER_YEAR_MONTHS, monthName } from '$lib/format/months';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import EvidenceSummary from './EvidenceSummary.svelte';
	import FdcPlot from './FdcPlot.svelte';
	import IntervalPlot from './IntervalPlot.svelte';
	import UsePlot from '$lib/components/allocations/UsePlot.svelte';
	import { capYearsText, SOURCE_LABEL, STATUS_LABEL, waterYearLabel } from '$lib/components/allocations/allocations';
	import { bandText as useBandText, countsText, m3, partNote, ratioText, unitSourceLabel, useRows } from './registeredUse';
	import ReserveGrids from './ReserveGrids.svelte';
	import { fdcCaption, fdcChangeRows, fdcMonths } from './grid';
	import { bandRange, bandText, changeText, pct, signed, worseText } from './format';
	import { evidenceSections, sectionHeading } from './sections';

	let {
		report,
		projectId,
		stamp,
		frozen = false,
		verify = null,
		signoffs = null,
		signoffTarget = null,
		onsignoffchange
	}: {
		report: EvidenceReport;
		projectId: string;
		/** "Draft · not issued" until a pack issues it (G12); an issued pack's "Issued · version n · date". */
		stamp: string;
		/** An evidence pack's frozen report: a pack from before evidence-5 has no licence impact board in its manifest, so page 1 says so. */
		frozen?: boolean;
		/** An issued pack's manifest hash, short code and verify link, printed in every section (G11); null for a draft. */
		verify?: VerifyRef | null;
		/** The sign-offs of what the report is (B.2): the run's in the preview, the pack's on a pack; null when not loaded. */
		signoffs?: SignoffList | PackSignoffList | null;
		signoffTarget?: SignoffTarget | null;
		onsignoffchange?: (next: SignoffList['signoffs'] | null) => void;
	} = $props();

	const app = $derived(report.mode === 'application');
	const sections = $derived(evidenceSections(report));
	const base = $derived(report.appendix.baselineInputs);
	const settings = $derived(effectiveSettings(base.settings as never) as RunSettings);
	const sum = $derived(report.summaries.baseline);
	const id = $derived(report.identity);

	// Appendix A.2: each op in words, against the input it meets (as the Scenarios tab says it).
	const ops = $derived.by(() => {
		if (!report.ops.length) return [];
		const input: ModelInput = snapshotInput(base.model, base.settings);
		const list = report.ops.map((o) => o.op);
		const before = stepInputs(input, list).before;
		const names = namesOf([base.model], list);
		return report.ops.map((o, i) => ({ index: o.index, cls: o.class, text: describeOp(o.op, before[i] ?? null, names) }));
	});

	/** A site's FDC points for one calendar month, both runs, with each run's 5–95 % band where the report has one (ER5). */
	function fdcPoints(key: string, month: number) {
		const find = (list: EwrAssuranceSite[] | undefined) => (list ?? []).find((s) => (s.nodeId ?? 'outlet') === key);
		const a = find(report.summaries.baseline.ewrAssurance)?.byMonth.find((m) => m.month === month);
		const b = find(report.summaries.application?.ewrAssurance)?.byMonth.find((m) => m.month === month);
		const bands = report.river.find((s) => s.key === key)?.fdcBands?.find((m) => m.month === month) ?? null;
		const range = (bd: Band | null | undefined) => (bd && bd.p5 !== null && bd.p95 !== null ? { lo: bd.p5, hi: bd.p95 } : null);
		return (a?.fdc ?? []).map((p, i) => ({
			point: p.point,
			required: p.required,
			a: p.impacted,
			b: b?.fdc[i]?.impacted ?? null,
			natural: p.natural ?? null,
			bandA: range(bands?.a[i]),
			bandB: range(bands?.b?.[i])
		}));
	}

	/**
	 * Page 1's licence impact by year class (issue #53 R7): the impact report's
	 * board, the baseline as the background and the application beside it.
	 * The engine built its numbers into the document (evidence-5), so a draft
	 * and an issued pack show the same board; application reports only. The
	 * application's period is the baseline's (a report on another period is
	 * refused), so the baseline's first day serves both.
	 */
	const board = $derived.by(() => {
		const appSummary = report.summaries.application;
		if (!app || !appSummary || !id.application || !report.licenceImpact) return null;
		return evidenceBoard(report.licenceImpact, {
			a: { run: { label: id.baseline.label, startDate: id.baseline.startDate, summary: report.summaries.baseline } },
			b: { run: { label: id.application.label, startDate: id.baseline.startDate, summary: appSummary } }
		});
	});
	/** An older pack (before evidence-5) froze no board: page 1 says it isn't part of the pack. */
	const boardNotFrozen = $derived(frozen && app && report.licenceImpact === undefined);

	const cov = $derived(report.uncertainty.baseline?.coverage ?? []);
	const bandsA = $derived(report.uncertainty.baseline?.bands ?? null);
	const paired = $derived(report.uncertainty.paired);
	const al = $derived(report.allocations);
	const cum = $derived(report.cumulative);
	const OUTCOME: Record<string, string> = { approved: 'approved', approved_with_conditions: 'approved with conditions' };
	const statusText = (o: EvidenceReport['cumulative']['applications'][number]) => (o.status === 'decided' ? `decided: ${OUTCOME[o.outcome ?? ''] ?? o.outcome}` : 'submitted');
	const use = $derived(useRows(al));
	/** Page 1's row says why nothing is judged when every year is a part year. */
	const useJudged = $derived(report.rows.find((r) => r.id === 'registeredUse')?.notAssessed ?? null);
	const modeText = (m: keyof typeof ALLOCATION_MODE_LABEL | null) => (m === null ? 'not recorded (a run before engine 1.18.0)' : ALLOCATION_MODE_LABEL[m]);
	const fit = $derived((base.settings as { fitRecord?: Parameters<typeof describeFitRecord>[0] | null }).fitRecord ?? null);
</script>

<article class="evidence" data-testid="evidence-report" data-evidence-mode={report.mode}>
	{#if stamp}
		<!-- G12: a diagonal stamp on every printed page (position: fixed repeats on each page in print); the text stamp in each section head stays the accessible one. -->
		<div class="watermark" aria-hidden="true" data-testid="evidence-watermark">{stamp}</div>
	{/if}
	{#each sections as s (s.id)}
		<section class="ev-sec" id="ev-{s.id}" aria-labelledby="ev-{s.id}-h">
			<div class="run-head">
				{#if s.id === 'summary'}
					<div>
						<p class="eyebrow">Licensing evidence report · surface-water hydrology</p>
						<h1 id="ev-summary-h">{id.title}</h1>
						<p class="muted">{id.project.name}{app ? ' · an application on the nominated baseline' : ' · the nominated baseline on its own'}</p>
					</div>
				{:else}
					<h2 id="ev-{s.id}-h">{sectionHeading(s)}</h2>
				{/if}
				<span class="stamp" data-testid="evidence-stamp">{stamp}</span>
			</div>
			{#if verify}<p class="verify-line" data-testid="evidence-verify-line">{packVerifyLine(verify)}</p>{/if}

			{#if s.id === 'summary'}
				<EvidenceSummary {report} {board} {boardNotFrozen} signoffs={signoffs?.signoffs ?? []} {verify} />
			{:else if s.id === 'river'}
				{#if !report.river.length}
					<p class="na">Not assessed: no EWR site has a Reserve rule table, so Reserve compliance can’t be assessed (G16). Only the pragmatic EWR (page 1) is.</p>
				{/if}
				{#each report.river as site (site.key)}
					<div class="sub-block">
						<h3>Ecological Reserve at {site.name}{site.isOutlet ? ' (the catchment outlet)' : ''}</h3>
						<dl class="kv">
							<div><dt>Rule table</dt><dd>{site.source}<span class="sub">{site.sourceKind} · {site.component} · {site.unit}</span></dd></div>
							<div><dt>Recommended ecological category (REC)</dt>{#if site.category}<dd><span data-testid="evidence-rec">{site.category}</span><span class="sub">from the rule table</span></dd>{:else}<dd class="na" data-testid="evidence-rec">Not given (enter it on the rule table in Settings)</dd>{/if}</div>
							<div><dt>EWR as % of natural MAR</dt><dd>{site.ewrPctNmar === null ? '–' : `${fmtNum(site.ewrPctNmar, 1)} %`}<span class="sub">computed from the run’s natural flow</span></dd></div>
							{#if site.belowTableA || site.belowTableB}
								<div><dt>Months below the table’s driest point</dt><dd>{fmtNum(site.belowTableA)} of {fmtNum(site.monthsA)}{app && site.belowTableB !== null && site.belowTableB !== site.belowTableA ? ` (application ${fmtNum(site.belowTableB)})` : ''}<span class="sub">the requirement is scaled with the flow there, below the table’s driest requirement, so those months are easier to meet (G16){site.belowTableExpectedPct === null ? '' : `; about ${fmtNum(site.belowTableExpectedPct)} % expected with the percentile from the run`}</span></dd></div>
							{/if}
							{#if site.naturalMar}
								<div><dt>Natural MAR, run vs determination</dt><dd>{fmtNum(site.naturalMar.runMcm, 2)} vs {fmtNum(site.naturalMar.tableMcm, 2)} Mm³/a ({signed(site.naturalMar.differencePct, 0)} %)</dd></div>
							{/if}
						</dl>
						<ReserveGrids {site} application={app} />
						<div class="two">
							{#if site.isOutlet && report.byMonth}
								<IntervalPlot
									title="Extra days below the pragmatic EWR at the outlet by month of the year, application minus baseline, paired median and 5 to 95 percent range"
									caption="Extra days below the pragmatic EWR at the outlet, by month of the year (R2), summed over the years."
									rows={report.byMonth.map((m) => ({ label: monthName(m.month), band: m.band, run: m.run }))}
									unit="days"
								/>
							{/if}
							{#each fdcMonths(site, app) as f (f.month)}
								{@const points = fdcPoints(site.key, f.month)}
								{@const moved = app ? fdcChangeRows(site, f.month, points.map((p) => p.point)) : []}
								<div data-testid="evidence-fdc-{f.kind}">
									<FdcPlot
										title="{monthName(f.month)} flow-duration curve at {site.name} against the EWR curve"
										unit={site.unit}
										caption={fdcCaption(site, f, app)}
										{points}
									/>
									{#if moved.length}
										<!-- evidence-7: the paired change in the curve, each kept set on both runs (an older pack's document has none). -->
										<div class="table-wrap">
											<table class="data compact" data-testid="evidence-fdc-change">
												<caption class="small">{monthName(f.month)} curve, paired change (application − baseline, {site.unit})</caption>
												<thead><tr><th scope="col">Flow exceeded</th><th scope="col" class="num">Change: median (5 to 95 %)</th><th scope="col" class="num">Application’s flow lower in</th></tr></thead>
												<tbody>
													{#each moved as row, j (j)}
														<tr><th scope="row">{fmtNum(row.point)} % of the time</th><td class="num">{row.main}{#if row.sub}<span class="sub">{row.sub}</span>{/if}</td><td class="num">{row.worse}</td></tr>
													{/each}
												</tbody>
											</table>
										</div>
									{/if}
								</div>
							{/each}
						</div>
						<div class="table-wrap">
							<table class="data compact">
								<thead><tr><th scope="col">Reserve compliance</th><th scope="col" class="num">Baseline</th>{#if app}<th scope="col" class="num">Application</th>{/if}</tr></thead>
								<tbody>
									<tr><th scope="row">Months met, of {fmtNum(site.monthsA)}</th><td class="num">{pct(site.rateA)}</td>{#if app}<td class="num">{pct(site.rateB)} ({site.lost} lost, {site.gained} gained)</td>{/if}</tr>
									<tr><th scope="row">Longest run of months not met</th><td class="num">{fmtNum(site.longestA)}</td>{#if app}<td class="num">{site.longestB === null ? '–' : fmtNum(site.longestB)}</td>{/if}</tr>
									{#each site.byMonth as m (m.month)}
										<tr><th scope="row">{monthName(m.month)}: years met, of {m.years}</th><td class="num">{m.metA}</td>{#if app}<td class="num">{m.metB ?? '–'}</td>{/if}</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/each}
				{#if app}
					{@const charge = report.summaries.application?.curtailment}
					<h3>The application’s EWR charge (C16)</h3>
					{#if charge?.ewrAttribution}
						<p class="small">
							Rule: {charge.ewrAttribution === 'netImpactProRata' ? 'net impact pro rata at each EWR site' : charge.ewrAttribution} (model.md §2.7b). The applicant’s own units are
							charged {fmtNum((charge.farms ?? []).filter((f) => report.users.find((u) => u.nodeId === f.nodeId)?.own).reduce((a, f) => a + f.ewrShortfallM3Day, 0))} m³/day on average over the reporting window.
						</p>
					{:else}
						<p class="na">Not assessed: the application run records no attribution rule.</p>
					{/if}
				{/if}
			{:else if s.id === 'uncertainty'}
				{#if report.uncertainty.coverageWarning}
					<p class="banner-amber" role="note">
						The bands are too narrow to trust: {cov.filter((c) => c.warning).map((c) => `${pct(c.fraction, 0)} of ${fmtNum(c.heldOutDays)} held-out days`).join(', ')} fall inside them. Read every band on
						this page as a lower bound.
					</p>
				{/if}
				<dl class="kv">
					<div><dt>Declared rule (Settings › Evidence)</dt><dd>{report.uncertainty.declared ? declaredRuleText(report.uncertainty.declared) : 'Not declared'}</dd></div>
					<div>
						<dt>Cited ensemble</dt>
						<dd>
							{#if report.uncertainty.cited}
								{report.uncertainty.cited.id.slice(0, 8)}, started {fmtDate(report.uncertainty.cited.createdAt)}{report.uncertainty.cited.createdBy ? ` by ${report.uncertainty.cited.createdBy}` : ''}
								<span class="sub">The first complete ensemble on the declared rule; seed {report.uncertainty.cited.seed}, drawn by the database</span>
							{:else}<span class="na">None</span>{/if}
						</dd>
					</div>
				</dl>
				<h3>Every ensemble started on the baseline ({report.uncertainty.ledger.length})</h3>
				{#if report.uncertainty.ledger.length}
					<div class="table-wrap">
						<table class="data compact" data-testid="evidence-ledger">
							<thead><tr><th scope="col">Ensemble</th><th scope="col">Started</th><th scope="col">Status</th><th scope="col" class="num">Kept</th><th scope="col">Against the declared rule</th></tr></thead>
							<tbody>
								{#each report.uncertainty.ledger as e (e.id)}
									<tr>
										<th scope="row">{e.id.slice(0, 8)}{e.cited ? ' (cited)' : ''}</th>
										<td>{fmtDate(e.createdAt)}{e.createdBy ? `, ${e.createdBy}` : ''}</td>
										<td>{e.status === 'complete' ? 'complete' : 'started, not completed: no result stored'}</td>
										<td class="num">{e.accepted === null ? '–' : `${fmtNum(e.accepted)} of ${fmtNum(e.members + 1)}`}</td>
										<td>{!report.uncertainty.declared ? 'no rule declared' : e.departsFromDeclared.length ? e.departsFromDeclared.map((d) => `${d.label}: ${d.b} (rule ${d.a})`).join('; ') : 'follows it'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if report.uncertainty.ledger.some((e) => e.status === 'started')}
						<p class="small muted" data-testid="evidence-ledger-started">
							A start not completed was cancelled, abandoned or is still running. The app keeps nothing of it but who started it, when, and its rule: the
							browser runs the ensemble and stores the result only when every set has run, so what a cancelled start had shown can’t be printed.
						</p>
					{/if}
				{:else}
					<p class="na">No ensemble has been started on the baseline.</p>
				{/if}
				<h3>The baseline on its own (R1)</h3>
				{#if bandsA}
					<div class="table-wrap">
						<table class="data compact">
							<thead><tr><th scope="col">Measure</th><th scope="col" class="num">The run</th><th scope="col" class="num">5 – 50 – 95 %</th></tr></thead>
							<tbody>
								<tr><th scope="row">Days below the pragmatic EWR</th><td class="num">{fmtNum(report.uncertainty.baseline?.reference?.ewrDaysNotMet)}</td><td class="num">{bandRange(bandsA.ewrDaysNotMet, 0)}</td></tr>
								<tr><th scope="row">Shortfall against the EWR (Mm³)</th><td class="num">{fmtNum(report.uncertainty.baseline?.reference?.shortfallMm3, 2)}</td><td class="num">{bandRange(bandsA.shortfallMm3, 2)}</td></tr>
								<tr><th scope="row">No-flow days at the outlet</th><td class="num">{fmtNum(report.uncertainty.baseline?.reference?.noFlowDays)}</td><td class="num">{bandsA.noFlowDays ? bandRange(bandsA.noFlowDays, 0) : `no band (an ensemble from before engine ${ENSEMBLE_MEASURES_SINCE})`}</td></tr>
								<tr><th scope="row">Natural MAR (Mm³/a)</th><td class="num">{fmtNum(report.uncertainty.baseline?.reference?.marNaturalMm3, 3)}</td><td class="num">{bandRange(bandsA.marNaturalMm3, 3)}</td></tr>
								<tr><th scope="row">Outflow MAR (Mm³/a)</th><td class="num">{fmtNum(report.uncertainty.baseline?.reference?.marOutflowMm3, 3)}</td><td class="num">{bandRange(bandsA.marOutflowMm3, 3)}</td></tr>
								{#each bandsA.reserve as r (r.key)}
									<tr><th scope="row">Reserve months met, {r.name} (%)</th><td class="num">{pct(report.uncertainty.baseline?.reference?.reserveRate[r.key] ?? null)}</td><td class="num">{bandRange(r.band && { ...r.band, p5: r.band.p5 === null ? null : r.band.p5 * 100, p50: r.band.p50 === null ? null : r.band.p50 * 100, p95: r.band.p95 === null ? null : r.band.p95 * 100 }, 1)}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if !report.uncertainty.baseline?.referenceAccepted}<p class="flag-red">The nominated run fails its own rule: it is not among the kept parameter sets.</p>{/if}
				{:else}
					<p class="na">No band: no ensemble on the declared rule is cited.</p>
				{/if}
				{#if app}
					<h3>The application’s own impact, paired (R2)</h3>
					{#if paired}
						<div class="table-wrap">
							<table class="data compact">
								<thead><tr><th scope="col">Change, application − baseline</th><th scope="col" class="num">Paired band</th><th scope="col" class="num">Worse in</th></tr></thead>
								<tbody>
									<tr><th scope="row">Days below the pragmatic EWR</th><td class="num">{bandText(paired.ewrDaysNotMet, 0)}</td><td class="num">{worseText({ run: null, band: null, bandNote: null, worse: paired.ewrDaysNotMetWorse === null ? null : { k: Math.round(paired.ewrDaysNotMetWorse * paired.members), n: paired.members } })}</td></tr>
									<tr><th scope="row">Shortfall against the EWR (Mm³)</th><td class="num">{bandText(paired.shortfallMm3, 2)}</td><td class="num">{worseText({ run: null, band: null, bandNote: null, worse: paired.shortfallWorse === null ? null : { k: Math.round(paired.shortfallWorse * paired.members), n: paired.members } })}</td></tr>
									<tr><th scope="row">Outflow MAR (Mm³/a)</th><td class="num">{bandText(paired.marOutflowMm3, 3)}</td><td class="num">—</td></tr>
									{#each report.rows.filter((r) => r.id === 'noFlowDays' || r.id === 'applicantSupply') as r (r.id)}
										<tr><th scope="row">{r.label}{r.unit.startsWith('%') ? ' (pp)' : ''}</th><td class="num">{changeText(r, r.change).main}{#if changeText(r, r.change).sub}<span class="sub">{changeText(r, r.change).sub}</span>{/if}</td><td class="num">{worseText(r.change)}</td></tr>
									{/each}
									{#each paired.reserve as r (r.key)}
										<tr><th scope="row">Reserve months met, {r.name} (pp)</th><td class="num">{bandText(r.band && { ...r.band, p5: r.band.p5 === null ? null : r.band.p5 * 100, p50: r.band.p50 === null ? null : r.band.p50 * 100, p95: r.band.p95 === null ? null : r.band.p95 * 100 }, 1)}</td><td class="num">{worseText({ run: null, band: null, bandNote: null, worse: r.worse === null || r.worse === undefined ? null : { k: Math.round(r.worse * paired.members), n: paired.members } })}</td></tr>
									{/each}
									{#each paired.curtailment as f (f.nodeId)}
										<tr><th scope="row">Curtailment, {f.name} (m³/day)</th><td class="num">{bandText(f.band, 0)}</td><td class="num">—</td></tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else}
						<p class="na">No paired band: every change on page 1 is the run’s own difference.</p>
					{/if}
				{/if}
				<div class="rule-box">
					<p><strong>R1</strong> {report.rules.r1 ?? 'No ensemble is cited.'}</p>
					{#if app}<p><strong>R2</strong> {report.rules.r2 ?? 'No paired band.'}</p>{/if}
					<p class="small muted">{report.rules.footnote}</p>
				</div>
			{:else if s.id === 'credibility'}
				<h3>Calibration record</h3>
				<CalibrationPanel calibration={sum.calibration} requestedStart={settings.calibrationStart ?? null} requestedEnd={settings.calibrationEnd ?? null} />
				<h3>Validation</h3>
				{#if fit}
					<p class="small">Parameters from the {describeFitRecord(fit)}.</p>
					<FitProvenance
						record={base.settings.fitRecord as never}
						settings={base.settings as never}
						chirpsSource={chirpsSourceOfInput(base.series)}
						apanDaily={apanDailyOfInput(base.series)}
						chirpsFactors={runChirpsFactors(sum)}
						observedOrigin={originOfFit(base.series, fit as { flowKind?: string; siteNodeId?: string | null })}
					/>
				{:else}
					<p class="na">Not assessed: the parameters don’t come from a stored automatic fit, so there are no split-sample or dry → wet scores (C6).</p>
				{/if}
				<h3>WR2012 comparison</h3>
				{#if sum.wr2012}
					<dl class="kv">
						<div><dt>Flag</dt><dd>{sum.wr2012.flag.level}{sum.wr2012.flag.deviationPct === null ? '' : `, natural MAR ${signed(sum.wr2012.flag.deviationPct, 0)} % against the scaled reference`}</dd></div>
						<div><dt>Quaternary</dt><dd>{sum.wr2012.quaternary}<span class="sub">{sum.wr2012.source}</span></dd></div>
						<div><dt>MAR, run vs scaled WR2012</dt><dd>{fmtNum(sum.wr2012.whole.simulatedMarMm3, 3)} vs {fmtNum(sum.wr2012.scaledMarMm3, 3)} Mm³/a</dd></div>
						<div><dt>Dry-season flow ratio</dt><dd>{sum.wr2012.lowFlowRatio === null ? '–' : fmtNum(sum.wr2012.lowFlowRatio, 2)}</dd></div>
						<div><dt>Monthly pattern correlation</dt><dd>{sum.wr2012.patternCorrelation === null ? '–' : fmtNum(sum.wr2012.patternCorrelation, 2)}</dd></div>
					</dl>
					{#if sum.wr2012.flag.text}<p class="small">{sum.wr2012.flag.text}</p>{/if}
				{:else}
					<p class="na">Not assessed: the project has no WR2012 reference.</p>
				{/if}
				{#if !sum.calibration?.wr2012Fit}
					<p class="na">WR2012 five-statistic table (MAR, mean of logs, SD, log SD, seasonal index): not assessed for this run (no WR2012 reference, no complete water year, or a run from before engine 1.19.0). When there is one, the calibration record above shows it (CR-28).</p>
				{/if}
				<h3>Validation statement, data quality and limitations</h3>
				<ValidationStatement summary={sum} engineVersion={id.baseline.engineVersion} legacy={id.baseline.runoffModel === 'legacy'} fitEngineVersion={(fit as { engineVersion?: string } | null)?.engineVersion ?? null} headingLevel={4} />
				<h3>Nomination history</h3>
				<div class="table-wrap">
					<table class="data compact" data-testid="evidence-nominations">
						<thead><tr><th scope="col">When</th><th scope="col">Run</th><th scope="col">By</th><th scope="col">Reason</th></tr></thead>
						<tbody>
							{#each report.credibility.nominations as n, i (i)}
								<tr>
									<th scope="row">{fmtDate(n.nominatedAt)}</th>
									<td>{n.withdrawn ? 'Withdrawn' : `${n.runLabel || 'unlabelled run'}${n.runId === id.baseline.runId ? ' (this baseline)' : ''}`}</td>
									<td>{n.nominatedBy ?? '–'}</td>
									<td>{n.reason}</td>
								</tr>
							{:else}
								<tr><td colspan="4" class="na">No run of this project has been nominated.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if s.id === 'users'}
				<div class="table-wrap">
					<table class="data compact" data-testid="evidence-users">
						<thead>
							<tr>
								<th scope="col">Unit</th>
								<th scope="col" class="num">Supply, baseline</th>
								{#if app}<th scope="col" class="num">Application</th><th scope="col" class="num">Change (R2)<span class="sub">median, 5–95 %</span></th><th scope="col" class="num">Worse in</th>{/if}
								<th scope="col" class="num">Days fully met{app ? ', baseline → application' : ''}</th>
								<th scope="col" class="num">Years met{app ? ', baseline → application' : ''}</th>
							</tr>
						</thead>
						<tbody>
							{#each report.users as u (u.nodeId)}
								<tr>
									<th scope="row">{u.name}{u.own ? ' (the applicant’s)' : ''}{u.onlyIn === 'application' ? ' (added)' : u.onlyIn === 'baseline' ? ' (removed)' : ''}</th>
									<td class="num">{pct(u.suppliedA)}</td>
									{#if app}
										<td class="num">{pct(u.suppliedB)}</td>
										{@const c = changeText({ unit: '% of demand' }, u.change)}
										<td class="num" class:na={!c.banded}>{c.main}{#if c.sub}<span class="sub">{c.sub}</span>{/if}</td>
										<td class="num">{worseText(u.change)}</td>
									{/if}
									<td class="num">{pct(u.timeReliabilityA)}{app ? ` → ${pct(u.timeReliabilityB)}` : ''}</td>
									<td class="num">{pct(u.annualReliabilityA)}{app ? ` → ${pct(u.annualReliabilityB)}` : ''}</td>
								</tr>
							{:else}
								<tr><td colspan={app ? 7 : 4} class="na">The network has no unit with demand.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="small muted">Supply is the share of demand supplied over the whole run; days and years fully met are over the reporting window (assurance of supply, model.md §2.11a). The change is the paired band on each unit’s share supplied (R2), with the run’s own difference.</p>
				<h3>Served in full while an EWR site below fails</h3>
				{#if report.servedWhileFailing.notAssessed}
					<p class="na" data-testid="evidence-served-na">{report.servedWhileFailing.notAssessed}</p>
				{:else}
					<p class="small muted">
						Days a farm or water user got its whole demand while an EWR site below it was not met, every day of the run: the river’s shortfall on those days was not shared with them. Each
						site is judged on the daily requirement its EWR charge follows.
					</p>
					{#each report.servedWhileFailing.sites as site (site.key)}
						<div class="table-wrap">
							<table class="data compact" data-testid="evidence-served">
								<caption class="small">
									{site.isOutlet ? `${site.name} (the catchment outlet)` : site.name}: {site.basis}, not met on {fmtNum(site.daysNotMetA)} days{app ? ` → ${site.daysNotMetB === null ? '–' : fmtNum(site.daysNotMetB)}` : ''}
								</caption>
								<thead><tr><th scope="col">Unit upstream</th><th scope="col" class="num">Days served in full, baseline</th>{#if app}<th scope="col" class="num">Application</th>{/if}</tr></thead>
								<tbody>
									{#each site.units as u (u.nodeId)}
										<tr>
											<th scope="row">{u.name}{u.own ? ' (the applicant’s)' : ''}</th>
											<td class="num">{u.daysA === null ? '–' : fmtNum(u.daysA)}</td>
											{#if app}<td class="num">{u.daysB === null ? '–' : fmtNum(u.daysB)}</td>{/if}
										</tr>
									{:else}
										<tr><td colspan={app ? 3 : 2} class="na">No unit with demand upstream of this site.</td></tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/each}
				{/if}
				<h3>Other applications on this baseline</h3>
				<p class="small">
					Each other application that is submitted, or decided with approval, with its newest run of its ops on this baseline: its own change against
					the baseline at the outlet, and their sum. A sum of separate runs, not one combined run: two applications drawing on the same water can
					together take less than the sum says, or push the river further. A combined run of every application is WP-3.11. The sum counts the runs on
					the baseline’s engine, period and runoff model; any other difference is the application’s own changes. Listed as the reader
					can see them: a submitted application is visible to the project’s editors only. Drafts are never listed.
				</p>
				{#if cum.applications.length}
					{#if cum.truncated}
						<p class="na" data-testid="evidence-cumulative-cut">
							More than {cum.applications.length} other applications have runs on this baseline: the newest {cum.applications.length} are listed, and nothing
							is summed, since a sum of part of them would understate it.
						</p>
					{/if}
					<div class="table-wrap">
						<table class="data compact" data-testid="evidence-cumulative">
							<thead>
								<tr>
									<th scope="col">Application</th>
									<th scope="col">Status</th>
									<th scope="col" class="num">Days below the pragmatic EWR, change</th>
									<th scope="col" class="num">Reserve months met at the outlet, change</th>
								</tr>
							</thead>
							<tbody>
								{#each cum.applications as o (o.scenarioId)}
									<tr>
										<th scope="row">“{o.scenarioName}”<span class="sub">run {fmtDate(o.runCreatedAt)}</span></th>
										<td>{statusText(o)}{#if o.reason}<span class="sub">{o.reason}</span>{/if}</td>
										<td class="num">{o.ewrDays === null ? '–' : `${signed(o.ewrDays, 0)} days`}</td>
										<td class="num">{o.reservePp === null ? '–' : `${signed(o.reservePp, 1)} pp`}</td>
									</tr>
								{/each}
							</tbody>
							<tfoot>
								<tr class="total">
									<th scope="row">{cum.truncated ? 'Not summed: the list is cut' : `Sum of the ${cum.counted} counted`}</th>
									<td></td>
									<td class="num">{cum.total.ewrDays === null ? '–' : `${signed(cum.total.ewrDays, 0)} days`}</td>
									<td class="num">{cum.total.reservePp === null ? '–' : `${signed(cum.total.reservePp, 1)} pp`}</td>
								</tr>
								{#if cum.withThis}
									<tr class="total">
										<th scope="row">With this application</th>
										<td></td>
										<td class="num">{cum.withThis.ewrDays === null ? '–' : `${signed(cum.withThis.ewrDays, 0)} days`}</td>
										<td class="num">{cum.withThis.reservePp === null ? '–' : `${signed(cum.withThis.reservePp, 1)} pp`}</td>
									</tr>
								{/if}
							</tfoot>
						</table>
					</div>
				{:else}
					<p class="na" data-testid="evidence-cumulative-none">None: no other submitted or approved application has a run of its ops on this baseline visible to the account that built this report.</p>
				{/if}
			{:else if s.id === 'allocations'}
				{#if al.notAssessed}
					<p class="na" data-testid="evidence-allocations-na">{al.notAssessed}</p>
				{:else}
					<dl class="kv">
						<div><dt>Allocation mode</dt><dd>{modeText(al.modeA)}{app && al.modeB !== al.modeA ? ` (baseline); ${modeText(al.modeB)} (application)` : ''}</dd></div>
						<div><dt>Counted as within</dt><dd>{useBandText(al.toleranceA ?? al.toleranceB)} of the registered volume{app && al.toleranceA !== null && al.toleranceB !== null && al.toleranceA !== al.toleranceB ? ` (baseline); ${useBandText(al.toleranceB)} (application)` : ''}</dd></div>
						<div><dt>Registered volumes on no unit of the run{app ? 's' : ''}</dt><dd>{al.notMatchedA}{app && al.notMatchedB !== null && al.notMatchedB !== al.notMatchedA ? ` (application ${al.notMatchedB})` : ''}<span class="sub">counted, not compared</span></dd></div>
					</dl>
					<p class="small muted">
						Modelled use per water year against the volume registered for each unit (WARMS registrations, licences), over whole water years; a part year is listed but not counted.
						Modelled, not metered: the comparison is arithmetic, not a finding on whether a use is lawful. The report carries volumes only, never the holders’ names.
					</p>
					{#if useJudged}<p class="na">{useJudged}</p>{/if}
					{#if use.rows.some((r) => r.marks.length)}
						<UsePlot
							rows={use.rows}
							axisMax={use.axisMax}
							tolerance={al.toleranceA ?? al.toleranceB}
							toleranceApplication={al.toleranceB ?? al.toleranceA}
							application={app}
							title="Modelled use as a share of the registered volume, per unit and water source, each whole water year{app ? ', baseline and application' : ''}"
							caption="Over and under use of the registered volumes."
						/>
					{/if}
					<h3>Whole water years against the registered volume</h3>
					<div class="table-wrap">
						<table class="data compact" data-testid="evidence-allocations">
							<thead>
								<tr>
									<th scope="col">Unit and source</th>
									<th scope="col">Baseline</th>
									{#if app}<th scope="col">Application</th>{/if}
									<th scope="col" class="num">Mean registered (m³/a)</th>
									<th scope="col" class="num">Mean modelled, baseline (m³/a)</th>
									{#if app}<th scope="col" class="num">Mean modelled, application (m³/a)</th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each al.units as u (u.nodeId)}
									{#each u.sources as src (src.waterSource)}
										<tr>
											<th scope="row">{unitSourceLabel(u, src)}{u.onlyIn === 'application' ? ' (added)' : u.onlyIn === 'baseline' ? ' (removed)' : ''}</th>
											<td>{countsText(src.countsA)}</td>
											{#if app}<td>{countsText(src.countsB)}</td>{/if}
											<td class="num">{m3(src.meanRegisteredA ?? src.meanRegisteredB)}{#if app && src.meanRegisteredA !== null && src.meanRegisteredB !== null && Math.abs(src.meanRegisteredA - src.meanRegisteredB) > 0.5}<span class="sub">application {m3(src.meanRegisteredB)}</span>{/if}</td>
											<td class="num">{m3(src.meanModelledA)}</td>
											{#if app}<td class="num">{m3(src.meanModelledB)}</td>{/if}
										</tr>
									{/each}
								{/each}
							</tbody>
						</table>
					</div>
					<h3>By water year</h3>
					<div class="table-wrap">
						<table class="data compact" data-testid="evidence-allocation-years">
							<thead>
								<tr>
									<th scope="col">Unit and source</th>
									<th scope="col">Water year</th>
									<th scope="col" class="num">Registered (m³)</th>
									<th scope="col" class="num">Modelled, baseline (m³)</th>
									{#if app}<th scope="col" class="num">Modelled, application (m³)</th>{/if}
									<th scope="col">Against the registered volume{app ? ', baseline → application' : ''}</th>
								</tr>
							</thead>
							<tbody>
								{#each al.units as u (u.nodeId)}
									{#each u.sources as src (src.waterSource)}
										{#each src.years as y (y.waterYear)}
											<tr>
												<th scope="row">{u.name}<span class="sub">{SOURCE_LABEL[src.waterSource]}</span></th>
												<td class="nowrap">{waterYearLabel(y.waterYear)}{#if partNote(y, app)}<span class="sub">{partNote(y, app)}</span>{/if}</td>
												<td class="num">{m3(y.registeredA ?? y.registeredB)}{#if app && y.registeredA !== null && y.registeredB !== null && Math.abs(y.registeredA - y.registeredB) > 0.5}<span class="sub">application {m3(y.registeredB)}</span>{/if}</td>
												<td class="num">{m3(y.modelledA)}<span class="sub">{ratioText(y.modelledA, y.registeredA)}</span></td>
												{#if app}<td class="num">{m3(y.modelledB)}<span class="sub">{ratioText(y.modelledB, y.registeredB)}</span></td>{/if}
												<td>{y.statusA ? STATUS_LABEL[y.statusA] : '–'}{app ? ` → ${y.statusB ? STATUS_LABEL[y.statusB] : '–'}` : ''}</td>
											</tr>
										{/each}
									{/each}
								{/each}
							</tbody>
						</table>
					</div>
					{#if al.units.some((u) => u.sources.some((x) => x.capA || x.capB))}
						<!-- evidence-6: a capped run's cap, per unit and source (RunSummary.allocations); an older pack's document has none. -->
						<h3>What the cap held back</h3>
						<p class="small muted">
							A capped run holds each unit’s use to its registered volume and its licence’s months of use and maximum rate. A day counts when the source took all the room
							the licence left it and the unit still went short; it is put to the limit that set the room that day.
						</p>
						<div class="table-wrap">
							<table class="data compact" data-testid="evidence-allocation-cap">
								<thead>
									<tr>
										<th scope="col">Unit and source</th>
										<th scope="col">Baseline</th>
										{#if app}<th scope="col">Application</th>{/if}
									</tr>
								</thead>
								<tbody>
									{#each al.units as u (u.nodeId)}
										{#each u.sources.filter((x) => x.capA || x.capB) as src (src.waterSource)}
											<tr>
												<th scope="row">{unitSourceLabel(u, src)}</th>
												<td>{src.capA ? capYearsText({ nodeId: u.nodeId, waterSource: src.waterSource, ...src.capA }) : 'Not capped'}</td>
												{#if app}<td>{src.capB ? capYearsText({ nodeId: u.nodeId, waterSource: src.waterSource, ...src.capB }) : 'Not capped'}</td>{/if}
											</tr>
										{/each}
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				{/if}
			{:else if s.id === 'appendixInputs'}
				<h3>A.1 Settings that drive the results</h3>
				<dl class="kv">
					{#each settingsRows(settings, { startDate: id.baseline.startDate, endDate: id.baseline.endDate }) as [k, v] (k)}<div><dt>{k}</dt><dd>{v}</dd></div>{/each}
					<div><dt>Declared uncertainty rule</dt><dd>{declaredRuleText(report.uncertainty.declared)}</dd></div>
					<div><dt>EWR rule tables</dt><dd>{report.river.length ? report.river.map((s) => `${s.name}: ${s.source}`).join('; ') : 'none'}</dd></div>
				</dl>
				<div class="table-wrap">
					<table class="data compact">
						<caption class="visually-hidden">Monthly settings, October to September</caption>
						<thead><tr><th scope="col">Monthly</th>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr></thead>
						<tbody>{#each monthlyRows(settings) as r (r.label)}<tr><th scope="row">{r.label}</th>{#each r.values as v, j (j)}<td class="num">{v}</td>{/each}</tr>{/each}</tbody>
					</table>
				</div>
				<h3>A.2 What the application changes</h3>
				{#if app}
					<ol class="ops" data-testid="evidence-ops">
						{#each ops as o (o.index)}<li><span class="pill" class:pill-red={o.cls === 'baseline'}>{CLASS_LABEL[o.cls]}</span> {o.text}</li>{/each}
					</ol>
					<p class="small muted">The input diff, application against baseline (every resolved input that differs):</p>
					<ul class="changes">
						{#each report.appendix.changes as c, i (i)}<li>{c.text}</li>{:else}<li class="na">No input differs.</li>{/each}
					</ul>
				{:else}
					<p class="na">None: a baseline-evidence report has no application.</p>
				{/if}
				<h3>A.3 Input series</h3>
				<div class="table-wrap">
					<table class="data compact" data-testid="evidence-series">
						<thead><tr><th scope="col">Run</th><th scope="col">Series</th><th scope="col">First day</th><th scope="col" class="num">Days</th><th scope="col">SHA-256</th></tr></thead>
						<tbody>
							{#each report.appendix.series as x, i (i)}
								<tr><th scope="row">{x.run}</th><td>{x.kind}</td><td>{x.startDate}</td><td class="num">{fmtNum(x.days)}</td><td class="mono hash">{x.sha256 ?? 'not recorded'}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				<h3>A.4 Baseline history since the previous publication</h3>
				{#if report.appendix.history}
					<p class="small">Since the run published {fmtDate(report.appendix.history.since.publishedAt)}{report.appendix.history.truncated ? ' (the oldest changes are left out)' : ''}:</p>
					<ul class="changes">
						{#each report.appendix.history.revisions as rev, i (i)}
							<li>{fmtDate(rev.createdAt)}{rev.actor ? `, ${rev.actor}` : ''}{rev.reason ? ` (“${rev.reason}”)` : ''}: {rev.changes.map((c) => c.text).join('; ') || 'no input changed'}</li>
						{:else}
							<li class="na">No change to the inputs.</li>
						{/each}
					</ul>
				{:else}
					<p class="na">Not assessed: no earlier publication to read the history from.</p>
				{/if}
				<h3>A.5 Run warnings, verbatim</h3>
				<p class="small">Baseline ({report.appendix.warnings.baseline.length}):</p>
				<ul class="changes">{#each report.appendix.warnings.baseline as w, i (i)}<li>{w}</li>{:else}<li class="na">None.</li>{/each}</ul>
				{#if report.appendix.warnings.application}
					<p class="small">Application ({report.appendix.warnings.application.length}):</p>
					<ul class="changes">{#each report.appendix.warnings.application as w, i (i)}<li>{w}</li>{:else}<li class="na">None.</li>{/each}</ul>
				{/if}
				<h3>A.6 Every application run on this baseline</h3>
				<ul class="changes" data-testid="evidence-application-runs">
					{#each report.appendix.applicationRuns as r (r.runId)}
						<li>{fmtDate(r.createdAt)}: “{r.scenarioName}”{r.label ? `, ${r.label}` : ''}{r.createdBy ? `, run by ${r.createdBy}` : ''}{r.runId === id.application?.runId ? ' (this report)' : ''}</li>
					{:else}
						<li class="na">None.</li>
					{/each}
				</ul>
			{:else if s.id === 'appendixVerify'}
				<h3>B.1 Methodology, known limitations and errata</h3>
				<p class="small">
					Methods: methodology statement <strong>{report.verification.methodology.version}</strong> (docs/methodology in the app’s source at engine {report.builtBy}),
					SHA-256 <span class="mono hash">{report.verification.methodology.sha256}</span>.
				</p>
				<div class="table-wrap">
					<table class="data compact">
						<thead><tr><th scope="col">Item</th><th scope="col">Known limitation</th><th scope="col">Where it stands</th></tr></thead>
						<tbody>{#each report.verification.limitations as l (l.id)}<tr><th scope="row">{l.id}</th><td>{l.title}</td><td>{l.status}</td></tr>{/each}</tbody>
					</table>
				</div>
				{#if report.verification.errata.length}
					<div class="table-wrap">
						<table class="data compact">
							<thead><tr><th scope="col">Erratum</th><th scope="col">What goes wrong</th><th scope="col">Applies when</th><th scope="col">Fixed in</th></tr></thead>
							<tbody>{#each report.verification.errata as e (e.id)}<tr><th scope="row">{e.id}</th><td>{e.summary}</td><td>{e.appliesWhen}</td><td>{e.fixedIn ?? 'not yet'}</td></tr>{/each}</tbody>
						</table>
					</div>
				{:else}
					<p class="small">Errata: none recorded for these runs’ engines in docs/engine-errata.md.</p>
				{/if}
				<h3>B.2 Sign-off</h3>
				{#if signoffs && signoffTarget}
					<SignoffSection {projectId} target={signoffTarget} list={signoffs} onchange={(n) => onsignoffchange?.(n)} />
				{:else}
					<p class="na">Not signed.</p>
				{/if}
				<h3>B.3 Disclaimer</h3>
				<Disclaimer />
				<h3>B.4 Verify and reproduce</h3>
				{#if verify}
					<dl class="kv" data-testid="evidence-verify">
						<div class="wide"><dt>Manifest SHA-256</dt><dd class="mono hash">{verify.sha256}</dd></div>
						<div><dt>Verify code</dt><dd class="mono">{verify.code}</dd></div>
						<div><dt>Verify page</dt><dd class="mono hash">{verify.url}</dd></div>
					</dl>
					<p class="small">
						The verify page says whether this pack still stands (issued, superseded or withdrawn), who signed it, and checks a copy of its PDF or
						manifest in the browser against the hashes recorded at issue. The manifest SHA-256 is of the manifest’s canonical JSON (RFC 8785).
					</p>
				{:else}
					<p class="na">
						Not issued. An issued evidence pack prints its manifest SHA-256, a short code and a verify link here, in every section and in every
						footer.
					</p>
				{/if}
			{:else if s.id === 'applicantStatement' && report.applicantStatement}
				{@const st = report.applicantStatement}
				<p class="small muted">The applicant’s own words, verbatim: the only free text in this report (G13). Not checked by the app.</p>
				<h3>Description of “{st.scenarioName}”{st.ownerName ? `, by ${st.ownerName}` : ''}</h3>
				{#if st.description.trim()}<p class="verbatim">{st.description}</p>{:else}<p class="na">None given.</p>{/if}
				<h3>Notes on the application run</h3>
				{#if st.notes.trim()}
					<p class="verbatim">{st.notes}</p>
					{#if st.notesUpdatedAt}<p class="small muted">Last changed {fmtDate(st.notesUpdatedAt, true)}{st.notesUpdatedBy ? ` by ${st.notesUpdatedBy}` : ''}.</p>{/if}
				{:else}
					<p class="na">None given.</p>
				{/if}
			{/if}
		</section>
	{/each}
</article>

<style>
	.evidence {
		display: grid;
		/* minmax(0, …): one long cell must not widen the whole report past the window. */
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem;
	}
	.ev-sec {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 1rem 1.1rem;
	}
	.run-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.run-head h1,
	.run-head h2 {
		margin: 0.1rem 0;
	}
	.eyebrow {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.verify-line {
		margin: -0.35rem 0 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.kv .wide {
		grid-column: 1 / -1;
	}
	.stamp {
		flex: none;
		border: 1.5px solid var(--text);
		border-radius: var(--radius-sm);
		padding: 0.1rem 0.45rem;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	h3 {
		margin: 1.1rem 0 0.45rem;
	}
	.sub-block + .sub-block {
		margin-top: 1.25rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0 0 0.9rem;
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
	}
	.sub {
		display: block;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.nowrap {
		white-space: nowrap;
	}
	.na {
		font-style: italic;
		color: var(--text-muted);
	}
	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: 1rem;
		margin: 0.75rem 0;
	}
	.banner-amber {
		border: 1px solid var(--warning);
		background: var(--warning-soft);
		border-radius: var(--radius-sm);
		padding: 0.45rem 0.75rem;
		max-width: 90ch;
	}
	.flag-red {
		border: 1px solid var(--danger);
		background: var(--danger-soft);
		border-radius: var(--radius-sm);
		padding: 0.35rem 0.6rem;
		font-weight: 600;
	}
	.rule-box {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.8rem;
		font-size: 0.85rem;
		margin-top: 0.75rem;
		max-width: 90ch;
	}
	.rule-box p {
		margin: 0.2rem 0;
	}
	.ops,
	.changes {
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.4rem;
		max-width: 90ch;
	}
	.ops li,
	.changes li {
		margin: 0.15rem 0;
	}
	.pill {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		padding: 0 0.45rem;
	}
	.pill-red {
		border-color: var(--danger);
		background: var(--danger-soft);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.hash {
		font-size: 0.72rem;
		word-break: break-all;
	}
	.verbatim {
		white-space: pre-wrap;
		max-width: 80ch;
		border-left: 3px solid var(--border-strong);
		padding-left: 0.75rem;
	}
	.watermark {
		display: none;
	}
	tr.total th,
	tr.total td {
		font-weight: 600;
	}
	tfoot tr:first-child > * {
		border-top: 2px solid var(--border-strong);
	}
	/* The sums stay in view while a long list scrolls in its card. */
	tfoot :is(th, td) {
		position: sticky;
		bottom: 0;
		background: var(--surface);
	}
	@media print {
		tfoot :is(th, td) {
			position: static;
		}
		/* Printed once, after the list, not at the foot of every page. */
		tfoot {
			display: table-row-group;
		}
		.watermark {
			display: block;
			position: fixed;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%) rotate(-35deg);
			white-space: nowrap;
			font-size: 54pt;
			font-weight: 700;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: rgb(0 0 0 / 0.08);
			border: 4pt solid rgb(0 0 0 / 0.08);
			padding: 0.1em 0.4em;
			pointer-events: none;
			z-index: 10;
		}
		.evidence {
			display: block;
		}
		.ev-sec {
			break-before: page;
			border: 0;
			padding: 0;
			background: none;
		}
		.ev-sec:first-of-type {
			break-before: auto;
		}
		.stamp {
			font-size: 7pt;
		}
	}
</style>
