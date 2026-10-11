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
 * it is held (m³ a year; storage-only s21b entries count none). Since
 * `evidence-17` (`folded`, issue #523 G1, D3) it never gives fewer than
 * FARMER_K (5) registered users' volume: a water source held by fewer is left
 * out, and the ways of holding held by fewer are pooled in one `other` row,
 * itself left out below 5. The totals are the rows'. A board built before
 * has no `folded` and rows of any size: only editors and owners read it.
 */
export interface AuthorisedMix {
	rows: { authorisation: AuthorisationKind | 'unknown' | 'other'; volumeM3PerYear: number; entitlement: boolean }[];
	/** Licence plus verified existing lawful use, in the rows. */
	entitlementM3PerYear: number;
	totalM3PerYear: number;
	/** Built under the 5-holder rule (evidence-17); absent on an older board. */
	folded?: true;
	/** Registered users whose volume no row holds (a source, or a pooled `other`, held by fewer than 5). */
	leftOutHolders?: number;
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

/** The mix of the volumes a full-allocation run took; null when there are none. */
export function authorisedMix(entries: readonly MixEntry[]): AuthorisedMix | null {
	// A storage-only registration (s21b) takes nothing (engine allocations/mode.ts).
	const takes = entries
		.filter((e) => e.waterUse !== '21b' && e.volumeM3PerYear > 0)
		.map((e, i) => ({ ...e, who: e.holder ?? `entry:${i}`, kind: isKind(e.authorisation) ? e.authorisation : ('unknown' as const) }));
	if (!takes.length) return null;
	const holdersOf = (list: readonly { who: string }[]) => new Set(list.map((e) => e.who)).size;
	// A water source held by fewer than FARMER_K users is left out whole: its total, and so any row's share of it, is theirs.
	const bySource = new Map<string, typeof takes>();
	for (const e of takes) bySource.set(e.waterSource ?? '', [...(bySource.get(e.waterSource ?? '') ?? []), e]);
	const kept = [...bySource.values()].filter((l) => holdersOf(l) >= FARMER_K).flat();
	const by = new Map<AuthorisationKind | 'unknown', typeof takes>();
	for (const e of kept) by.set(e.kind, [...(by.get(e.kind) ?? []), e]);
	const shown = [...AUTHORISATION_ORDER, 'unknown' as const].filter((k) => by.has(k) && holdersOf(by.get(k)!) >= FARMER_K);
	const pooled = [...by.entries()].filter(([k]) => !shown.includes(k)).flatMap(([, l]) => l);
	const sum = (l: readonly { volumeM3PerYear: number }[]) => l.reduce((s, e) => s + e.volumeM3PerYear, 0);
	const rows: AuthorisedMix['rows'] = shown.map((k) => ({ authorisation: k, volumeM3PerYear: sum(by.get(k)!), entitlement: (ENTITLEMENTS as readonly string[]).includes(k) }));
	const pool = pooled.length && holdersOf(pooled) >= FARMER_K;
	if (pool) rows.push({ authorisation: 'other', volumeM3PerYear: sum(pooled), entitlement: false });
	const inRows = new Set([...shown.flatMap((k) => by.get(k)!.map((e) => e.who)), ...(pool ? pooled.map((e) => e.who) : [])]);
	return {
		rows,
		entitlementM3PerYear: rows.filter((r) => r.entitlement).reduce((s, r) => s + r.volumeM3PerYear, 0),
		totalM3PerYear: rows.reduce((s, r) => s + r.volumeM3PerYear, 0),
		folded: true,
		leftOutHolders: new Set(takes.map((e) => e.who).filter((w) => !inRows.has(w))).size
	};
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
	/** The volumes it held every holder to, by how they are held; null unless ok. */
	mix: AuthorisedMix | null;
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
