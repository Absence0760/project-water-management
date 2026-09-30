// Evidence packs (roadmap WP-3.14, issue #71; docs/evidence-pack.md,
// docs/api.md § Evidence packs, 112_evidence_pack.sql): a draft is made from
// an evidence report that may be issued, frozen as its manifest with the
// manifest's SHA-256; a registered professional signs the draft (the pack
// statement, bound to that hash); an editor issues it, which supersedes the
// version it replaces in the same transaction, and builds, stores and records
// its reproduction bundle there too (bundle.ts, 120_pack_bundle); an issued
// pack is withdrawn, never edited or deleted. GET /verify/:code (verifyRoutes) answers anyone
// with the public fields of a pack that was issued.
//
// Who: viewers and up read (RLS hides an application pack from a viewer who
// can't read its scenario); editors and owners draft, sign, issue, supersede,
// withdraw and delete drafts. Contributors and farmers get 403.
import { createHash } from 'node:crypto';
import {
	ENGINE_VERSION,
	buildPackManifest,
	DISCLAIMER,
	packManifestText,
	packShortCode,
	packSignoffStatement,
	parsePackCode,
	signoffStatementText,
	type EvidenceCheck,
	type EvidenceReport,
	type PackManifest,
	type PackSignoffStatement
} from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange, notFound } from '../http/errors.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { lockProjectRuns } from '../runs/execute.js';
import { RUN_UNVERIFIED, runUnverified } from '../runs/stamp.js';
import { FORECAST_NOT_SIGNABLE, insertSignoff, LEGACY, loadSignableRun, SIGNOFF_SELECT, SignoffBody, type SignoffRow } from '../signoffs/routes.js';
import { packBundleFileName, packDownloadUrl } from '../reports/storage.js';
import { issuePackBundle } from './bundle.js';
import { buildEvidenceReport } from './report.js';

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Most packs a list returns (newest first). */
export const PACKS_LIST_MAX = 200;

const uuid = z.string().regex(UUID, 'must be a UUID');
/** Strict: a pack's id, status, hash and lifecycle are the server's, never the caller's. */
export const PackCreateBody = z
	.object({
		/** The run the report names: an application's scenario run, or the nominated run for baseline evidence. */
		runId: uuid,
		/** The issued pack this draft is a new version of. */
		supersedesId: uuid.optional()
	})
	.strict();
/** Issue takes no body: an empty one, or none. */
export const PackIssueBody = z.object({}).strict();
export const PackWithdrawBody = z.object({
	reason: z
		.string()
		.trim()
		.min(1)
		.max(1000)
		.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters')
});

export type PackStatus = 'draft' | 'issued' | 'superseded' | 'withdrawn';

/** One pack as the API returns it (docs/api.md § Evidence packs). */
export interface PackMeta {
	id: string;
	/** The report's title: the scenario's name, or the project's for baseline evidence. */
	title: string;
	mode: EvidenceReport['mode'];
	scenarioId: string | null;
	baselineRunId: string;
	scenarioRunId: string | null;
	version: number;
	supersedesId: string | null;
	supersededById: string | null;
	status: PackStatus;
	manifestSha256: string;
	/** The manifest hash's first 12 hex digits, `xxxx-xxxx-xxxx` (engine packShortCode). */
	shortCode: string;
	/** The web page that verifies it, `/verify/<shortCode>`; the API's is GET /verify/:code. */
	verifyPath: string;
	reportVersion: string;
	engineVersion: string;
	pdfSha256: string | null;
	pdfPages: number | null;
	bundleSha256: string | null;
	createdAt: string;
	createdBy: string | null;
	issuedAt: string | null;
	issuedBy: string | null;
	/** Why it was withdrawn; null otherwise. */
	statusReason: string | null;
	signoffs: number;
}

const COLUMNS = `p.id, p.manifest->'report'->'identity'->>'title' AS title, p.manifest->'report'->>'mode' AS mode,
	p.scenario_id AS "scenarioId", p.baseline_run_id AS "baselineRunId", p.scenario_run_id AS "scenarioRunId", p.version,
	p.supersedes_pack_id AS "supersedesId", p.superseded_by_pack_id AS "supersededById", p.status, p.manifest_sha256 AS "manifestSha256",
	p.report_version AS "reportVersion", p.engine_version AS "engineVersion", p.pdf_sha256 AS "pdfSha256", p.pdf_pages AS "pdfPages",
	p.bundle_sha256 AS "bundleSha256", p.created_at AS "createdAt", cu.display_name AS "createdBy", p.issued_at AS "issuedAt",
	iu.display_name AS "issuedBy", p.status_reason AS "statusReason",
	(SELECT count(*)::int FROM signoff s WHERE s.pack_id = p.id) AS signoffs`;
const FROM = `FROM evidence_pack p LEFT JOIN app_user cu ON cu.id = p.created_by LEFT JOIN app_user iu ON iu.id = p.issued_by`;

type PackDbRow = Omit<PackMeta, 'shortCode' | 'verifyPath' | 'createdAt' | 'issuedAt'> & { createdAt: Date; issuedAt: Date | null };

function toMeta(r: PackDbRow): PackMeta {
	const shortCode = packShortCode(r.manifestSha256);
	return {
		...r,
		createdAt: r.createdAt.toISOString(),
		issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
		shortCode,
		verifyPath: `/verify/${shortCode}`
	};
}

/** One pack the caller can see, or 404. `lock`: FOR UPDATE, for a change to it. */
async function loadPack(db: Db, projectId: string, packId: string, lock = false): Promise<PackMeta> {
	if (!UUID.test(packId)) throw notFound();
	const { rows } = await db.query<PackDbRow>(
		lock
			? // FOR UPDATE can't take the outer joins' nullable side: lock the pack alone first.
				`WITH l AS (SELECT id FROM evidence_pack WHERE project_id = $1 AND id = $2 FOR UPDATE) SELECT ${COLUMNS} ${FROM} JOIN l ON l.id = p.id`
			: `SELECT ${COLUMNS} ${FROM} WHERE p.project_id = $1 AND p.id = $2`,
		[projectId, packId]
	);
	if (!rows[0]) throw notFound();
	return toMeta(rows[0]);
}

/** The stored manifest, and whether its RFC 8785 text still hashes to the recorded SHA-256 after the jsonb round trip. */
async function storedManifest(db: Db, packId: string): Promise<{ manifest: PackManifest; matches: boolean }> {
	const { rows } = await db.query<{ manifest: PackManifest; sha: string }>('SELECT manifest, manifest_sha256 AS sha FROM evidence_pack WHERE id = $1', [packId]);
	const r = rows[0];
	if (!r) throw notFound();
	return { manifest: r.manifest, matches: sha256(packManifestText(r.manifest)) === r.sha };
}

/** The checks a report fails that stop it being issued, in words, for a 409. */
function notIssuable(report: EvidenceReport, when: string): ApiError {
	const failing: EvidenceCheck[] = report.checks.filter((k) => !k.passed && (k.blocksIssue || k.refuses));
	const what = failing.length ? failing.map((k) => `${k.label} (${k.detail})`).join('; ') : 'the report is not evidence';
	return new ApiError(409, `${when}: ${what}`, { checks: failing.map((k) => ({ id: k.id, label: k.label, detail: k.detail, fix: k.fix })) });
}

/** The pack's sign-off statement as the engine builds it now, with its hash, and why it can't be signed. */
async function packStatementFor(
	db: Db,
	projectId: string,
	pack: PackMeta
): Promise<{ statement: PackSignoffStatement; sha256: string; blocked: string | null; unverified: boolean }> {
	const baseline = await loadSignableRun(db, projectId, pack.baselineRunId);
	const application = pack.scenarioRunId ? await loadSignableRun(db, projectId, pack.scenarioRunId) : null;
	if (!baseline || (pack.scenarioRunId && !application)) throw new ApiError(404, 'the pack’s runs are gone, or you can’t see them');
	const statement = packSignoffStatement({
		id: pack.id,
		version: pack.version,
		manifestSha256: pack.manifestSha256,
		baseline: baseline.run,
		application: application?.run ?? null
	});
	const runs = [baseline, ...(application ? [application] : [])];
	const blocked = runs.some((r) => r.legacy) ? LEGACY : runs.some((r) => r.forecast) ? FORECAST_NOT_SIGNABLE : null;
	return { statement, sha256: sha256(signoffStatementText(statement)), blocked, unverified: runs.some((r) => !r.verified) };
}

/** What still stands between a draft and its issue, from what is stored (the issue route checks the live report as well). */
async function issueChecks(db: Db, projectId: string, pack: PackMeta, manifest: PackManifest) {
	const { sha256: current, unverified } = await packStatementFor(db, projectId, pack);
	const { rowCount } = await db.query('SELECT 1 FROM signoff WHERE pack_id = $1 AND statement_sha256 = $2 LIMIT 1', [pack.id, current]);
	return {
		issuable: manifest.report.issuable && !manifest.report.refused,
		signed: !!rowCount,
		runsVerified: !unverified
	};
}

const audit = (p: Pick<PackMeta, 'id' | 'version' | 'manifestSha256' | 'scenarioId'>, extra: Record<string, unknown> = {}) => ({
	packId: p.id,
	version: p.version,
	shortCode: packShortCode(p.manifestSha256),
	manifestSha256: p.manifestSha256,
	...(p.scenarioId ? { scenarioId: p.scenarioId } : {}),
	...extra
});

export const packRoutes = new Hono<AuthEnv>()
	.post('/:id/packs', async (c) => {
		const id = c.req.param('id');
		const body = PackCreateBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Citing runs: not while a trim or delete of this project's runs is under way.
			await lockProjectRuns(db, id);
			const report = await buildEvidenceReport(db, id, body.runId);
			if (report.refused || !report.issuable) throw notIssuable(report, 'this report can’t be made into an evidence pack');
			const scenarioId = report.identity.application?.scenarioId ?? null;
			let supersedes: PackManifest['pack']['supersedes'] = null;
			let version = 1;
			if (body.supersedesId) {
				const pred = await loadPack(db, id, body.supersedesId, true);
				if (pred.status !== 'issued') throw new ApiError(409, `only an issued pack gets a new version; this one is ${pred.status}`);
				if (pred.scenarioId !== scenarioId)
					throw new ApiError(409, 'a new version is of the same application (or of baseline evidence, for a baseline pack)');
				supersedes = { id: pred.id, manifestSha256: pred.manifestSha256 };
				version = pred.version + 1;
			}
			const packId = crypto.randomUUID();
			const manifest = buildPackManifest({
				pack: { id: packId, version, supersedes },
				project: report.identity.project,
				report,
				engine: { version: ENGINE_VERSION, build: null }
			});
			const manifestSha256 = sha256(packManifestText(manifest));
			await db.query(
				`INSERT INTO evidence_pack (id, project_id, scenario_id, baseline_run_id, scenario_run_id, version, supersedes_pack_id, manifest, manifest_sha256,
					report_version, engine_version, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, app_current_user_id())`,
				[
					packId,
					id,
					scenarioId,
					report.identity.baseline.runId,
					report.identity.application?.runId ?? null,
					version,
					supersedes?.id ?? null,
					JSON.stringify(manifest),
					manifestSha256,
					report.version,
					ENGINE_VERSION
				]
			);
			// The hash must survive the jsonb round trip, or the pack could never be verified from what is stored.
			if (!(await storedManifest(db, packId)).matches) throw new Error('evidence pack manifest does not re-hash after storage');
			const pack = await loadPack(db, id, packId);
			await recordAudit(db, id, 'pack.drafted', audit(pack, { baselineRunId: pack.baselineRunId, scenarioRunId: pack.scenarioRunId }));
			return c.json({ pack }, 201);
		});
	})
	.get('/:id/packs', async (c) => {
		const id = c.req.param('id');
		return withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'viewer');
				const { rows } = await db.query<PackDbRow>(`SELECT ${COLUMNS} ${FROM} WHERE p.project_id = $1 ORDER BY p.created_at DESC, p.id LIMIT $2`, [id, PACKS_LIST_MAX]);
				return c.json({ packs: rows.map(toMeta) });
			},
			{ readOnly: true }
		);
	})
	.get('/:id/packs/:packId', async (c) => {
		const { id, packId } = c.req.param();
		return withUser(
			c.get('userId'),
			async (db) => {
				const role = await requireRole(db, id, 'viewer');
				const pack = await loadPack(db, id, packId);
				const { manifest, matches } = await storedManifest(db, packId);
				const { rows: signoffs } = await db.query<SignoffRow>(`${SIGNOFF_SELECT} WHERE project_id = $1 AND pack_id = $2 ORDER BY signed_at, id`, [id, packId]);
				return c.json({
					pack,
					manifest,
					// False only if the stored manifest was altered past the guard (the owner, by hand).
					manifestMatches: matches,
					signoffs,
					// Only editors issue, so only they get the checklist (it reads both runs, which a viewer may not see).
					issue: pack.status === 'draft' && rank[role] >= rank.editor ? await issueChecks(db, id, pack, manifest) : null
				});
			},
			{ readOnly: true }
		);
	})
	.delete('/:id/packs/:packId', async (c) => {
		const { id, packId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Its runs stop being cited and may be trimmed: under the project's run lock, as a trim is. Taken
			// before the pack's row lock, in the same order as drafting (no deadlock with a draft that supersedes).
			await lockProjectRuns(db, id);
			const pack = await loadPack(db, id, packId, true);
			if (pack.status !== 'draft') throw new ApiError(409, `an ${pack.status} pack is never deleted; withdraw it instead`);
			if (pack.signoffs > 0) throw new ApiError(409, 'a signed draft is kept with its sign-off; withdraw it instead');
			mustChange(await db.query(`DELETE FROM evidence_pack WHERE project_id = $1 AND id = $2 AND status = 'draft'`, [id, packId]));
			await recordAudit(db, id, 'pack.deleted', audit(pack));
			return c.body(null, 204);
		});
	})
	.get('/:id/packs/:packId/signoffs', async (c) => {
		const { id, packId } = c.req.param();
		return withUser(
			c.get('userId'),
			async (db) => {
				const role = await requireRole(db, id, 'viewer');
				const pack = await loadPack(db, id, packId);
				const { statement, sha256: statementSha256, blocked, unverified } = await packStatementFor(db, id, pack);
				const { rows } = await db.query<SignoffRow>(`${SIGNOFF_SELECT} WHERE project_id = $1 AND pack_id = $2 ORDER BY signed_at, id`, [id, packId]);
				return c.json({
					statement,
					statementSha256,
					disclaimer: { version: DISCLAIMER.version, status: DISCLAIMER.status },
					cannotSign:
						rank[role] < rank.editor
							? 'requires editor role'
							: pack.status !== 'draft'
								? `only a draft pack is signed; this one is ${pack.status}`
								: (blocked ?? (unverified ? RUN_UNVERIFIED : null)),
					signoffs: rows
				});
			},
			{ readOnly: true }
		);
	})
	.post('/:id/packs/:packId/signoffs', async (c) => {
		const { id, packId } = c.req.param();
		const body = SignoffBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const pack = await loadPack(db, id, packId, true);
			if (pack.status !== 'draft') throw new ApiError(409, `only a draft pack is signed; this one is ${pack.status}`);
			const { statement, sha256: expected, blocked, unverified } = await packStatementFor(db, id, pack);
			if (blocked) throw new ApiError(409, blocked);
			if (unverified) throw runUnverified();
			const signoff = await insertSignoff(db, id, { packId }, body, statement, expected);
			return c.json({ signoff }, 201);
		});
	})
	.post('/:id/packs/:packId/issue', async (c) => {
		const { id, packId } = c.req.param();
		PackIssueBody.parse((await readJson(c, { optional: true })) ?? {});
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const pack = await loadPack(db, id, packId, true);
			if (pack.status !== 'draft') throw new ApiError(409, `only a draft pack is issued; this one is ${pack.status}`);
			const { manifest, matches } = await storedManifest(db, packId);
			if (!matches) throw new ApiError(409, 'the stored manifest no longer matches its hash, so this pack can’t be issued');
			const checks = await issueChecks(db, id, pack, manifest);
			if (!checks.issuable) throw notIssuable(manifest.report, 'this pack can’t be issued');
			if (!checks.signed)
				throw new ApiError(409, 'the pack has no sign-off of its current statement (none yet, or the statement changed since): sign it, then issue it');
			if (!checks.runsVerified) throw runUnverified();
			// The live report too: what was issuable when drafted (a nomination, the declared rule, the cited ensemble) must still be.
			const live = await buildEvidenceReport(db, id, pack.scenarioRunId ?? pack.baselineRunId);
			if (live.refused || !live.issuable) throw notIssuable(live, 'this pack can’t be issued, since its draft was made');
			const pred = pack.supersedesId ? await loadPack(db, id, pack.supersedesId, true) : null;
			if (pred && pred.status !== 'issued')
				throw new ApiError(409, `the pack this version replaces is ${pred.status} now, so this version can’t supersede it; start a new pack`);
			// One issued pack per application (or per project's baseline evidence): a later one supersedes it (evidence_pack_one_issued).
			const { rows: current } = await db.query<{ version: number }>(
				`SELECT version FROM evidence_pack WHERE project_id = $1 AND status = 'issued' AND scenario_id IS NOT DISTINCT FROM $2 AND id IS DISTINCT FROM $3 LIMIT 1`,
				[id, pack.scenarioId, pred?.id ?? null]
			);
			if (current[0])
				throw new ApiError(
					409,
					`version ${current[0].version} of this ${pack.scenarioId ? 'application' : 'baseline evidence'} is issued; draft a new version of it (supersedesId) instead of a second pack`
				);
			mustChange(await db.query(`UPDATE evidence_pack SET status = 'issued' WHERE project_id = $1 AND id = $2`, [id, packId]));
			// The reproduction bundle (120_pack_bundle), built, stored and recorded in this transaction: no bundle, no issue.
			const bundle = await issuePackBundle(db, id, pack, manifest);
			if (pred) {
				mustChange(
					await db.query(`UPDATE evidence_pack SET status = 'superseded', superseded_by_pack_id = $3 WHERE project_id = $1 AND id = $2`, [id, pred.id, packId])
				);
			}
			const issued = await loadPack(db, id, packId);
			await recordAudit(db, id, 'pack.issued', audit(issued, { bundleSha256: bundle.sha256, ...(pred ? { supersedesId: pred.id, supersedesVersion: pred.version } : {}) }));
			if (pred) await recordAudit(db, id, 'pack.superseded', audit(pred, { byPackId: issued.id, byVersion: issued.version }));
			return c.json({ pack: issued });
		});
	})
	.get('/:id/packs/:packId/bundle', async (c) => {
		// The reproduction bundle (docs/evidence-pack.md § Reproduction): a 302 to a short-lived signed GET, as a report's PDF.
		const { id, packId } = c.req.param();
		const found = await withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'viewer');
				const pack = await loadPack(db, id, packId);
				const { rows } = await db.query<{ key: string | null }>('SELECT bundle_key AS key FROM evidence_pack WHERE project_id = $1 AND id = $2', [id, packId]);
				return { pack, key: rows[0]?.key ?? null };
			},
			{ readOnly: true }
		);
		if (!found.key)
			throw new ApiError(409, found.pack.status === 'draft' ? 'a draft pack has no reproduction bundle: it is built when the pack is issued' : 'this pack was issued without a reproduction bundle');
		const url = await packDownloadUrl(found.key, packBundleFileName(found.pack.shortCode));
		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(url, 302);
	})
	.post('/:id/packs/:packId/withdraw', async (c) => {
		const { id, packId } = c.req.param();
		const body = PackWithdrawBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const pack = await loadPack(db, id, packId, true);
			if (pack.status === 'withdrawn') throw new ApiError(409, 'this pack is already withdrawn');
			mustChange(await db.query(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = $3 WHERE project_id = $1 AND id = $2`, [id, packId, body.reason]));
			const withdrawn = await loadPack(db, id, packId);
			await recordAudit(db, id, 'pack.withdrawn', audit(withdrawn, { from: pack.status, reason: body.reason }));
			return c.json({ pack: withdrawn });
		});
	});

/** What GET /verify/:code returns (app_verify_pack, 112): only what the pack prints. */
export interface PackVerification {
	status: Exclude<PackStatus, 'draft'>;
	version: number;
	issuedAt: string;
	catchment: string;
	engineVersion: string;
	reportVersion: string;
	manifestSha256: string;
	shortCode: string;
	pdfSha256: string | null;
	/** The reproduction bundle's SHA-256 (120_pack_bundle), or null for a pack issued before bundles. */
	bundleSha256: string | null;
	successorSha256: string | null;
	withdrawnReason: string | null;
	methodology: { version: string | null; sha256: string | null };
	errata: { id: string; summary: string }[];
	signers: {
		fullName: string;
		registrationBody: string;
		registrationCategory: string | null;
		registrationField: string | null;
		registrationNo: string;
		signedAt: string;
	}[];
}

/**
 * GET /verify/:code — public: no session. The code is a pack's short code or
 * its full manifest hash, printed on the pack; it isn't a secret. 404 alike
 * for a malformed code, an unknown one, a draft and a pack never issued.
 * Nothing but the printed fields leaves (app_verify_pack). Not cached, so a
 * withdrawal shows at once. The WAF rate-limits it with the rest of the API.
 */
export const verifyRoutes = new Hono().get('/:code', async (c) => {
	const parsed = parsePackCode(c.req.param('code'));
	c.header('Cache-Control', 'no-store');
	if (!parsed) throw notFound();
	const v = await withoutUser(async (db) => (await db.query<{ v: Omit<PackVerification, 'shortCode'> | null }>('SELECT app_verify_pack($1) AS v', [parsed.value])).rows[0]?.v);
	if (!v) throw notFound();
	return c.json({ pack: { ...v, shortCode: packShortCode(v.manifestSha256) } satisfies PackVerification });
});
