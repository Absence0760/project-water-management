// An applicant's view of their own application's evidence pack (WP-3.15;
// 131_applicant_packs; docs/ui.md § Evidence pack → The applicant's pack
// view), as pure functions of GET …/scenarios/:sid/packs/:packId's answer.
// The page lays these out; applicantPack.test.ts pins them. The applicant
// shell is part of the workspace, so its words are English (ui.md § Language).
//
// What it shows is D2's: the pack's standing and verify fields, the river's
// rows and sites a pack link shows, their own units by name, and every other
// unit only as "Farm n" / "Water user n" with its change in whole points.
import type { ApplicantPack, ApplicantPackMeta, ApplicantPackOwnUnit, SharedBand, SharedPackRow, SharedPackSite } from '$lib/api';
import { fmtDate, fmtNum, fmtPct } from '$lib/format/number';

/** The applicant's pack view: /projects/:id/scenarios/:sid/packs/:packId. */
export const applicantPackHref = (base: string, projectId: string, scenarioId: string, packId: string) =>
	`${base}/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(scenarioId)}/packs/${encodeURIComponent(packId)}`;

/** Where the pack stands, in a sentence. */
export function standingLine(p: Pick<ApplicantPackMeta, 'status' | 'version' | 'issuedAt' | 'withdrawnReason'>): string {
	const issued = fmtDate(p.issuedAt);
	switch (p.status) {
		case 'issued':
			return `Version ${p.version}, issued ${issued}. It stands: this is the version an assessor checks.`;
		case 'superseded':
			return `Version ${p.version}, issued ${issued}, was replaced by a newer version. It no longer stands.`;
		case 'withdrawn':
			return `Version ${p.version}, issued ${issued}, was withdrawn${p.withdrawnReason ? `: ${p.withdrawnReason}` : ''}. It no longer stands.`;
	}
}

/** A signed number with its unit ("+2 days", "−5 points", "0 days"). */
function signed(v: number, unit: (n: string) => string, digits = 0): string {
	const n = fmtNum(Math.abs(v), digits, true);
	const sign = n === '0' ? '' : v > 0 ? '+' : '−';
	return `${sign}${unit(n)}`;
}

const UNIT: Record<SharedPackRow['id'], (n: string) => string> = {
	reserve: (n) => `${n}%`,
	ewrDays: (n) => `${n} days`,
	noFlowDays: (n) => `${n} days`,
	shortfall: (n) => `${n} million m³`,
	outflowMar: (n) => `${n} million m³ a year`
};
const DIGITS: Record<SharedPackRow['id'], number> = { reserve: 1, ewrDays: 0, noFlowDays: 0, shortfall: 2, outflowMar: 2 };

/** A row's measure, by its id (the pack's own label stays in the pack). */
export function rowLabel(r: Pick<SharedPackRow, 'id' | 'subject'>): string {
	switch (r.id) {
		case 'reserve':
			return r.subject ? `Reserve months met at ${r.subject}` : 'Reserve months met at the catchment outlet';
		case 'ewrDays':
			return 'Days below the EWR at the outlet';
		case 'noFlowDays':
			return 'Days with no flow at the outlet';
		case 'shortfall':
			return 'Volume short of the EWR at the outlet, whole run';
		case 'outflowMar':
			return 'Mean yearly flow out of the catchment';
	}
}

/** A value in its unit, or a dash. */
export const rowValue = (id: SharedPackRow['id'], v: number | null): string => (v === null ? '–' : UNIT[id](fmtNum(v, DIGITS[id], true)));

/** A change with its sign; a reserve row's is in percentage points. */
export function rowChange(id: SharedPackRow['id'], v: number | null): string {
	if (v === null) return '–';
	return id === 'reserve' ? signed(v, (n) => `${n} points`, 1) : signed(v, UNIT[id], DIGITS[id]);
}

/** "likely −3 to +1 (30 model sets)", or null without percentiles. */
export function bandText(b: SharedBand | null, fmt: (v: number) => string): string | null {
	if (!b || b.p5 === null || b.p95 === null) return null;
	return `likely ${fmt(b.p5)} to ${fmt(b.p95)}${b.n ? ` (${fmtNum(b.n)} model sets)` : ''}`;
}

export interface SiteLine {
	place: string;
	base: string;
	withApp: string | null;
	change: string | null;
}

const metIn = (rate: number | null, months: number | null) => (rate === null || !months ? 'not assessed' : `met in ${fmtPct(rate)} of ${fmtNum(months)} months`);

/** The Reserve at each EWR site, as the pack orders them; the outlet is never named (it may be a farm). */
export function siteLines(river: SharedPackSite[], application: boolean): SiteLine[] {
	return river.map((s) => {
		const net = (s.lost ?? 0) - (s.gained ?? 0);
		return {
			place: s.isOutlet || !s.name ? 'Catchment outlet' : s.name,
			base: metIn(s.rateA, s.monthsA),
			withApp: application ? metIn(s.rateB, s.monthsA) : null,
			change: !application
				? null
				: net > 0
					? `${fmtNum(net)} more month${net === 1 ? '' : 's'} below the Reserve`
					: net < 0
						? `${fmtNum(-net)} fewer month${net === -1 ? '' : 's'} below the Reserve`
						: 'no change in the months met'
		};
	});
}

export interface OwnUnitLine {
	name: string;
	kind: string;
	base: string;
	withApp: string;
	change: string;
	band: string | null;
}

const KIND: Record<'farm' | 'user', string> = { farm: 'Farm', user: 'Water user' };
const points = (v: number) => signed(v, (n) => `${n} points`, 1);

/** Their own units: share of demand supplied, baseline and with the application, and the change in points. */
export function ownUnitLines(own: ApplicantPackOwnUnit[]): OwnUnitLine[] {
	return own.map((u) => ({
		name: u.name,
		kind: u.onlyIn === 'application' ? `${KIND[u.kind]}, added by the application` : KIND[u.kind],
		base: u.onlyIn === 'application' ? 'not in the baseline' : fmtPct(u.suppliedA),
		withApp: fmtPct(u.suppliedB),
		change: u.change?.run == null ? '–' : points(u.change.run),
		band: u.change ? bandText(u.change.band, points) : null
	}));
}

/** Every other unit, anonymous: "Farm 3", and its change in share supplied in whole points. */
export function otherUnitLines(others: NonNullable<ApplicantPack['units']>['others']): { name: string; change: string }[] {
	return others.map((o) => ({ name: `${KIND[o.kind]} ${o.n}`, change: o.changePts === 0 ? 'no change' : signed(o.changePts, (n) => `${n} points`) }));
}

/** How many other units lose supply, and how many gain, in whole points. */
export function othersSummary(others: NonNullable<ApplicantPack['units']>['others']): string {
	if (!others.length) return 'No other farm or water user is in both runs.';
	const worse = others.filter((o) => o.changePts < 0).length;
	const better = others.filter((o) => o.changePts > 0).length;
	const total = `${fmtNum(others.length)} other ${others.length === 1 ? 'unit' : 'units'}`;
	if (!worse && !better) return others.length === 1 ? 'The one other unit doesn’t change by a whole point or more.' : `None of the ${total} changes by a whole point or more.`;
	return `Of ${total}, ${fmtNum(worse)} ${worse === 1 ? 'gets' : 'get'} less of ${worse === 1 ? 'its' : 'their'} demand and ${fmtNum(better)} more.`;
}
