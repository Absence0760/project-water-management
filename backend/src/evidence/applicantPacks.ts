// An applicant's own application's evidence packs (roadmap WP-3.15; issue
// #71; 131_applicant_packs.sql; docs/evidence-pack.md § Applicants,
// docs/api.md § Evidence packs → An applicant's packs).
//
// Issuing stays with the project's editors. An application's parties (its
// owner, and whoever they shared it with) read the packs of it that were
// issued (issued, superseded or withdrawn, each with its standing; never a
// draft), and only through SECURITY DEFINER functions that build an
// allowlisted projection of the frozen report: an applicant reads no pack
// row, since the manifest carries every farm. What they get is what verify
// answers, what a pack link shows of its figures, and D2's anonymised units
// (their own by name; every other only as "Farm n" with its change in whole
// percentage points). The mapping below applies the allowlist again field
// by field, so a key the database starts returning never leaves by default.
// Not the PDF, the manifest or the bundle: each is the assessor's copy.
import { packShortCode } from '@water-management/engine';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { arr, num, obj, str, toBand, toSharedPackFigures, toVerify, type SharedBand, type SharedPackFigures } from '../share/links.js';
import type { PackVerification } from './packs.js';

/** One pack of an application as its party sees it (app_applicant_pack_meta). */
export interface ApplicantPackMeta {
	id: string;
	scenarioId: string;
	title: string;
	mode: 'baseline' | 'application';
	version: number;
	status: 'issued' | 'superseded' | 'withdrawn';
	issuedAt: string;
	manifestSha256: string;
	shortCode: string;
	/** The web page that verifies it. */
	verifyPath: string;
	/** Other packs of the same application: the one it replaced, and the one that replaced it. */
	supersedesId: string | null;
	supersededById: string | null;
	withdrawnReason: string | null;
	/** The caller is the application's owner (they list and revoke the links they made). */
	isOwner: boolean;
	/** The application's owner may make a share link to it, while it is issued. */
	canShare: boolean;
}

/** One of the applicant's own units in the pack (D2: by name, in full). */
export interface ApplicantPackOwnUnit {
	name: string;
	kind: 'farm' | 'user';
	/** 'application': a node the application adds. */
	onlyIn: 'application' | null;
	/** Share of demand supplied (0–1), time and annual reliability; A = baseline, B = application. */
	suppliedA: number | null;
	suppliedB: number | null;
	timeReliabilityA: number | null;
	timeReliabilityB: number | null;
	annualReliabilityA: number | null;
	annualReliabilityB: number | null;
	/** Change in share supplied, percentage points, with its band. */
	change: { run: number | null; band: SharedBand | null; worse: { k: number; n: number } | null } | null;
}

/** Another unit in the pack, anonymous (D2): its kind, a number, and its change in share supplied. */
export interface ApplicantPackOtherUnit {
	kind: 'farm' | 'user';
	/** "Farm 3": numbered per kind by a hash of its id, never by name or place. */
	n: number;
	/** Whole percentage points. */
	changePts: number;
}

/** GET …/scenarios/:sid/packs/:packId. */
export interface ApplicantPack {
	pack: ApplicantPackMeta;
	/** Exactly GET /verify/:code's answer. */
	verify: PackVerification;
	/** What a pack link shows of the frozen report, for every standing. */
	figures: SharedPackFigures | null;
	/** null when the report changed a baseline assumption (the figures that move with it could read another unit out). */
	units: { own: ApplicantPackOwnUnit[]; others: ApplicantPackOtherUnit[] } | null;
}

export interface ApplicantPackRow {
	pack: Record<string, unknown>;
	verify: Record<string, unknown>;
	figures: Record<string, unknown> | null;
	units: Record<string, unknown> | null;
}

const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const unitKind = (v: unknown): 'farm' | 'user' => (v === 'user' ? 'user' : 'farm');

/** The meta field by field. */
export function toApplicantPackMeta(raw: Record<string, unknown>): ApplicantPackMeta {
	const manifest = typeof raw.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.manifestSha256) ? raw.manifestSha256 : '';
	const shortCode = manifest ? packShortCode(manifest) : '';
	const status = raw.status === 'superseded' || raw.status === 'withdrawn' ? raw.status : 'issued';
	return {
		id: uuidOrNull(raw.id) ?? '',
		scenarioId: uuidOrNull(raw.scenarioId) ?? '',
		title: str(raw.title) ?? '',
		mode: raw.mode === 'baseline' ? 'baseline' : 'application',
		version: num(raw.version) ?? 0,
		status,
		issuedAt: str(raw.issuedAt) ?? '',
		manifestSha256: manifest,
		shortCode,
		verifyPath: `/verify/${shortCode}`,
		supersedesId: uuidOrNull(raw.supersedesId),
		supersededById: uuidOrNull(raw.supersededById),
		withdrawnReason: status === 'withdrawn' ? str(raw.withdrawnReason) : null,
		isOwner: raw.isOwner === true,
		canShare: status === 'issued' && raw.isOwner === true && raw.canShare === true
	};
}

/** The units field by field (app_applicant_pack_units, 131). */
export function toApplicantPackUnits(raw: Record<string, unknown>): NonNullable<ApplicantPack['units']> {
	return {
		own: arr(raw.own).map((x) => {
			const u = obj(x);
			const c = u.change && typeof u.change === 'object' ? obj(u.change) : null;
			const w = c && c.worse && typeof c.worse === 'object' ? obj(c.worse) : null;
			return {
				name: str(u.name) ?? '',
				kind: unitKind(u.kind),
				onlyIn: u.onlyIn === 'application' ? 'application' : null,
				suppliedA: num(u.suppliedA),
				suppliedB: num(u.suppliedB),
				timeReliabilityA: num(u.timeReliabilityA),
				timeReliabilityB: num(u.timeReliabilityB),
				annualReliabilityA: num(u.annualReliabilityA),
				annualReliabilityB: num(u.annualReliabilityB),
				change: c ? { run: num(c.run), band: toBand(c.band), worse: w ? { k: num(w.k) ?? 0, n: num(w.n) ?? 0 } : null } : null
			};
		}),
		others: arr(raw.others).flatMap((x) => {
			const u = obj(x);
			const n = num(u.n);
			const pts = num(u.changePts);
			// Whole points only, whatever the row says.
			return n === null || pts === null ? [] : [{ kind: unitKind(u.kind), n, changePts: Math.round(pts) + 0 }];
		})
	};
}

export function toApplicantPack(r: ApplicantPackRow): ApplicantPack {
	return {
		pack: toApplicantPackMeta(obj(r.pack)),
		verify: toVerify(obj(r.verify)),
		figures: r.figures ? toSharedPackFigures(r.figures) : null,
		units: r.units ? toApplicantPackUnits(r.units) : null
	};
}

/** The scenario, as the caller reads it (RLS), or 404. */
async function readableScenario(db: Db, projectId: string, sid: string): Promise<void> {
	if (!UUID.test(sid)) throw notFound();
	const { rows } = await db.query('SELECT 1 FROM scenario WHERE id = $1 AND project_id = $2', [sid, projectId]);
	if (!rows[0]) throw notFound();
}

/**
 * GET /projects/:id/scenarios/:sid/packs and …/packs/:packId: min
 * contributor; the database decides the rest (only the application's
 * parties, only packs that were issued). Anyone else, an editor who isn't a
 * party included (they read the packs themselves, GET …/packs), gets an
 * empty list or 404.
 */
export const applicantPackRoutes = new Hono<AuthEnv>()
	.get('/:id/scenarios/:sid/packs', async (c) => {
		const { id, sid } = c.req.param();
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'contributor');
				await readableScenario(db, id, sid);
				const { rows } = await db.query<{ m: Record<string, unknown> }>('SELECT m FROM app_applicant_packs($1, $2) m', [id, sid]);
				return c.json({ packs: rows.map((r) => toApplicantPackMeta(obj(r.m))) });
			},
			{ readOnly: true }
		);
	})
	.get('/:id/scenarios/:sid/packs/:packId', async (c) => {
		const { id, sid, packId } = c.req.param();
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'contributor');
				await readableScenario(db, id, sid);
				if (!UUID.test(packId)) throw notFound();
				const { rows } = await db.query<ApplicantPackRow>('SELECT * FROM app_applicant_pack($1, $2)', [id, packId]);
				const row = rows[0];
				// Not a party, not issued, or a pack of another application: the same 404.
				if (!row || obj(row.pack).scenarioId !== sid) throw notFound();
				c.header('Cache-Control', 'no-store');
				return c.json(toApplicantPack(row));
			},
			{ readOnly: true }
		);
	});
