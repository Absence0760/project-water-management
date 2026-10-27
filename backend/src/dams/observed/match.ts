// Which DE Africa waterbody a traced dam is (issue #604 R5; 249's
// dam_waterbody_match, docs/architecture.md § Dam observations).
//
// No PostGIS: the database narrows the waterbodies to those whose bounding
// box meets the dam's (app_waterbody_candidates), and the overlap is measured
// here, exactly, by geo/geojson.ts intersectionArea (planar degrees², which
// is fine for a ratio of two areas a few hundred metres apart).
//
// For the dam D and each candidate waterbody W:
//   damShare       = area(D ∩ W) / area(D)   how much of the dam's outline W covers
//   waterbodyShare = area(D ∩ W) / area(W)   how much of W is this dam
// W is Waterbodies' historical extent: everywhere water was seen often
// enough, so it can be smaller than the traced full-supply outline (a dam
// rarely full) or bigger (a dam in a wide river, or two dams whose water
// joins).
//
// The best candidate is the one with the largest overlap. Then:
//   none     its damShare is under MIN_DAM_SHARE (0.3), or there is no
//            candidate: Waterbodies doesn't hold this dam. Usually a dam
//            under Waterbodies' 0.45 ha minimum, a dam never seen wet, or an
//            outline traced in the wrong place.
//   matched  waterbodyShare ≥ MATCH_WATERBODY_SHARE (0.7): at least 70 % of
//            the waterbody is this dam, so its wet area is this dam's; and
//            no other waterbody holds MAX_OTHER_DAM_SHARE (0.1) or more of the
//            dam, so the dam isn't spread over several. The 30 % slack is
//            for the historical extent spilling past a traced outline along
//            the inflow and the wall, and for tracing error.
//   merged   otherwise: the waterbody also holds other water (another dam,
//            a river reach, a pan), or the dam is split over waterbodies, so
//            a waterbody's wet area isn't this dam's. Only WOfS over the
//            dam's own outline observes it (R5-C).
// Only a matched dam gets Waterbodies observations (app_dam_observation_load).
import type { Db } from '../../db/tx.js';
import { signedArea2 } from '../../geo/clip.js';
import { GEO_MAX_SWEEP_STEPS, intersectionArea, type Position } from '../../geo/geojson.js';
import type { DamOutlineGeometry } from './handover.js';

export const MIN_DAM_SHARE = 0.3;
export const MATCH_WATERBODY_SHARE = 0.7;
export const MAX_OTHER_DAM_SHARE = 0.1;

export type MatchStatus = 'matched' | 'merged' | 'none';
export interface MatchResult {
	status: MatchStatus;
	/** The best candidate's uid (null for none). */
	uid: string | null;
	damShare: number | null;
	waterbodyShare: number | null;
}
export interface Candidate {
	uid: string;
	geometry: DamOutlineGeometry;
}

/** Every ring of a polygon or multipolygon, as one even-odd region (the parts of a checked MultiPolygon don't overlap). */
const ringsOf = (g: DamOutlineGeometry): Position[][] => (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat());

/** Planar area (degrees²) of a region: each polygon's outer ring less its holes. */
export function planarArea(g: DamOutlineGeometry): number {
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
	let a = 0;
	for (const [outer, ...holes] of polys) a += Math.abs(signedArea2(outer!)) - holes.reduce((h, r) => h + Math.abs(signedArea2(r)), 0);
	return a / 2;
}

/** West, south, east, north. */
export function bboxOf(g: DamOutlineGeometry): [number, number, number, number] {
	let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
	for (const r of ringsOf(g)) for (const [x, y] of r) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
	return [w, s, e, n];
}

/** Too complex to measure (a hostile or huge outline): GEO_MAX_SWEEP_STEPS spent. */
export class MatchTooComplex extends Error {}

/** The match of one dam against its candidates (see the header). */
export function matchDam(dam: DamOutlineGeometry, candidates: readonly Candidate[]): MatchResult {
	const none: MatchResult = { status: 'none', uid: null, damShare: null, waterbodyShare: null };
	const damArea = planarArea(dam);
	if (!(damArea > 0) || !candidates.length) return none;
	const work = { steps: 0 };
	const spend = (n: number) => {
		work.steps += n;
		if (work.steps > GEO_MAX_SWEEP_STEPS) throw new MatchTooComplex('the outlines are too complex to compare');
	};
	const damRings = ringsOf(dam);
	const shares = candidates
		.map((c) => {
			const inter = intersectionArea(damRings, ringsOf(c.geometry), spend);
			const wbArea = planarArea(c.geometry);
			return { uid: c.uid, inter, damShare: Math.min(1, inter / damArea), waterbodyShare: wbArea > 0 ? Math.min(1, inter / wbArea) : 0 };
		})
		.filter((s) => s.inter > 0)
		.sort((a, b) => b.inter - a.inter || (a.uid < b.uid ? -1 : 1));
	const best = shares[0];
	if (!best || best.damShare < MIN_DAM_SHARE) return none;
	const others = shares.slice(1).reduce((s, o) => s + o.damShare, 0);
	const status: MatchStatus = best.waterbodyShare >= MATCH_WATERBODY_SHARE && others < MAX_OTHER_DAM_SHARE ? 'matched' : 'merged';
	return { status, uid: best.uid, damShare: round(best.damShare), waterbodyShare: round(best.waterbodyShare) };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** A dam as app_dam_outlines lists it. */
export interface DamOutlineRow {
	feature_id: string;
	project_id: string;
	geometry: DamOutlineGeometry;
	updated_at: Date;
	status: MatchStatus | null;
	uid: string | null;
	match_stale: boolean;
	waterbodies_newest: string | null;
	wofs_newest: string | null;
}

/** Every traced dam polygon (worker only: no user). */
export async function damOutlines(db: Db): Promise<DamOutlineRow[]> {
	return (
		await db.query<DamOutlineRow>(
			`SELECT feature_id, project_id, geometry, updated_at, status, uid, match_stale,
				to_char(waterbodies_newest, 'YYYY-MM-DD') AS waterbodies_newest, to_char(wofs_newest, 'YYYY-MM-DD') AS wofs_newest
			 FROM app_dam_outlines()`
		)
	).rows;
}

/** The waterbodies whose box meets the dam's (worker only). */
export async function candidatesFor(db: Db, dam: DamOutlineGeometry): Promise<Candidate[]> {
	const [w, s, e, n] = bboxOf(dam);
	return (await db.query<Candidate>('SELECT uid, geometry FROM app_waterbody_candidates($1, $2, $3, $4)', [w, s, e, n])).rows;
}

/** Match one dam and record it; false when the dam changed since it was read (matched again next tick). */
export async function matchAndWrite(db: Db, dam: Pick<DamOutlineRow, 'feature_id' | 'geometry' | 'updated_at'>): Promise<{ applied: boolean; result: MatchResult; dropped: number }> {
	const result = matchDam(dam.geometry, await candidatesFor(db, dam.geometry));
	const { rows } = await db.query<{ applied: boolean; dropped: number }>('SELECT applied, dropped FROM app_dam_match_write($1, $2, $3, $4, $5, $6)', [
		dam.feature_id,
		result.status,
		result.uid,
		result.damShare,
		result.waterbodyShare,
		dam.updated_at
	]);
	return { applied: rows[0]!.applied, result, dropped: rows[0]!.dropped };
}
