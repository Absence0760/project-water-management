// Every word on the /share page's scenario view (WP-3.15, docs/ui.md § Share
// page): a submitted or decided application for someone outside the project
// (an NGO, a catchment forum), as pure functions of POST /share/scenario's
// answer. The page lays these out; scenario.test.ts pins them.
//
// The EWR at each site comes first, the baseline against the application,
// then what the application changes, a baseline assumption flagged in red
// (gaming resistance item 2: it changes the shared baseline, not the
// applicant's own proposal), then the catchment's totals when the API sends
// them (5 or more hydrological units), then the public comments. No other
// unit is named: the API names only the application's own nodes.
import { classifyOp, type OpClass, type ScenarioOp } from '@water-management/engine';
import type { SharedDecisionEvent, SharedEwrSite, SharedRun, SharedTerms, ShareScenario } from '#lib/api/types.js';
import { count, fmtDay, fmtM3Day, fmtNumber, fmtPct, fmtStampDay, MONTHS } from '#lib/components/farm/format.js';
import { plural, t } from '#lib/i18n/locale.svelte.js';

// i18n-section: share.scenario

/** The link's kind from the URL's fragment (`k=scenario`, `k=pack`); null: the catchment view. */
export function readShareKind(hash: string): 'scenario' | 'pack' | null {
	const k = new URLSearchParams(hash.replace(/^#/, '')).get('k');
	return k === 'scenario' || k === 'pack' ? k : null;
}

export type EwrTrend = 'same' | 'better' | 'worse';

export interface EwrSiteRow {
	/** "At the catchment outlet", "At Sandspruit weir". */
	place: string;
	/** "Met in 10 of 12 months (83 %)". */
	base: string;
	withApp: string;
	trend: EwrTrend;
	/** "2 more months below the Reserve with this application." */
	change: string;
}

const siteKey = (s: SharedEwrSite) => (s.isOutlet ? '\u0000outlet' : (s.name ?? ''));

function metText(s: SharedEwrSite | undefined): string {
	if (!s || s.months === null || s.met === null || !s.months) return t('Not assessed');
	return t('Met in {met} of {months} ({pct})', { met: s.met, months: count(MONTHS, s.months), pct: fmtPct(s.rate ?? s.met / s.months) });
}

/** The EWR at each site, the baseline beside the application, outlet first (as the API orders them). */
export function ewrRows(base: SharedRun, run: SharedRun): EwrSiteRow[] {
	const withApp = new Map(run.ewrSites.map((s) => [siteKey(s), s]));
	return base.ewrSites.map((b) => {
		const a = withApp.get(siteKey(b));
		const lost = b.met !== null && a?.met !== null && a?.met !== undefined ? b.met - a.met : 0;
		const trend: EwrTrend = lost > 0 ? 'worse' : lost < 0 ? 'better' : 'same';
		return {
			place: b.isOutlet || !b.name ? t('At the catchment outlet') : t('At {place}', { place: b.name }),
			base: metText(b),
			withApp: metText(a),
			trend,
			change:
				trend === 'worse'
					? t('{months} more below the Reserve with this application.', { months: count(MONTHS, lost) })
					: trend === 'better'
						? t('{months} fewer below the Reserve with this application.', { months: count(MONTHS, -lost) })
						: t('No change in the months the Reserve is met.')
		};
	});
}

/** The catchment line: days the EWR wasn't met, baseline and application. */
export function daysLine(base: SharedRun, run: SharedRun): string {
	if (base.ewrDaysNotMet === null || run.ewrDaysNotMet === null) return '';
	return t('Days below the EWR at the outlet: {base} on the baseline, {app} with this application.', {
		base: fmtNumber(base.ewrDaysNotMet),
		app: fmtNumber(run.ewrDaysNotMet)
	});
}

export interface ChangeRow {
	cls: OpClass;
	/** "Proposal" or "Baseline assumption". */
	label: string;
	text: string;
	/** The WULA works it models (the op's `works` tag, 294), or null. */
	works: string | null;
}

/**
 * Each change of the application in plain words, and whether it is the
 * applicant's own proposal or a change to the shared baseline. The class is
 * the one its run applied (`classified`); without a run, the engine's rule on
 * the op alone, which calls anything it can't place a baseline assumption.
 */
export function changeRows(sc: ShareScenario['scenario']): ChangeRow[] {
	return opRows(sc.ops, sc.opNames, sc.ownedNodeIds, sc.classified);
}

/**
 * A licence's granted or varied terms in the same words, each change classed
 * by the engine's rule on the op alone (no run of the terms is shown).
 */
export function termsRows(terms: SharedTerms, ownedNodeIds: readonly string[]): ChangeRow[] {
	return opRows(terms.ops, terms.opNames, ownedNodeIds, null);
}

function opRows(ops: readonly ScenarioOp[], opNames: readonly { id: string; name: string }[], owned: readonly string[], classified: readonly OpClass[] | null): ChangeRow[] {
	const names = new Map(opNames.map((n) => [n.id, n.name]));
	const unit = (id: string | null | undefined) => (id && names.get(id)) || t('another hydrological unit');
	return ops.map((op, i) => {
		const cls: OpClass = classified && classified.length === ops.length ? classified[i]! : classifyOp(op, [...owned]);
		const works = typeof op.works === 'string' && op.works ? op.works : null;
		return { cls, label: cls === 'proposal' ? t('Proposal') : t('Baseline assumption'), text: describe(op, unit), works };
	});
}

const WITHHELD_CHANGES = plural({ one: 'change', other: 'changes' });

/** "Not shown: 1 change that sets another hydrological unit’s registered volume.", or '' when none is left out. */
export function withheldLine(n: number): string {
	if (!n) return '';
	return t('Not shown: {changes} setting another hydrological unit’s registered volume. A share link shows no registered volume but the applicant’s own.', { changes: count(WITHHELD_CHANGES, n) });
}

/** What followed the decision, in the Act's words (228). */
function eventKind(k: SharedDecisionEvent['kind']): string {
	return k === 'lodged' ? t('Appeal lodged') : k === 'upheld' ? t('Decision upheld') : k === 'set_aside' ? t('Decision set aside') : t('Decision varied');
}

function forumName(f: SharedDecisionEvent['forum']): string {
	return f === 'water_tribunal' ? t('Water Tribunal') : t('Court');
}

/** "Appeal lodged: Water Tribunal, 2 Oct 2026". */
export function eventHeading(e: SharedDecisionEvent): string {
	return t('{event}: {forum}, {date}', { event: eventKind(e.kind), forum: forumName(e.forum), date: e.eventDate ? fmtDay(e.eventDate) : '–' });
}

/**
 * Where the licence stands, one sentence (app_scenario_licence, 228): on its
 * granted terms, on the terms an appeal varied it to, set aside, or no
 * licence at all; with an appeal open, that nothing changes until it is
 * decided. '' until decided with an outcome.
 */
export function licenceLine(sc: Pick<ShareScenario['scenario'], 'licence' | 'decisionEvents'>): string {
	const l = sc.licence;
	if (!l) return '';
	const from = l.from === 'event' && l.eventPosition !== null ? sc.decisionEvents.find((e) => e.position === l.eventPosition) : undefined;
	const where = from ? t('{forum}, {date}', { forum: forumName(from.forum), date: from.eventDate ? fmtDay(from.eventDate) : '–' }) : '';
	let line = l.inForce
		? from
			? t('The licence stands on the terms it was varied to on appeal ({where}).', { where })
			: t('The licence stands on the terms it was granted on.')
		: from
			? t('The decision was set aside on appeal ({where}): no licence stands.', { where })
			: t('No licence was issued.');
	const open = sc.decisionEvents.at(-1);
	if (l.appealPending && open?.kind === 'lodged') line += ' ' + t('An appeal is lodged with the {forum}: nothing changes until it is decided.', { forum: forumName(open.forum) });
	return line;
}

function describe(op: ScenarioOp, unit: (id: string | null | undefined) => string): string {
	switch (op.op) {
		case 'node.set':
			return t('{unit}: {field} set to {value}', { unit: unit(op.nodeId), field: op.field, value: String(op.value) });
		case 'node.add':
			return t('A new hydrological unit or site, “{name}”', { name: op.node.name });
		case 'node.remove':
			return t('{unit} removed', { unit: unit(op.nodeId) });
		case 'cropArea.set':
			return t('{unit}: a crop’s area set to {ha} ha', { unit: unit(op.nodeId), ha: fmtNumber(op.areaM2 / 10_000, 1, true) });
		case 'crop.add':
			return t('A new crop, “{name}”', { name: op.crop.name });
		case 'transfer.add':
			// Out of the catchment (engine ≥ 1.86.0): no unit receives it.
			if (op.transfer.toNodeId === null) return t('A new transfer from {from} out of the catchment', { from: unit(op.transfer.fromNodeId) });
			return t('A new transfer from {from} to {to}', { from: unit(op.transfer.fromNodeId), to: unit(op.transfer.toNodeId) });
		case 'transfer.set':
			return t('A transfer changed: {field}', { field: op.field });
		case 'transfer.remove':
			return t('A transfer removed');
		case 'landCover.add':
			return t('Land cover added on {unit}', { unit: unit(op.patch.nodeId) });
		case 'landCover.remove':
			return t('Land cover removed');
		case 'borehole.add':
			return t('A new borehole on {unit}', { unit: unit(op.borehole.nodeId) });
		case 'borehole.remove':
			return t('A borehole removed');
		case 'demandObject.add':
			return t('A new water use that isn’t a crop on {unit}', { unit: unit(op.demandObject.nodeId) });
		case 'demandObject.set':
			return t('A water use that isn’t a crop changed: {field}', { field: op.field });
		case 'demandObject.remove':
			return t('A water use that isn’t a crop removed');
		case 'settings.set':
			return t('A catchment setting changed: {path}', { path: op.path });
		case 'series.scale':
			return t('The {kind} record scaled by {factor}', { kind: op.kind, factor: fmtNumber(op.factor, 2, true) });
		case 'climate.delta':
			// Engine 1.107.0 (issue #621): a future climate's change factors, named by the case's label (model, pathway and window).
			return t('A future climate assumed: {label}', { label: op.label });
		case 'demand.scale':
			// One part of a unit's demand (engine ≥ 1.45.0): the crops or one category of demand object, by its technical name.
			return op.part
				? t('Demand of {part} scaled by {factor}', { part: op.part, factor: fmtNumber(op.factor, 2, true) })
				: t('Demand scaled by {factor}', { factor: fmtNumber(op.factor, 2, true) });
		case 'ewrRule.set':
			return t('The Reserve’s rule table replaced at {site}', { site: op.table.siteNodeId ? unit(op.table.siteNodeId) : t('the catchment outlet') });
		case 'ewrRule.remove':
			return t('The Reserve’s rule table removed at {site}', { site: op.siteNodeId ? unit(op.siteNodeId) : t('the catchment outlet') });
		case 'node.move':
			return t('{unit} moved to drain into {to}', { unit: unit(op.nodeId), to: unit(op.downstreamNodeId) });
		case 'node.insert':
			return t('A new hydrological unit or site, “{name}”, placed on the river above {unit}', { name: op.node.name, unit: unit(op.node.downstreamNodeId) });
		case 'crop.set':
			return t('A crop changed: {field}', { field: op.field });
		case 'crop.remove':
			return t('A crop removed');
		case 'landCover.set':
			return t('Land cover changed: {field}', { field: op.field });
		case 'allocation.set':
			return t('A registered volume set on {unit}', { unit: unit(op.allocation.nodeId) });
		case 'allocation.remove':
			return t('A registered volume removed');
	}
}

export interface VolumeRow {
	label: string;
	base: string;
	withApp: string;
}

/** The catchment's totals, when the API sends them (5 or more hydrological units); else none. */
export function volumeRows(base: SharedRun, run: SharedRun): VolumeRow[] {
	const b = base.volumes;
	const a = run.volumes;
	if (!b || !a) return [];
	const m3 = (v: number | null) => (v === null ? '–' : fmtM3Day(v));
	return [
		{ label: t('Mean flow out of the catchment'), base: m3(b.meanSimulatedOutflowM3Day), withApp: m3(a.meanSimulatedOutflowM3Day) },
		{ label: t('Mean water supplied to the hydrological units'), base: m3(b.farms.suppliedM3Day), withApp: m3(a.farms.suppliedM3Day) },
		{ label: t('Hydrological units short of 95 % of their demand'), base: fmtNumber(b.farms.belowTarget), withApp: fmtNumber(a.farms.belowTarget) }
	];
}

/** "Submitted 28 Sep 2026", or the decision. */
export function statusLine(sc: ShareScenario['scenario']): string {
	if (sc.status === 'decided') {
		const when = sc.decidedAt ? fmtStampDay(sc.decidedAt) : '';
		// The responsible authority's decision, in the Act's words (163_licensing_authority).
		const outcome =
			sc.outcome === 'licence_issued'
				? t('Licence issued')
				: sc.outcome === 'licence_refused'
					? t('Licence refused')
					: sc.outcome === 'application_rejected'
						? t('Application rejected')
						: sc.outcome === 'not_considered'
							? t('Not considered: use already authorised')
							: t('Decided');
		return when ? t('{outcome} on {date}.', { outcome, date: when }) : `${outcome}.`;
	}
	return sc.submittedAt ? t('Submitted on {date}, awaiting a decision.', { date: fmtStampDay(sc.submittedAt) }) : t('Submitted, awaiting a decision.');
}

/** Why no results show, or null when they do. */
export function resultsNote(r: ShareScenario['results']): string | null {
	if (r === 'none') return t('This application has not been run on its current changes yet, so there are no results to show.');
	if (r === 'unverified') return t('Its results aren’t shown: they weren’t stored by the model run itself, so they can’t be relied on.');
	return null;
}

/** sessionStorage key: a scenario or pack link's token and kind, kept for this tab while its reader signs in to comment. */
export const SHARE_RETURN_KEY = 'wm:share-return';
/** How long a kept link waits for its reader to sign in; after that a bare /share in the tab doesn't reopen it. */
export const SHARE_RETURN_MS = 15 * 60_000;
