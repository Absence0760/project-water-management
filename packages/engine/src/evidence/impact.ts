// Page 1's licence impact by year class (issue #53 R7, evidence-5): the
// impact report's board, the baseline as the background and the application
// beside it (views/licenceImpact.ts). Built here, from the three stored daily
// series the backend loads, so the document (and an issued pack's manifest)
// carries the numbers instead of the browser computing them from live
// series. The words stay the page's (frontend report/licenceImpact.ts).
import type { RunSeries, RunSummary } from '../project';
import { licenceImpactByYearClass, type LicenceImpactRun } from '../views/licenceImpact';
import type { EvidenceImpactInput, EvidenceLicenceImpact, EvidenceLicenceImpactUnavailable, EvidenceRunInput } from './types';

/** Stored values (JSON has no NaN) back to the engine's NaN, as a catchment series. */
const toRunSeries = (key: string, values: readonly (number | null)[] | null | undefined): RunSeries[] =>
	values ? [{ nodeId: null, key, label: key, unit: 'm³/day', values: values.map((v) => (v === null ? Number.NaN : v)) }] : [];

/** Why licenceImpactByYearClass threw, as a reason the page can word. */
function reasonOf(message: string): EvidenceLicenceImpactUnavailable {
	if (/water account/.test(message)) return 'noWaterAccount';
	if (/ewr_shortfall/.test(message)) return 'noEwrShortfall';
	return 'failed';
}

/** One run as the board reads it: its first day, its summary, and the catchment series the board needs (stored values, null = NaN). */
export interface ImpactBoardRun {
	startDate: string;
	summary: RunSummary;
	/** The background run's natural flow (absent for the application). */
	natural?: readonly (number | null)[] | null;
	ewrShortfall: readonly (number | null)[] | null;
}

/**
 * The board for any background and application pair (issue #53 R7; and
 * since licensing build item 8, a full-allocation pair, evidence/authorised.ts):
 * the requested site when both runs have its rule table, else the outlet,
 * said so; or why it can't be built. `nameOf` names a node in the
 * background's model.
 */
export function licenceImpactBoard(
	background: ImpactBoardRun,
	application: ImpactBoardRun,
	o: { yearClassMethod: EvidenceImpactInput['yearClassMethod']; siteNodeId: string | null; nameOf: (id: string) => string | null }
): EvidenceLicenceImpact {
	const requested = o.siteNodeId;
	const common = { yearClassMethod: o.yearClassMethod ?? 'auto', requestedSite: requested === null ? null : { nodeId: requested, name: o.nameOf(requested) } } as const;
	const unavailable = (reason: EvidenceLicenceImpactUnavailable, detail: string | null = null): EvidenceLicenceImpact => ({
		...common,
		site: null,
		siteFellBack: false,
		result: { status: 'unavailable', reason, detail }
	});
	if (!background.natural) return unavailable('noNaturalFlow');
	const has = (r: ImpactBoardRun, nodeId: string) => !!r.summary.ewrAssurance?.some((x) => x.nodeId === nodeId);
	// A gauge needs its rule table in both runs; otherwise the outlet, said so (never the outlet's numbers in the gauge's name).
	const gauge = requested !== null && has(background, requested) && has(application, requested) ? requested : null;
	const run = (r: ImpactBoardRun, series: RunSeries[]): LicenceImpactRun => ({ startDate: r.startDate, summary: r.summary, series });
	try {
		const impact = licenceImpactByYearClass({
			background: run(background, [...toRunSeries('natural_flow', background.natural), ...toRunSeries('ewr_shortfall', background.ewrShortfall ?? null)]),
			application: run(application, toRunSeries('ewr_shortfall', application.ewrShortfall ?? null)),
			siteNodeId: gauge,
			yearClassMethod: o.yearClassMethod
		});
		return { ...common, site: gauge === null ? null : { nodeId: gauge, name: o.nameOf(gauge) ?? gauge }, siteFellBack: requested !== null && gauge === null, result: { status: 'ok', impact } };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const reason = reasonOf(message);
		return unavailable(reason, reason === 'failed' ? message : null);
	}
}

/**
 * The board for an application report; null for baseline evidence. The
 * application's period is the baseline's (a report on another period is
 * refused), so each run keeps its own first day and they agree.
 */
export function licenceImpactSection(baseline: EvidenceRunInput, application: EvidenceRunInput | null, input: EvidenceImpactInput | null | undefined): EvidenceLicenceImpact | null {
	if (!application) return null;
	const nameOf = (id: string) => baseline.inputs.model.nodes.find((n) => n.id === id)?.name ?? null;
	if (!input) {
		const requested = null;
		return { yearClassMethod: 'auto', requestedSite: requested, site: null, siteFellBack: false, result: { status: 'unavailable', reason: 'notBuilt', detail: null } };
	}
	return licenceImpactBoard(
		{ startDate: baseline.startDate, summary: baseline.summary, natural: input.series.backgroundNatural, ewrShortfall: input.series.backgroundEwrShortfall },
		{ startDate: application.startDate, summary: application.summary, ewrShortfall: input.series.applicationEwrShortfall },
		{ yearClassMethod: input.yearClassMethod, siteNodeId: input.siteNodeId ?? null, nameOf }
	);
}
