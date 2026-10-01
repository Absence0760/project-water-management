// An applicant's own application's evidence packs (roadmap WP-3.15; issue
// #71; 131_applicant_packs.sql, 135_pack_security.sql; docs/evidence-pack.md § Applicants,
// docs/api.md § Evidence packs → An applicant's packs).
//
// Issuing stays with the project's editors. An application's parties (its
// owner, and whoever they shared it with) read the packs of it that were
// issued (issued, superseded or withdrawn, each with its standing; never a
// draft), and only through SECURITY DEFINER functions that build an
// allowlisted projection of the frozen report: an applicant reads no pack
// row, since the manifest carries every farm. What they get is what verify
// answers, what a pack link shows of its figures, and D2's anonymised units
// (their own by name; every other farm or water user downstream of them,
// under the anonymous name the results view gives it, with its change in
// whole percentage points). The database returns the other units' node ids
// to this server only: the route keeps those downstream of the application
// in the application run's stored model and names them exactly as
// scenarios/applicantResults.ts does (projectBaseForApplicant over the run's
// published base, downstreamOf), then drops the ids. The mapping below
// applies the allowlist again field by field, so a key the database starts
// returning never leaves by default.
// Not the PDF, the manifest or the bundle: each is the assessor's copy. Their
// own printable copy instead (165_applicant_copy): their own pack page printed
// as them, with its own SHA-256 (POST/GET …/packs/:packId/pdf below,
// jobs/handlers/applicant-pack-render.ts).
import { packShortCode, type ProjectModel } from '@water-management/engine';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { enqueueJob } from '../jobs/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { applicantCopyDedupeKey } from './applicantCopy.js';
import { REPORT_MAX_ATTEMPTS } from '../reports/store.js';
import { applicantPackFileName, packDownloadUrl } from '../reports/storage.js';
import { z } from 'zod';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { projectBaseForApplicant } from '../scenarios/applicant.js';
import { downstreamOf } from '../scenarios/applicantResults.js';
import { loadBaseInput } from '../scenarios/execute.js';
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

/** Another unit in the pack downstream of the application, anonymous (D2): its kind, the results view's name for it, and its change in share supplied. */
export interface ApplicantPackOtherUnit {
	kind: 'farm' | 'user';
	/** "Farm 3": the anonymous name /base and the results view give it (projectBaseForApplicant). */
	name: string;
	/** Whole percentage points. */
	changePts: number;
}

/** A unit of the pack's other units as the database answers it, for the server only (it carries the node id). */
export interface ApplicantPackOtherRow {
	nodeId: string;
	kind: 'farm' | 'user';
	changePts: number;
}

/** How the route names and filters the other units: the results view's names, and what lies downstream of the application. */
export interface OthersNaming {
	/** Node id → anonymous name, in the base projection's node order. */
	names: Map<string, string>;
	/** The node ids downstream of the application's own and added nodes in the application run. */
	downstream: Set<string>;
}

/**
 * The applicant's printable copy of the pack (165_applicant_copy): `ready`
 * (recorded: its SHA-256, pages and when), `rendering` (the caller's request
 * is queued or running), `failed` (their last request gave up: `error`), or
 * `none` (never asked for).
 */
export interface ApplicantCopyState {
	status: 'ready' | 'rendering' | 'failed' | 'none';
	sha256: string | null;
	pages: number | null;
	renderedAt: string | null;
	error: string | null;
}

/** The copy's state as the caller reads it (RLS: the copy is the pack's parties'; the jobs their own). */
export async function applicantCopyState(db: Db, projectId: string, packId: string): Promise<ApplicantCopyState> {
	const { rows } = await db.query<{ sha256: string; pages: number; renderedAt: Date }>(
		'SELECT pdf_sha256 AS sha256, pdf_pages AS pages, rendered_at AS "renderedAt" FROM evidence_pack_applicant_copy WHERE project_id = $1 AND pack_id = $2',
		[projectId, packId]
	);
	const c = rows[0];
	if (c) return { status: 'ready', sha256: c.sha256, pages: c.pages, renderedAt: c.renderedAt.toISOString(), error: null };
	const { rows: jobs } = await db.query<{ status: string; error: string | null }>(
		`SELECT status, last_error AS error FROM job WHERE project_id = $1 AND kind = 'applicant_pack_render' AND payload->>'packId' = $2
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[projectId, packId]
	);
	const none = { sha256: null, pages: null, renderedAt: null };
	if (!jobs[0]) return { status: 'none', ...none, error: null };
	if (jobs[0].status === 'dead') return { status: 'failed', ...none, error: jobs[0].error };
	return { status: 'rendering', ...none, error: null };
}

/** GET …/scenarios/:sid/packs/:packId. */
export interface ApplicantPack {
	pack: ApplicantPackMeta;
	/** Exactly GET /verify/:code's answer. */
	verify: PackVerification;
	/** What a pack link shows of the frozen report, for every standing. */
	figures: SharedPackFigures | null;
	/**
	 * null when the report changed a baseline assumption (the figures that
	 * move with it could read another unit out). `others` is null when the
	 * application run's base is no longer a published run, so the results
	 * view's names can't be given (the page says so).
	 */
	units: { own: ApplicantPackOwnUnit[]; others: ApplicantPackOtherUnit[] | null } | null;
}

export interface ApplicantPackRow {
	pack: Record<string, unknown>;
	verify: Record<string, unknown>;
	figures: Record<string, unknown> | null;
	units: Record<string, unknown> | null;
	/** Server only (never returned): the application run the pack froze. */
	application_run_id: string | null;
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

/** The other units' rows field by field, for the server only. */
export function otherRows(raw: Record<string, unknown>): ApplicantPackOtherRow[] {
	return arr(raw.others).flatMap((x) => {
		const u = obj(x);
		const nodeId = str(u.nodeId);
		const pts = num(u.changePts);
		return nodeId === null || pts === null ? [] : [{ nodeId, kind: unitKind(u.kind), changePts: Math.round(pts) + 0 }];
	});
}

/**
 * The other units the applicant sees: only those downstream of the
 * application, each under the results view's anonymous name, in its order;
 * never an id. null (not shown) without a naming.
 */
export function nameOthers(rows: readonly ApplicantPackOtherRow[], naming: OthersNaming | null): ApplicantPackOtherUnit[] | null {
	if (!naming) return null;
	const byId = new Map(rows.map((r) => [r.nodeId, r]));
	return [...naming.names].flatMap(([id, name]) => {
		const r = byId.get(id);
		return r && naming.downstream.has(id) ? [{ kind: r.kind, name, changePts: r.changePts }] : [];
	});
}

/** The own units the pack froze (164, `units.ownNodeIds`), for the server only: never returned. */
export const frozenOwn = (raw: Record<string, unknown>): string[] => arr(raw.ownNodeIds).flatMap((x) => (typeof x === 'string' && UUID.test(x) ? [x] : []));

/** The units field by field (app_applicant_pack_units, 131 and 135), the others named and filtered by `naming`. */
export function toApplicantPackUnits(raw: Record<string, unknown>, naming: OthersNaming | null): NonNullable<ApplicantPack['units']> {
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
		others: nameOthers(otherRows(raw), naming)
	};
}

export function toApplicantPack(r: Omit<ApplicantPackRow, 'application_run_id'>, naming: OthersNaming | null): ApplicantPack {
	return {
		pack: toApplicantPackMeta(obj(r.pack)),
		verify: toVerify(obj(r.verify)),
		figures: r.figures ? toSharedPackFigures(r.figures) : null,
		units: r.units ? toApplicantPackUnits(r.units, naming) : null
	};
}

/**
 * The results view's naming for the pack's application run
 * (scenarios/results.ts and applicantResults.ts, the same steps): its stored
 * model through app_application_run_results (118), its published base as a
 * contributor reads it, the anonymous names projectBaseForApplicant gives
 * the other units for the application's own units as the pack froze them
 * (`own`, 164: never the links its owner holds now), and what lies
 * downstream of those and the nodes the run adds. null when the run or its
 * published base can't be read (the base was unpublished since).
 */
async function othersNaming(db: Db, projectId: string, sid: string, runId: string | null, own: readonly string[]): Promise<OthersNaming | null> {
	if (!runId) return null;
	const { rows } = await db.query<{ model: ProjectModel | null; baseRunId: string | null }>(
		'SELECT model, base_run_id AS "baseRunId" FROM app_application_run_results($1, $2, $3)',
		[projectId, sid, runId]
	);
	const r = rows[0];
	if (!r?.model || !r.baseRunId) return null;
	let base;
	try {
		base = await loadBaseInput(db, projectId, r.baseRunId, 'contributor');
	} catch (err) {
		// No longer a published run (404/409): the names can't be the results view's, so none are shown, and the page says why.
		if (err instanceof ApiError && (err.status === 404 || err.status === 409)) return null;
		throw err;
	}
	const view = projectBaseForApplicant(base, own);
	const anonymous = new Set(view.anonymisedNodeIds);
	const names = new Map(view.model.nodes.filter((n) => anonymous.has(n.id)).map((n) => [n.id, n.name]));
	const baseIds = new Set(base.model.nodes.map((n) => n.id));
	const runIds = new Set(r.model.nodes.map((n) => n.id));
	const mine = [...own, ...r.model.nodes.filter((n) => !baseIds.has(n.id)).map((n) => n.id)].filter((id) => runIds.has(id));
	return { names, downstream: downstreamOf(r.model.nodes, mine) };
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
				const naming = row.units ? await othersNaming(db, id, sid, row.application_run_id, frozenOwn(obj(row.units))) : null;
				c.header('Cache-Control', 'no-store');
				return c.json({ ...toApplicantPack(row, naming), copy: await applicantCopyState(db, id, packId) });
			},
			{ readOnly: true }
		);
	})
	// The applicant's printable copy (165_applicant_copy): ask for it (once recorded, it stands), then download it.
	.post('/:id/scenarios/:sid/packs/:packId/pdf', async (c) => {
		const { id, sid, packId } = c.req.param();
		z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'contributor');
			await partyPack(db, id, sid, packId);
			const copy = await applicantCopyState(db, id, packId);
			if (copy.status === 'ready' || copy.status === 'rendering') return { copy, jobId: null };
			const { job, created } = await enqueueJob(db, {
				projectId: id,
				kind: 'applicant_pack_render',
				payload: { packId },
				dedupeKey: applicantCopyDedupeKey(packId, c.get('userId')),
				maxAttempts: REPORT_MAX_ATTEMPTS
			});
			return { copy: { ...copy, status: 'rendering' as const, error: null }, jobId: created ? job.id : null };
		});
		if (result.jobId) await wakeWorker(result.jobId);
		return c.json({ copy: result.copy }, result.copy.status === 'ready' ? 200 : 202);
	})
	.get('/:id/scenarios/:sid/packs/:packId/pdf', async (c) => {
		const { id, sid, packId } = c.req.param();
		const found = await withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'contributor');
				const meta = await partyPack(db, id, sid, packId);
				const { rows } = await db.query<{ key: string }>('SELECT pdf_key AS key FROM evidence_pack_applicant_copy WHERE project_id = $1 AND pack_id = $2', [id, packId]);
				return { meta, key: rows[0]?.key ?? null };
			},
			{ readOnly: true }
		);
		if (!found.key) throw new ApiError(409, 'your printable copy of this pack isn’t ready: ask for it first (POST …/pdf)');
		const url = await packDownloadUrl(found.key, applicantPackFileName(found.meta.version, found.meta.shortCode));
		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(url, 302);
	});

/** One issued pack of this application, for one of its parties (app_applicant_pack_meta), or 404 alike. */
async function partyPack(db: Db, projectId: string, sid: string, packId: string): Promise<ApplicantPackMeta> {
	await readableScenario(db, projectId, sid);
	if (!UUID.test(packId)) throw notFound();
	const { rows } = await db.query<{ m: Record<string, unknown> | null }>('SELECT app_applicant_pack_meta($1, $2) AS m', [projectId, packId]);
	const meta = rows[0]?.m ? toApplicantPackMeta(rows[0].m) : null;
	if (!meta || meta.scenarioId !== sid) throw notFound();
	return meta;
}
