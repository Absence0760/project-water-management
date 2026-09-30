// Page 1's licence impact by year class (issue #53 R7, evidence-5): the
// impact report's board, the baseline as the background and the application
// beside it (views/licenceImpact.ts). Built here, from the three stored daily
// series the backend loads, so the document (and an issued pack's manifest)
// carries the numbers instead of the browser computing them from live
// series. The words stay the page's (frontend report/licenceImpact.ts).
import type { RunSeries } from '../project';
import { licenceImpactByYearClass, type LicenceImpactRun } from '../views/licenceImpact';
import type { EvidenceImpactInput, EvidenceLicenceImpact, EvidenceLicenceImpactUnavailable, EvidenceRunInput } from './types';

/** Stored values (JSON has no NaN) back to the engine's NaN, as a catchment series. */
const toRunSeries = (key: string, values: readonly (number | null)[] | null): RunSeries[] =>
	values ? [{ nodeId: null, key, label: key, unit: 'm³/day', values: values.map((v) => (v === null ? Number.NaN : v)) }] : [];

const hasSite = (run: EvidenceRunInput, nodeId: string) => !!run.summary.ewrAssurance?.some((x) => x.nodeId === nodeId);

/** Why licenceImpactByYearClass threw, as a reason the page can word. */
function reasonOf(message: string): EvidenceLicenceImpactUnavailable {
	if (/water account/.test(message)) return 'noWaterAccount';
	if (/ewr_shortfall/.test(message)) return 'noEwrShortfall';
	return 'failed';
}

/**
 * The board for an application report; null for baseline evidence. The
 * application's period is the baseline's (a report on another period is
 * refused), so each run keeps its own first day and they agree.
 */
export function licenceImpactSection(baseline: EvidenceRunInput, application: EvidenceRunInput | null, input: EvidenceImpactInput | null | undefined): EvidenceLicenceImpact | null {
	if (!application) return null;
	const requested = input?.siteNodeId ?? null;
	const nameOf = (id: string) => baseline.inputs.model.nodes.find((n) => n.id === id)?.name ?? null;
	const common = { yearClassMethod: input?.yearClassMethod ?? 'auto', requestedSite: requested === null ? null : { nodeId: requested, name: nameOf(requested) } } as const;
	const unavailable = (reason: EvidenceLicenceImpactUnavailable, detail: string | null = null): EvidenceLicenceImpact => ({
		...common,
		site: null,
		siteFellBack: false,
		result: { status: 'unavailable', reason, detail }
	});
	if (!input) return unavailable('notBuilt');
	if (!input.series.backgroundNatural) return unavailable('noNaturalFlow');
	// A gauge needs its rule table in both runs; otherwise the outlet, said so (never the outlet's numbers in the gauge's name).
	const gauge = requested !== null && hasSite(baseline, requested) && hasSite(application, requested) ? requested : null;
	const run = (r: EvidenceRunInput, series: RunSeries[]): LicenceImpactRun => ({ startDate: r.startDate, summary: r.summary, series });
	try {
		const impact = licenceImpactByYearClass({
			background: run(baseline, [...toRunSeries('natural_flow', input.series.backgroundNatural), ...toRunSeries('ewr_shortfall', input.series.backgroundEwrShortfall)]),
			application: run(application, toRunSeries('ewr_shortfall', input.series.applicationEwrShortfall)),
			siteNodeId: gauge,
			yearClassMethod: input.yearClassMethod
		});
		return { ...common, site: gauge === null ? null : { nodeId: gauge, name: nameOf(gauge) ?? gauge }, siteFellBack: requested !== null && gauge === null, result: { status: 'ok', impact } };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const reason = reasonOf(message);
		return unavailable(reason, reason === 'failed' ? message : null);
	}
}
