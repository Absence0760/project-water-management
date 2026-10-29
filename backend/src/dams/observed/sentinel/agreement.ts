// How well Sentinel-1 radar agrees with Sentinel-2's clear views of the same
// dams (issue #624 step 5; docs/model.md §2.10l, docs/architecture.md § Dam
// observations → Sentinel-1). Radar's water threshold is fixed, not tuned per
// dam, so whether it can be trusted is measured: for each clear radar view of
// a dam, the clear Sentinel-2 view of the same dam on the same day (else a
// day either side), and whether the two wet areas are within
// S1_AGREEMENT.withinShare of the dam's full area F. Issue #624's bar: at
// least S1_AGREEMENT.bar of those days agree (≥ 85 % within 0.1 F), measured
// on real dams before S1 is turned on in production.
//
// F is the traced outline's own area (geo/area.ts, on the ellipsoid's
// authalic sphere): the dam polygon is drawn round the full water surface,
// and it is the area both passes sum inside. "Clear" is the comparison's own
// rule (compare.ts OBSERVED.minPctObserved: at least 90 % of the outline seen
// clearly), for both sides.
//
// Pure (s1Agreement, summarizeAgreement), plus the report file the fetcher
// keeps beside the passes' files (dams/s1-agreement.json): per dam, its pairs
// and how many agree, recomputed for the dams whose Sentinel-1 or Sentinel-2
// file a run wrote (and up to AGREEMENT_FILL_PER_RUN others it hasn't yet),
// and summed into the `dams_s1_agreement` log line (counts only, never a
// dam). `pnpm dev:dams:run` prints the same summary.
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError } from '../../../feeds/errors.js';
import { geometryAreaM2 } from '../../../geo/area.js';
import type { MirrorStore } from '../../../mirror/store.js';
import { FEATURE_ID, readJson, readObservationFile, readWanted, writeJson, type ObservationRow, type WantedOutline } from '../handover.js';

/** The agreement check's rules (issue #624 § Acceptance criteria). */
export const S1_AGREEMENT = {
	/** A radar view pairs with a Sentinel-2 view this many days apart at most (the same day first). */
	maxDayGap: 1,
	/** Two views agree when their wet areas are within this share of the full area F (compare.ts OBSERVED.withinShare). */
	withinShare: 0.1,
	/** The share of paired days that must agree. */
	bar: 0.85,
	/**
	 * Hysteresis (s1Shows): a dam whose radar is already shown keeps it while at least this share agree, so a dam
	 * hovering at the bar isn't withheld and reloaded tick after tick. Five points under the bar: the rate is over every
	 * pair the dam has, so once it has 20 or more pairs one new pair moves it by five points at most, and a dam that has
	 * cleared 85 % needs a real run of disagreeing days (not one windy pass) to fall out; at 80 % still four radar days in
	 * five sit within 0.1 F of Sentinel-2, so what stays shown is still mostly right.
	 */
	keepBar: 0.8,
	/** A dam's own rate is judged only with at least this many pairs. */
	minPairs: 10,
	/**
	 * Both views must have seen at least this share of the outline clearly (%; compare.ts OBSERVED.minPctObserved). The
	 * two are copied, not imported, so the fetcher's bundle doesn't take in compare.ts's engine import; a test pins them.
	 */
	minPctObserved: 90
} as const;

/** One radar view and the Sentinel-2 view it was paired with. */
export interface AgreementPair {
	s1Date: string;
	s2Date: string;
	/** Each side's wet area as a share of F. */
	s1Share: number;
	s2Share: number;
	within: boolean;
}

/** A dam's agreement. */
export interface DamAgreement {
	pairs: number;
	within: number;
	/** within ÷ pairs, null with no pairs. */
	rate: number | null;
	/** At least S1_AGREEMENT.minPairs pairs and a rate at or above the bar. */
	passes: boolean;
}

const dayOf = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** The pairs of one dam's clear radar and Sentinel-2 views (see the header), oldest first. */
export function agreementPairs(s1: readonly ObservationRow[], s2: readonly ObservationRow[], fullAreaM2: number): AgreementPair[] {
	if (!(fullAreaM2 > 0)) return [];
	const clear = (r: ObservationRow) => r.pctObserved >= S1_AGREEMENT.minPctObserved;
	const s2ByDay = new Map<number, ObservationRow>();
	for (const r of s2) if (clear(r)) s2ByDay.set(dayOf(r.date), r);
	const out: AgreementPair[] = [];
	for (const r of [...s1].filter(clear).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
		const d = dayOf(r.date);
		let other: ObservationRow | undefined;
		// The same day, then the day before, then the day after, and so on to maxDayGap.
		for (let gap = 0; gap <= S1_AGREEMENT.maxDayGap && !other; gap++) other = s2ByDay.get(d - gap) ?? s2ByDay.get(d + gap);
		if (!other) continue;
		const s1Share = r.wetAreaM2 / fullAreaM2;
		const s2Share = other.wetAreaM2 / fullAreaM2;
		out.push({ s1Date: r.date, s2Date: other.date, s1Share, s2Share, within: Math.abs(s1Share - s2Share) <= S1_AGREEMENT.withinShare });
	}
	return out;
}

/** A dam's agreement from its pairs' counts. */
export function damAgreement(pairs: number, within: number): DamAgreement {
	const rate = pairs ? within / pairs : null;
	return { pairs, within, rate, passes: pairs >= S1_AGREEMENT.minPairs && rate !== null && rate >= S1_AGREEMENT.bar };
}

/** One dam's agreement from its rows (see the header). */
export function s1Agreement(s1: readonly ObservationRow[], s2: readonly ObservationRow[], fullAreaM2: number): DamAgreement {
	const pairs = agreementPairs(s1, s2, fullAreaM2);
	return damAgreement(pairs.length, pairs.filter((p) => p.within).length);
}

/** Every dam's agreement summed (counts only: it is logged). */
export interface AgreementSummary {
	/** Dams in the report. */
	dams: number;
	/** Dams with at least one pair. */
	damsPaired: number;
	/** Dams with enough pairs to judge (S1_AGREEMENT.minPairs), and of them those at or above the bar. */
	damsJudged: number;
	damsPassing: number;
	/** All dams' pairs pooled, and how many agree. */
	pairs: number;
	within: number;
	/** within ÷ pairs, null with none. */
	rate: number | null;
	/** The pooled rate at or above the bar, over at least S1_AGREEMENT.minPairs pairs: issue #624's measure. */
	passes: boolean;
}

export function summarizeAgreement(perDam: Iterable<Pick<DamAgreement, 'pairs' | 'within'>>): AgreementSummary {
	let dams = 0;
	let damsPaired = 0;
	let damsJudged = 0;
	let damsPassing = 0;
	let pairs = 0;
	let within = 0;
	for (const d of perDam) {
		dams++;
		if (d.pairs > 0) damsPaired++;
		const a = damAgreement(d.pairs, d.within);
		if (d.pairs >= S1_AGREEMENT.minPairs) damsJudged++;
		if (a.passes) damsPassing++;
		pairs += d.pairs;
		within += d.within;
	}
	const pooled = damAgreement(pairs, within);
	return { dams, damsPaired, damsJudged, damsPassing, pairs, within, rate: pooled.rate === null ? null : Math.round(pooled.rate * 1000) / 1000, passes: pooled.passes };
}

// --- The report file -----------------------------------------------------------------------

export const AGREEMENT_KEY = '/dams/s1-agreement.json' as AbsolutePath;
/** Dams the report holds no entry for yet, recomputed a run beside the changed ones (two GETs each). */
export const AGREEMENT_FILL_PER_RUN = 200;

const Count = z.number().int().min(0).max(1_000_000);
export const AgreementFileSchema = z
	.object({
		computedAt: z.string().datetime(),
		perDam: z.record(z.string().regex(FEATURE_ID), z.object({ pairs: Count, within: Count, fullAreaM2: z.number().nonnegative() }).strict().refine((d) => d.within <= d.pairs))
	})
	.strict();
export type AgreementFile = z.output<typeof AgreementFileSchema>;

/**
 * Recomputes the report for `changed` dams (the featureIds whose Sentinel-1 or Sentinel-2 file this run wrote) and up
 * to AGREEMENT_FILL_PER_RUN listed dams it has no entry for, drops dams no longer listed, writes it, and sums it. Null
 * when there is no wanted list.
 */
export async function updateAgreement(store: MirrorStore, changed: Iterable<string>, now: () => number = Date.now): Promise<AgreementSummary | null> {
	const wanted = await readWanted(store);
	if (!wanted) return null;
	const listed = new Map<string, WantedOutline>(wanted.outlines.map((o) => [o.featureId, o]));
	const before = (await readJson(store, AGREEMENT_KEY, AgreementFileSchema, 'S1/S2 agreement report')) as AgreementFile | null;
	const perDam: AgreementFile['perDam'] = {};
	for (const [id, d] of Object.entries(before?.perDam ?? {})) if (listed.has(id)) perDam[id] = d;
	const due = new Set([...changed].filter((id) => listed.has(id)));
	let fill = 0;
	for (const id of listed.keys()) {
		if (fill >= AGREEMENT_FILL_PER_RUN) break;
		if (!(id in perDam) && !due.has(id)) {
			due.add(id);
			fill++;
		}
	}
	for (const id of due) {
		try {
			const s1 = await readObservationFile(store, 's1', id);
			const s2 = s1 ? await readObservationFile(store, 's2', id) : null;
			const fullAreaM2 = geometryAreaM2(listed.get(id)!.geometry) ?? 0;
			const a = s1Agreement(s1?.rows ?? [], s2?.rows ?? [], fullAreaM2);
			perDam[id] = { pairs: a.pairs, within: a.within, fullAreaM2: Math.round(fullAreaM2 * 100) / 100 };
		} catch (err) {
			// A file that can't be read (not JSON, not valid) keeps this dam's last counts, or none, and the rest go on;
			// the mirror itself failing still throws.
			if (!(err instanceof FeedFormatError)) throw err;
		}
	}
	await writeJson(store, AGREEMENT_KEY, AgreementFileSchema.parse({ computedAt: new Date(now()).toISOString(), perDam }));
	return summarizeAgreement(Object.values(perDam));
}

// --- Which dams' radar the worker loads (DAM_OBSERVATIONS_S1=on; handover.ts damS1Mode) ------------------

/** The report, checked; null when no run has written one. */
export const readAgreement = (store: MirrorStore): Promise<AgreementFile | null> =>
	readJson(store, AGREEMENT_KEY, AgreementFileSchema, 'S1/S2 agreement report') as Promise<AgreementFile | null>;

/**
 * Whether the worker shows a dam's radar in `on`, given whether it showed it at its last decision (`wasShown`, the
 * dam's s1 load mark: tick.ts). A dam starts being shown when its own agreement passes (damAgreement: at least
 * S1_AGREEMENT.minPairs pairs and S1_AGREEMENT.bar of them within), and stops only below S1_AGREEMENT.keepBar, so a
 * dam near the bar doesn't flip radar on and off. A dam with fewer pairs can't be judged, shown before or not, so its
 * radar isn't loaded: radar's threshold is fixed, not tuned per dam, and a dam it hasn't been checked on (a small,
 * windy or shallow one) is where it reads wrong. No entry: not shown.
 */
export function s1Shows(d: Pick<DamAgreement, 'pairs' | 'within'> | undefined, wasShown: boolean): boolean {
	if (!d || d.pairs < S1_AGREEMENT.minPairs) return false;
	return d.within / d.pairs >= (wasShown ? S1_AGREEMENT.keepBar : S1_AGREEMENT.bar);
}

/** The dams whose radar the worker loads in `on` (s1Shows), given the ones it showed at its last decision. No report: no dam. */
export function s1Passing(file: AgreementFile | null, shown: ReadonlySet<string> = new Set()): Set<string> {
	const out = new Set<string>();
	for (const [id, d] of Object.entries(file?.perDam ?? {})) if (s1Shows(d, shown.has(id))) out.add(id);
	return out;
}
