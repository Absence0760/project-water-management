// /projects/:id/allocations — registered and licensed water-use volumes per
// farm or water user, and how a run's modelled use compares with them
// (roadmap WP-3.10 first slice; docs/allocations.md, docs/api.md
// § Allocations). Viewers read volumes; holder names only for editors and
// owners (decision D3, allocation_holder's RLS in 038_allocations.sql); editors
// write. Farmers get 403 here like on every viewer route: RLS already scopes
// them to their own farms for when the farm view shows their allocation.
//
// The app never decides whether a use is lawful: every response and screen
// says "modelled use" against "registered volume".
import { createHash } from 'node:crypto';
import { ALLOCATION_MODES, compareAllocations, DEFAULT_ALLOCATION_TOLERANCE, fromEpochDay, toEpochDay, type AllocationMode, type RunAllocations } from '@water-management/engine';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { attachment, collectCsv, csvRow, exportFilename } from '../export/csv.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange } from '../http/errors.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { mergeSettings } from '../projects/settings.js';
import {
	AUTHORISATIONS,
	CONDITION_MAX_CHARS,
	CONDITIONS_MAX,
	CONDITIONS_SEPARATOR,
	IMPORT_MAX_CHARS,
	ImportRefused,
	matchRow,
	parseAllocationTable,
	PURPOSES,
	TEMPLATE_HEADERS,
	WATER_SOURCES,
	type AllocationSourceKind,
	type KnownMatch,
	type MatchedBy,
	type MatchNode,
	type ParsedRow
} from './parse.js';
import { runUseNodes } from './runUse.js';

/** Most allocations per project (a catchment's WARMS extract is hundreds of rows, not thousands). */
export const ALLOCATIONS_PER_PROJECT_MAX = 5000;

const noNul = (s: string) => !s.includes('\u0000');
const text = (max: number) => z.string().trim().max(max).refine(noNul, 'cannot contain NUL characters');
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a date');
const volume = z.number().finite().min(0).lt(1e12);

/**
 * An allocation's fields, without defaults: a PATCH changes only what it sends.
 * (zod 4's .partial() keeps a field's .default(), so a PATCH built from the
 * create schema reset every field it didn't send, the holder's name and the
 * registration number included; issue #72.)
 */
const FIELDS = {
	nodeId: z.string().uuid().nullable(),
	registrationNo: text(103),
	propertyRef: text(200),
	/** The registered user's name; '' = none. Editors only (D3). */
	holder: text(200),
	authorisation: z.enum(AUTHORISATIONS as [string, ...string[]]),
	purpose: z.enum(PURPOSES as [string, ...string[]]),
	waterSource: z.enum(WATER_SOURCES as [string, ...string[]]),
	volumeM3PerYear: volume,
	storageM3: volume.nullable(),
	validFrom: isoDate.nullable(),
	validTo: isoDate.nullable(),
	reference: text(500),
	// Licence conditions (103, issue #72): shown; a cap run applies months and maxRateM3s (engine ≥ 1.37.0).
	months: z
		.array(z.number().int().min(1).max(12))
		.min(1)
		.max(12)
		.refine((m) => new Set(m).size === m.length, 'a month is listed twice')
		.transform((m) => [...m].sort((a, b) => a - b))
		.nullable(),
	maxRateM3s: z.number().finite().min(0).lt(1e6).nullable(),
	conditions: z.array(text(CONDITION_MAX_CHARS).pipe(z.string().min(1, 'a condition is empty'))).max(CONDITIONS_MAX, `at most ${CONDITIONS_MAX} conditions`)
};
const datesInOrder = (b: { validFrom?: string | null; validTo?: string | null }) => !b.validFrom || !b.validTo || b.validFrom <= b.validTo;
const CreateBody = z
	.object({
		...FIELDS,
		registrationNo: FIELDS.registrationNo.default(''),
		propertyRef: FIELDS.propertyRef.default(''),
		holder: FIELDS.holder.default(''),
		purpose: FIELDS.purpose.default('irrigation'),
		storageM3: FIELDS.storageM3.default(null),
		validFrom: FIELDS.validFrom.default(null),
		validTo: FIELDS.validTo.default(null),
		reference: FIELDS.reference.default(''),
		months: FIELDS.months.default(null),
		maxRateM3s: FIELDS.maxRateM3s.default(null),
		conditions: FIELDS.conditions.default([])
	})
	.strict()
	.refine(datesInOrder, { message: 'valid from is after valid to', path: ['validFrom'] });
const PatchBody = z
	.object(FIELDS)
	.partial()
	.strict()
	.refine((b) => Object.keys(b).length > 0, 'send at least one field')
	.refine(datesInOrder, { message: 'valid from is after valid to', path: ['validFrom'] });

const ImportBody = z
	.object({
		kind: z.enum(['warms_extract', 'csv']),
		fileName: text(255).pipe(z.string().min(1, 'file name is required')),
		text: z.string().max(IMPORT_MAX_CHARS, `the file is larger than ${IMPORT_MAX_CHARS / 1024 / 1024} MB`),
		reference: text(500).default('')
	})
	.strict();
const CommitBody = ImportBody.extend({
	/** Manual matches from the preview, by file line: a node id, or null to leave the row unmatched. */
	matches: z.record(z.string().regex(/^\d+$/), z.string().uuid().nullable()).default({})
}).strict();

/** A one-off band for the comparison (`?tolerance=`); absent = the project's settings.allocationTolerance. */
const TOLERANCE = z.coerce.number().min(0).lt(1).optional();

/** The fields of an allocation a run reads (the engine's AllocationEntry, runs/execute.ts allocationsForRun). */
const RUN_INPUT_FIELDS = ['nodeId', 'waterSource', 'volumeM3PerYear', 'storageM3', 'validFrom', 'validTo'] as const;

/**
 * Allocations are part of every run's input since engine 1.18.0 (the model's
 * `allocations`, runs/execute.ts): a change to what the run reads is a change
 * to the project's inputs, so the Runs tab says the latest run is out of date
 * (project.updated_at, as a model save does).
 */
async function touchRunInputs(db: Db, projectId: string) {
	await db.query('UPDATE project SET updated_at = now() WHERE id = $1', [projectId]);
}

const ALLOCATION_SELECT = `SELECT a.id, a.node_id AS "nodeId", n.name AS "nodeName", a.source_id AS "sourceId",
	a.registration_no AS "registrationNo", a.property_ref AS "propertyRef", h.user_display AS holder,
	a.authorisation, a.purpose, a.water_source AS "waterSource", a.volume_m3_year AS "volumeM3PerYear",
	a.storage_m3 AS "storageM3", a.valid_from AS "validFrom", a.valid_to AS "validTo", a.reference,
	a.months::int[] AS months, a.max_rate_m3s AS "maxRateM3s", a.conditions,
	a.created_at AS "createdAt", a.updated_at AS "updatedAt"
	FROM allocation a
	LEFT JOIN node n ON n.id = a.node_id
	LEFT JOIN allocation_holder h ON h.allocation_id = a.id`;

export interface AllocationRow {
	id: string;
	nodeId: string | null;
	nodeName: string | null;
	sourceId: string | null;
	registrationNo: string;
	propertyRef: string;
	/** null when there is none, or the caller may not see it (canSeeHolders false). */
	holder: string | null;
	authorisation: string;
	purpose: string;
	waterSource: 'surface' | 'groundwater';
	volumeM3PerYear: number;
	storageM3: number | null;
	validFrom: string | null;
	validTo: string | null;
	reference: string;
	/** Licence conditions (103): calendar months of use (null = none stated), the most it may take at once (m³/s), conditions in words. */
	months: number[] | null;
	maxRateM3s: number | null;
	conditions: string[];
	createdAt: string;
	updatedAt: string;
}

const SOURCE_SELECT = `SELECT s.id, s.kind, s.file_name AS "fileName", s.sha256, s.reference, s.imported_at AS "importedAt",
	u.display_name AS "importedBy", (SELECT count(*)::int FROM allocation a WHERE a.source_id = s.id) AS rows
	FROM allocation_source s LEFT JOIN app_user u ON u.id = s.imported_by`;

const allocationId = (aid: string) => {
	if (!UUID.test(aid)) throw new ApiError(404, 'not found');
	return aid;
};

async function loadAllocations(db: Db, projectId: string): Promise<AllocationRow[]> {
	const { rows } = await db.query<AllocationRow>(`${ALLOCATION_SELECT} WHERE a.project_id = $1 ORDER BY n.name NULLS FIRST, a.registration_no, a.id`, [
		projectId
	]);
	return rows;
}

async function loadAllocation(db: Db, projectId: string, aid: string): Promise<AllocationRow> {
	const { rows } = await db.query<AllocationRow>(`${ALLOCATION_SELECT} WHERE a.project_id = $1 AND a.id = $2`, [projectId, aid]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

/** The project's farms and water users, for matching. */
async function matchNodes(db: Db, projectId: string): Promise<MatchNode[]> {
	const { rows } = await db.query<MatchNode>(`SELECT id, name FROM node WHERE project_id = $1 AND kind IN ('farm', 'user') ORDER BY name, id`, [projectId]);
	return rows;
}

/** A node id that must be one of the project's farms or water users. */
async function checkNode(db: Db, projectId: string, nodeId: string | null | undefined) {
	if (!nodeId) return;
	const { rows } = await db.query('SELECT 1 FROM node WHERE project_id = $1 AND id = $2 AND kind IN (\'farm\', \'user\')', [projectId, nodeId]);
	if (!rows[0]) throw new ApiError(400, 'nodeId is not a farm or water user of this project');
}

async function countAllocations(db: Db, projectId: string): Promise<number> {
	const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM allocation WHERE project_id = $1', [projectId]);
	return rows[0]!.n;
}

async function setHolder(db: Db, projectId: string, aid: string, holder: string) {
	if (holder.trim() === '') await db.query('DELETE FROM allocation_holder WHERE allocation_id = $1', [aid]);
	else
		await db.query(
			`INSERT INTO allocation_holder (allocation_id, project_id, user_display) VALUES ($1, $2, $3)
			 ON CONFLICT (allocation_id) DO UPDATE SET user_display = EXCLUDED.user_display`,
			[aid, projectId, holder.trim()]
		);
}

export interface PreviewRow extends ParsedRow {
	nodeId: string | null;
	matchedBy: MatchedBy | 'manual';
	/** Registration numbers already in the project: importing adds a second volume. */
	alreadyInProject: boolean;
}

/** Parse, hash and match a file; the preview and the commit both start here. */
async function prepareImport(db: Db, projectId: string, body: z.infer<typeof ImportBody>, manual: Record<string, string | null> = {}) {
	let table;
	try {
		table = parseAllocationTable(body.text, body.kind as AllocationSourceKind);
	} catch (err) {
		if (err instanceof ImportRefused) throw new ApiError(422, err.message);
		throw err;
	}
	const sha256 = createHash('sha256').update(body.text, 'utf8').digest('hex');
	const { rows: dup } = await db.query<{ fileName: string; importedAt: Date; timeZone: string | null }>(
		`SELECT file_name AS "fileName", imported_at AS "importedAt", (SELECT p.time_zone FROM project p WHERE p.id = $1) AS "timeZone"
		 FROM allocation_source WHERE project_id = $1 AND sha256 = $2`,
		[projectId, sha256]
	);
	if (dup[0])
		throw new ApiError(409, `this file was already imported (as “${dup[0].fileName}” on ${localDate(new Date(dup[0].importedAt), dup[0].timeZone ?? DEFAULT_TIME_ZONE)}); delete that import first to re-import it`);
	const nodes = await matchNodes(db, projectId);
	const { rows: known } = await db.query<KnownMatch>(
		'SELECT registration_no AS "registrationNo", property_ref AS "propertyRef", node_id AS "nodeId" FROM allocation WHERE project_id = $1 AND node_id IS NOT NULL',
		[projectId]
	);
	const { rows: regs } = await db.query<{ r: string }>("SELECT DISTINCT lower(registration_no) AS r FROM allocation WHERE project_id = $1 AND registration_no <> ''", [
		projectId
	]);
	const existing = new Set(regs.map((x) => x.r));
	const nodeIds = new Set(nodes.map((n) => n.id));
	const rows: PreviewRow[] = table.rows.map((r) => {
		const line = String(r.line);
		const auto = matchRow(r, nodes, known);
		let nodeId = auto.nodeId;
		let matchedBy: PreviewRow['matchedBy'] = auto.matchedBy;
		if (Object.hasOwn(manual, line)) {
			const m = manual[line]!;
			if (m !== null && !nodeIds.has(m)) throw new ApiError(400, `line ${line}: the chosen node is not a farm or water user of this project`);
			nodeId = m;
			matchedBy = m === null ? null : 'manual';
		}
		return { ...r, nodeId, matchedBy, alreadyInProject: !!r.registrationNo && existing.has(r.registrationNo.toLowerCase()) };
	});
	const valid = rows.filter((r) => r.errors.length === 0);
	return {
		sha256,
		columns: table.columns,
		ignoredColumns: table.ignoredColumns,
		rows,
		nodes,
		summary: {
			rows: rows.length,
			valid: valid.length,
			invalid: rows.length - valid.length,
			matched: valid.filter((r) => r.nodeId !== null).length,
			unmatched: valid.filter((r) => r.nodeId === null).length
		}
	};
}

function csvResponse(c: Context, body: string, filename: string) {
	return c.body(body, 200, {
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition': attachment(filename),
		'Cache-Control': 'no-store'
	});
}

export const allocationRoutes = new Hono<AuthEnv>()
	.get('/:id/allocations', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			const { rows: sources } = await db.query(`${SOURCE_SELECT} WHERE s.project_id = $1 ORDER BY s.imported_at DESC, s.id`, [id]);
			const allocations = await loadAllocations(db, id);
			// The farms and water users an allocation can be matched to.
			const nodes = await matchNodes(db, id);
			return c.json({ allocations, sources, nodes, canSeeHolders: rank[role] >= rank.editor });
		});
	})
	.post('/:id/allocations', async (c) => {
		const id = c.req.param('id');
		const body = CreateBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			await checkNode(db, id, body.nodeId);
			if ((await countAllocations(db, id)) >= ALLOCATIONS_PER_PROJECT_MAX)
				throw new ApiError(409, `this project has reached the limit of ${ALLOCATIONS_PER_PROJECT_MAX} allocations`);
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO allocation (project_id, node_id, registration_no, property_ref, authorisation, purpose, water_source,
					volume_m3_year, storage_m3, valid_from, valid_to, reference, months, max_rate_m3s, conditions)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb) RETURNING id`,
				[id, body.nodeId, body.registrationNo, body.propertyRef, body.authorisation, body.purpose, body.waterSource, body.volumeM3PerYear, body.storageM3, body.validFrom, body.validTo, body.reference, body.months, body.maxRateM3s, JSON.stringify(body.conditions)]
			);
			await touchRunInputs(db, id);
			const aid = rows[0]!.id;
			await setHolder(db, id, aid, body.holder);
			await recordAudit(db, id, 'allocation.created', { allocationId: aid, registrationNo: body.registrationNo, nodeId: body.nodeId, waterSource: body.waterSource, volumeM3PerYear: body.volumeM3PerYear });
			return c.json({ allocation: await loadAllocation(db, id, aid) }, 201);
		});
	})
	.patch('/:id/allocations/:aid', async (c) => {
		const { id } = c.req.param();
		const aid = allocationId(c.req.param('aid'));
		const body = PatchBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const before = await loadAllocation(db, id, aid);
			if (!datesInOrder({ validFrom: body.validFrom !== undefined ? body.validFrom : before.validFrom, validTo: body.validTo !== undefined ? body.validTo : before.validTo }))
				throw new ApiError(400, 'valid from is after valid to');
			await checkNode(db, id, body.nodeId);
			const cols: Record<string, string> = {
				nodeId: 'node_id',
				registrationNo: 'registration_no',
				propertyRef: 'property_ref',
				authorisation: 'authorisation',
				purpose: 'purpose',
				waterSource: 'water_source',
				volumeM3PerYear: 'volume_m3_year',
				storageM3: 'storage_m3',
				validFrom: 'valid_from',
				validTo: 'valid_to',
				reference: 'reference',
				months: 'months',
				maxRateM3s: 'max_rate_m3s',
				conditions: 'conditions'
			};
			const sets: string[] = [];
			const values: unknown[] = [id, aid];
			for (const [k, col] of Object.entries(cols)) {
				const v = (body as Record<string, unknown>)[k];
				if (v === undefined) continue;
				values.push(k === 'conditions' ? JSON.stringify(v) : v);
				sets.push(`${col} = $${values.length}${k === 'conditions' ? '::jsonb' : ''}`);
			}
			if (sets.length) mustChange(await db.query(`UPDATE allocation SET ${sets.join(', ')} WHERE project_id = $1 AND id = $2`, values));
			// A change the run reads (the engine's AllocationEntry) makes the latest run out of date.
			if (RUN_INPUT_FIELDS.some((k) => (body as Record<string, unknown>)[k] !== undefined)) await touchRunInputs(db, id);
			if (body.holder !== undefined) await setHolder(db, id, aid, body.holder);
			// Which fields changed, never the holder's name (the history is readable by viewers).
			await recordAudit(db, id, 'allocation.changed', { allocationId: aid, registrationNo: before.registrationNo, fields: Object.keys(body) });
			return c.json({ allocation: await loadAllocation(db, id, aid) });
		});
	})
	.delete('/:id/allocations/:aid', async (c) => {
		const { id } = c.req.param();
		const aid = allocationId(c.req.param('aid'));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const before = await loadAllocation(db, id, aid);
			mustChange(await db.query('DELETE FROM allocation WHERE project_id = $1 AND id = $2', [id, aid]));
			await touchRunInputs(db, id);
			await recordAudit(db, id, 'allocation.deleted', { allocationId: aid, registrationNo: before.registrationNo, nodeId: before.nodeId });
			return c.body(null, 204);
		});
	})
	// Parse and match a file without writing anything: the import wizard's preview.
	.post('/:id/allocations/import', async (c) => {
		const id = c.req.param('id');
		const body = ImportBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await prepareImport(db, id, body);
			return c.json({ fileName: body.fileName, kind: body.kind, sha256: p.sha256, columns: p.columns, ignoredColumns: p.ignoredColumns, rows: p.rows, nodes: p.nodes, summary: p.summary });
		});
	})
	// Import the file's valid rows, with the preview's manual matches. The file
	// is sent again (the server keeps no preview state) and must hash the same.
	.post('/:id/allocations/import/commit', async (c) => {
		const id = c.req.param('id');
		const body = CommitBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await prepareImport(db, id, body, body.matches);
			const valid = p.rows.filter((r) => r.errors.length === 0);
			if (!valid.length) throw new ApiError(422, 'the file has no row that can be imported');
			if ((await countAllocations(db, id)) + valid.length > ALLOCATIONS_PER_PROJECT_MAX)
				throw new ApiError(409, `importing ${valid.length} rows would pass the limit of ${ALLOCATIONS_PER_PROJECT_MAX} allocations per project`);
			const { rows: src } = await db.query<{ id: string }>(
				`INSERT INTO allocation_source (project_id, kind, file_name, sha256, reference, imported_by)
				 VALUES ($1, $2, $3, $4, $5, app_current_user_id()) RETURNING id`,
				[id, body.kind, body.fileName, p.sha256, body.reference]
			);
			const sourceId = src[0]!.id;
			// One statement for the rows and one for the names, not one per row.
			// The ids are made here so each name finds its row.
			const ids = valid.map(() => crypto.randomUUID());
			await db.query(
				`INSERT INTO allocation (id, project_id, source_id, node_id, registration_no, property_ref, authorisation, purpose, water_source,
					volume_m3_year, storage_m3, valid_from, valid_to, reference, months, max_rate_m3s, conditions)
				 SELECT x.id, $1, $2, x.node_id, x.registration_no, x.property_ref, x.authorisation, x.purpose, x.water_source,
					x.volume_m3_year, x.storage_m3, x.valid_from, x.valid_to, x.reference,
					CASE WHEN jsonb_typeof(x.months) = 'array' THEN (SELECT array_agg(m::smallint ORDER BY m::int) FROM jsonb_array_elements_text(x.months) m) END, x.max_rate_m3s, x.conditions
				 FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, node_id uuid, registration_no text, property_ref text, authorisation text, purpose text,
					water_source text, volume_m3_year double precision, storage_m3 double precision, valid_from date, valid_to date, reference text,
					months jsonb, max_rate_m3s double precision, conditions jsonb)`,
				[
					id,
					sourceId,
					JSON.stringify(
						valid.map((r, i) => ({
							id: ids[i],
							node_id: r.nodeId,
							registration_no: r.registrationNo,
							property_ref: r.propertyRef,
							authorisation: r.authorisation,
							purpose: r.purpose,
							water_source: r.waterSource,
							volume_m3_year: r.volumeM3PerYear,
							storage_m3: r.storageM3,
							valid_from: r.validFrom,
							valid_to: r.validTo,
							reference: r.reference,
							months: r.months,
							max_rate_m3s: r.maxRateM3s,
							conditions: r.conditions
						}))
					)
				]
			);
			await touchRunInputs(db, id);
			const holders = ids.map((aid, i) => ({ allocation_id: aid, user_display: valid[i]!.holder })).filter((h) => h.user_display.trim() !== '');
			if (holders.length)
				await db.query(
					`INSERT INTO allocation_holder (allocation_id, project_id, user_display)
					 SELECT x.allocation_id, $1, btrim(x.user_display) FROM jsonb_to_recordset($2::jsonb) AS x(allocation_id uuid, user_display text)`,
					[id, JSON.stringify(holders)]
				);
			await recordAudit(db, id, 'allocation.imported', {
				sourceId,
				fileName: body.fileName,
				sha256: p.sha256,
				kind: body.kind,
				rows: valid.length,
				skipped: p.rows.length - valid.length,
				unmatched: valid.filter((r) => r.nodeId === null).length
			});
			const { rows: source } = await db.query(`${SOURCE_SELECT} WHERE s.id = $1`, [sourceId]);
			return c.json({ source: source[0], imported: valid.length, skipped: p.rows.length - valid.length, unmatched: valid.filter((r) => r.nodeId === null).length }, 201);
		});
	})
	// Undo an import: the source and every allocation it brought.
	.delete('/:id/allocations/sources/:sourceId', async (c) => {
		const { id } = c.req.param();
		const sourceId = allocationId(c.req.param('sourceId'));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<{ fileName: string; rows: number }>(
				'SELECT file_name AS "fileName", (SELECT count(*)::int FROM allocation a WHERE a.source_id = s.id) AS rows FROM allocation_source s WHERE project_id = $1 AND id = $2',
				[id, sourceId]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			mustChange(await db.query('DELETE FROM allocation_source WHERE project_id = $1 AND id = $2', [id, sourceId]));
			await touchRunInputs(db, id);
			await recordAudit(db, id, 'allocation.import_deleted', { sourceId, fileName: rows[0].fileName, rows: rows[0].rows });
			return c.body(null, 204);
		});
	})
	// The allocations as a CSV in the template's layout (holder names for editors only).
	.get('/:id/allocations/export.csv', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			const withNames = rank[role] >= rank.editor;
			// One client, one query at a time.
			const { rows: proj } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
			const list = await loadAllocations(db, id);
			const { rows: sources } = await db.query<{ id: string; fileName: string; sha256: string }>(
				'SELECT id, file_name AS "fileName", sha256 FROM allocation_source WHERE project_id = $1',
				[id]
			);
			const bySource = new Map(sources.map((s) => [s.id, s]));
			const header = [...TEMPLATE_HEADERS.filter((h) => withNames || h !== 'holder'), 'source_file', 'source_sha256'];
			const lines = [
				csvRow(header),
				...list.map((a) => {
					const s = a.sourceId ? bySource.get(a.sourceId) : undefined;
					return csvRow([
						a.registrationNo,
						a.propertyRef,
						a.nodeName ?? '',
						...(withNames ? [a.holder ?? ''] : []),
						a.authorisation,
						a.purpose,
						a.waterSource,
						a.volumeM3PerYear,
						a.storageM3,
						a.validFrom ?? '',
						a.validTo ?? '',
						a.reference,
						a.months ? a.months.join(' ') : '',
						a.maxRateM3s,
						a.conditions.join(CONDITIONS_SEPARATOR),
						s?.fileName ?? '',
						s?.sha256 ?? ''
					]);
				})
			];
			const body = collectCsv(lines);
			if (body === null) throw new ApiError(413, 'the allocations export is too large');
			return csvResponse(c, body, exportFilename(proj[0]?.name ?? 'project', ['allocations'], 'csv', proj[0]?.timeZone ?? DEFAULT_TIME_ZONE));
		});
	})
	// A run's modelled use against the registered volumes, per farm or water
	// user and water year (engine compareAllocations). Modelled, not metered.
	// A forecast run's forecast days are left out (issue #51): its use is
	// judged on the record, like every other historical figure of it.
	.get('/:id/runs/:runId/allocations', async (c) => {
		const { id, runId } = c.req.param();
		const q = z.object({ tolerance: TOLERANCE }).parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows: run } = await db.query<{
				label: string;
				startDate: string;
				endDate: string;
				forecastFrom: string | null;
				nodes: { id: string; name: string; kind: string; damCapacityM3?: number }[] | null;
				mode: string | null;
				settings: unknown;
				summaryAllocations: RunAllocations | null;
			}>(
				`SELECT r.label, r.start_date AS "startDate", r.end_date AS "endDate", r.summary->'forecast'->>'from' AS "forecastFrom",
					r.inputs->'model'->'nodes' AS nodes, r.inputs->'settings'->>'allocationMode' AS mode, p.settings,
					r.summary->'allocations' AS "summaryAllocations"
				 FROM model_run r JOIN project p ON p.id = r.project_id WHERE r.project_id = $1 AND r.id = $2`,
				[id, runId]
			);
			const r = run[0];
			if (!r) throw new ApiError(404, 'not found');
			// The band: a one-off ?tolerance=, else the project's setting now (issue #72), so every run reads against the same one.
			const tolerance = q.tolerance ?? mergeSettings(r.settings).allocationTolerance ?? DEFAULT_ALLOCATION_TOLERANCE;
			const nodes = await runUseNodes(db, runId, r.startDate, r.forecastFrom, r.nodes);
			const allocations = await loadAllocations(db, id);
			const comparison = compareAllocations({
				startDate: r.startDate,
				nodes,
				tolerance,
				allocations: allocations.map((a) => ({
					id: a.id,
					nodeId: a.nodeId,
					waterSource: a.waterSource,
					volumeM3PerYear: a.volumeM3PerYear,
					storageM3: a.storageM3,
					validFrom: a.validFrom,
					validTo: a.validTo
				}))
			});
			// What the run's allocation mode did to its use (engine ≥ 1.18.0; a run before it compared only).
			const allocationMode = (ALLOCATION_MODES as readonly string[]).includes(r.mode ?? '') ? (r.mode as AllocationMode) : 'none';
			// A cap run's water years per unit and source (engine ≥ 1.18.0): the years the volume was used up and
			// (engine ≥ 1.40.0; null before) the days the licence limit bound, by limit. From the run's own summary.
			const capYears =
				allocationMode === 'cap'
					? (r.summaryAllocations?.nodes ?? []).flatMap((n) =>
							n.sources.map((x) => ({ nodeId: n.nodeId, waterSource: x.waterSource, capReached: x.capReached ?? [], limitBound: x.limitBound ?? null }))
						)
					: [];
			return c.json({ run: { id: runId, label: r.label, startDate: r.startDate, endDate: r.endDate, forecastFrom: r.forecastFrom, allocationMode }, comparison, capYears });
		});
	});
