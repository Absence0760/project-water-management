// Page 1's second licence impact board (licensing build item 8; provisional
// position, pre-counsel research, 2026-10-01; docs/model.md §2.14a,
// docs/evidence-pack.md § Both impact bases). The first board judges the
// application against the baseline as it ran: existing use is the use the
// model found. This one judges it against **full authorised use**: the
// baseline and the application both run with every holder at their
// registered volume (settings.allocationMode `fullAllocation`), so the
// proposal is weighed against the existing and potential uses NWA s27(1)(a),
// (f) and s29(1)(a)(iii) and R267's "cumulative impact" protect. It is the
// headline; the modelled-use board is second.
//
// Only a licence or s35-verified existing lawful use is an entitlement; a
// WARMS registration, a claimed existing lawful use, a general authorisation
// and Schedule 1 use are not. So the board prints the authorised volume's mix
// beside it. The pair is two model runs, which a report request must not
// carry: an editor makes it (POST …/runs/:runId/authorised-impact), the
// backend stores the board this module's caller built, and the report reads
// it (or says why there is none: a fixed row, never omitted).
import { FARMER_K } from '../views/farmView';
import type { EvidenceLicenceImpact } from './types';

/** How a registered volume is held (the allocation's `authorisation`, backend 136). */
export type AuthorisationKind = 'licence' | 'existing_lawful_use' | 'registration' | 'existing_lawful_use_claimed' | 'general_authorisation' | 'schedule_1';

/** The ones that are an entitlement: a licence (s40) and an existing lawful use verified under s35. */
export const ENTITLEMENTS: readonly AuthorisationKind[] = ['licence', 'existing_lawful_use'];

/** The order the mix lists them in: entitlements first. */
export const AUTHORISATION_ORDER: readonly AuthorisationKind[] = ['licence', 'existing_lawful_use', 'registration', 'existing_lawful_use_claimed', 'general_authorisation', 'schedule_1'];

/**
 * The authorised volume the full-allocation run held every holder to, by how
 * it is held (m³ a year; storage-only s21b entries count none). The full mix
 * (authorisedMix) is what editors, owners, the authority and the PDF read;
 * a viewer the project keeps from each registered volume reads the folded one
 * as shares (foldedMix, AuthorisedMixShares; evidence-18, issue #523 G/H/J,
 * D3). Evidence-17 froze the folded one in m³ (`folded`); the backend serves
 * that viewer its shares (mixShares).
 */
export interface AuthorisedMix {
	rows: {
		authorisation: AuthorisationKind | 'unknown' | 'other';
		volumeM3PerYear: number;
		entitlement: boolean;
		/** Folded only: this row also holds the ways of holding too few hold to show (secondary suppression). */
		withOthers?: true;
	}[];
	/** Licence plus verified existing lawful use, in the rows. */
	entitlementM3PerYear: number;
	totalM3PerYear: number;
	/** The folded mix (foldedMix); absent on the full one. */
	folded?: true;
	/** Folded only: registered users in no row (a water source fewer than 5 hold), given only when 5 or more. */
	leftOutHolders?: number;
	/** Folded only: some registered users are in no row, fewer than 5 (so not counted). */
	someLeftOut?: true;
}

/** One registered volume as the mix reads it: the run's allocation and its `authorisation` (null when the row is gone). */
export interface MixEntry {
	volumeM3PerYear: number;
	waterUse?: string | null;
	authorisation: string | null;
	/** Who holds it, as app_allocation_volumes counts holders (162); absent: a holder of its own. */
	holder?: string | null;
	waterSource?: string | null;
}

const isKind = (v: string | null): v is AuthorisationKind => !!v && (AUTHORISATION_ORDER as readonly string[]).includes(v);
const isEntitlement = (k: string) => (ENTITLEMENTS as readonly string[]).includes(k);

/** The takes the mix counts, each with its kind and holder. A storage-only registration (s21b) takes nothing (engine allocations/mode.ts). */
function takesOf(entries: readonly MixEntry[]) {
	return entries
		.filter((e) => e.waterUse !== '21b' && e.volumeM3PerYear > 0)
		.map((e, i) => ({ ...e, who: e.holder ?? `entry:${i}`, kind: isKind(e.authorisation) ? e.authorisation : ('unknown' as const) }));
}
const sum = (l: readonly { volumeM3PerYear: number }[]) => l.reduce((s, e) => s + e.volumeM3PerYear, 0);
const totals = (rows: AuthorisedMix['rows']) => ({
	entitlementM3PerYear: sum(rows.filter((r) => r.entitlement)),
	totalM3PerYear: sum(rows)
});

/** The full mix of the volumes a full-allocation run took, by how they are held; null when there are none. */
export function authorisedMix(entries: readonly MixEntry[]): AuthorisedMix | null {
	const takes = takesOf(entries);
	if (!takes.length) return null;
	const rows = [...AUTHORISATION_ORDER, 'unknown' as const]
		.filter((k) => takes.some((e) => e.kind === k))
		.map((k) => ({ authorisation: k, volumeM3PerYear: sum(takes.filter((e) => e.kind === k)), entitlement: isEntitlement(k) }));
	return { rows, ...totals(rows) };
}

/**
 * The mix folded so no line gives fewer than 5 registered users' volume
 * (evidence-17, issue #523 G1, D3), in m³: what foldedMix gives as shares.
 *  - A water source held by fewer than 5 is left out whole.
 *  - A way of holding held by 5 or more is a row; the others are pooled in
 *    one `other` row when the pool has 5 or more holders, and otherwise
 *    merged into the smallest row that isn't an entitlement (or the smallest
 *    row, then no longer an entitlement): never dropped.
 *  - How many were left out is said only when 5 or more; fewer, only that
 *    some were.
 * Its m³ can still be differenced against a live total over other rows (the
 * mix sums every row of the run, whatever its dates; a viewer's live totals
 * are of the rows in force today: #523 H), or a kind row against a source
 * total (#523 J), so it is never served: only its shares are.
 */
function fold(entries: readonly MixEntry[]): AuthorisedMix | null {
	const takes = takesOf(entries);
	if (!takes.length) return null;
	const holdersOf = (list: readonly { who: string }[]) => new Set(list.map((e) => e.who)).size;
	const bySource = new Map<string, typeof takes>();
	for (const e of takes) bySource.set(e.waterSource ?? '', [...(bySource.get(e.waterSource ?? '') ?? []), e]);
	const kept = [...bySource.values()].filter((l) => holdersOf(l) >= FARMER_K).flat();
	const keptWho = new Set(kept.map((e) => e.who));
	const left = new Set(takes.map((e) => e.who).filter((w) => !keptWho.has(w))).size;
	const by = new Map<AuthorisationKind | 'unknown', typeof takes>();
	for (const e of kept) by.set(e.kind, [...(by.get(e.kind) ?? []), e]);
	const shown = [...AUTHORISATION_ORDER, 'unknown' as const].filter((k) => by.has(k) && holdersOf(by.get(k)!) >= FARMER_K);
	const pooled = [...by.entries()].filter(([k]) => !shown.includes(k)).flatMap(([, l]) => l);
	const rows: AuthorisedMix['rows'] = shown.map((k) => ({ authorisation: k, volumeM3PerYear: sum(by.get(k)!), entitlement: isEntitlement(k) }));
	if (pooled.length) {
		if (holdersOf(pooled) >= FARMER_K || !rows.length) rows.push({ authorisation: 'other', volumeM3PerYear: sum(pooled), entitlement: false });
		else {
			const smallest = (l: typeof rows) => l.reduce((a, b) => (b.volumeM3PerYear < a.volumeM3PerYear ? b : a));
			const plain = rows.filter((r) => !r.entitlement);
			const into = smallest(plain.length ? plain : rows);
			into.volumeM3PerYear += sum(pooled);
			into.withOthers = true;
			into.entitlement = false;
		}
	}
	return { rows, ...totals(rows), folded: true, ...(left >= FARMER_K ? { leftOutHolders: left } : left > 0 ? { someLeftOut: true } : {}) };
}

/**
 * The folded mix as a viewer kept from each registered volume reads it
 * (evidence-18, issue #523 G/H/J, D3): each line's share of the lines' sum in
 * whole percent, and no m³ at all, neither per line nor in total. A frozen
 * m³ figure beside a viewer's live per-source totals could be differenced:
 * the mix sums every row of the run whatever its dates, the live totals only
 * the rows in force today (H), and a kind's line sums across sources, so with
 * the per-source totals it forms the margins of a source × kind table (J).
 */
export interface AuthorisedMixShares {
	rows: {
		authorisation: AuthorisedMix['rows'][number]['authorisation'];
		/** Whole percent of the lines' sum; the lines add up to 100 (largest remainder). */
		sharePct: number;
		entitlement: boolean;
		withOthers?: true;
	}[];
	/** The entitlement lines' shares, summed. */
	entitlementPct: number;
	folded: true;
	shares: true;
	leftOutHolders?: number;
	someLeftOut?: true;
}

/** Whether a mix is given as shares (a folded one, evidence-18, or one the backend made from an evidence-17 folded one). */
export const isMixShares = (m: AuthorisedMix | AuthorisedMixShares): m is AuthorisedMixShares => (m as AuthorisedMixShares).shares === true;

/** A mix's lines as whole-percent shares of their sum, adding up to 100 (largest remainder), with no m³. */
export function mixShares(m: AuthorisedMix | AuthorisedMixShares): AuthorisedMixShares {
	if (isMixShares(m)) return m;
	const total = m.rows.reduce((s, r) => s + Math.max(r.volumeM3PerYear, 0), 0);
	const exact = m.rows.map((r) => (total > 0 ? (100 * Math.max(r.volumeM3PerYear, 0)) / total : 0));
	const pct = exact.map(Math.floor);
	if (total > 0) {
		const order = exact.map((e, i) => ({ i, rem: e - Math.floor(e) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
		for (let k = 0, short = 100 - pct.reduce((s, p) => s + p, 0); k < short; k++) pct[order[k % order.length]!.i]! += 1;
	}
	const rows = m.rows.map((r, i) => ({ authorisation: r.authorisation, sharePct: pct[i]!, entitlement: r.entitlement, ...(r.withOthers ? { withOthers: true as const } : {}) }));
	return {
		rows,
		entitlementPct: rows.filter((r) => r.entitlement).reduce((s, r) => s + r.sharePct, 0),
		folded: true,
		shares: true,
		...(m.leftOutHolders !== undefined ? { leftOutHolders: m.leftOutHolders } : {}),
		...(m.someLeftOut ? { someLeftOut: true as const } : {})
	};
}

/**
 * The mix as a viewer kept from each registered volume reads it
 * (evidence-18): folded (fold: no line is fewer than 5 registered users'
 * volume, no source fewer than 5 hold is in it, no count of them below 5),
 * then given as whole-percent shares with no m³ (mixShares), so nothing
 * absolute can be differenced against the totals that viewer reads.
 */
export function foldedMix(entries: readonly MixEntry[]): AuthorisedMixShares | null {
	const f = fold(entries);
	return f ? mixShares(f) : null;
}

/**
 * Why there is no full-authorised-use board, or that there is one:
 *   notBuilt      nobody has run the full-allocation pair for this application run;
 *   noAllocations the baseline ran with no registered or licensed volumes, so there is nothing to hold holders to;
 *   stale         the pair was run on another engine than the baseline's, or with other outcome settings than the project's now;
 *   ok            the board below.
 */
export type AuthorisedImpactStatus = 'ok' | 'notBuilt' | 'noAllocations' | 'stale';

/** Page 1's full-authorised-use board (the report's `licenceImpactAuthorised`). */
export interface EvidenceAuthorisedImpact {
	status: AuthorisedImpactStatus;
	/** stale: what differs, in words. */
	detail: string | null;
	/** The board over the full-allocation pair; null unless ok. */
	board: EvidenceLicenceImpact | null;
	/**
	 * The volumes it held every holder to, by how they are held; null unless ok. A viewer kept from each
	 * registered volume is served the folded shares here instead (backend redactReportAllocations).
	 */
	mix: AuthorisedMix | AuthorisedMixShares | null;
	/**
	 * The same, folded for a viewer kept from each registered volume, which the backend serves them in
	 * `mix`'s place: shares with no m³ since evidence-18 (foldedMix, #523 H/J); in m³ on a board built
	 * at evidence-17 (served as its shares, mixShares). Absent from a board built before.
	 */
	mixFolded?: AuthorisedMix | AuthorisedMixShares | null;
	/** When the pair was run, and on which engine; null unless ok or stale. */
	builtAt: string | null;
	engineVersion: string | null;
}

/** A section that says why there is no board. */
export const authorisedUnavailable = (status: Exclude<AuthorisedImpactStatus, 'ok'>, detail: string | null = null, built?: { builtAt: string; engineVersion: string }): EvidenceAuthorisedImpact => ({
	status,
	detail,
	board: null,
	mix: null,
	builtAt: built?.builtAt ?? null,
	engineVersion: built?.engineVersion ?? null
});
