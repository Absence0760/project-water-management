// Evaporation proposed from the map (issue #326 Part B, "B-evap";
// 180_evaporation_reference.sql, 181_evaporation_accepted.sql; docs/api.md
// § Catchment map, docs/maps.md § Evaporation from the map).
//
//   GET  /projects/:id/evaporation-proposals        the boundary's monthly evaporation from a grid, beside the settings (viewer)
//   POST /projects/:id/evaporation-from-map         accept it into the settings it belongs to (editor)
//
// The map proposes, the modeller decides. What the 12 values go into is the
// dataset's kind, never converted: a reference-ET grid (FAO-56 ET₀) becomes
// GR4J's monthly PE (settings.pe = { kind: 'monthly', mm, source }, the pan
// coefficient then unused); an A-pan grid becomes the A-pan row
// (settings.apanMm, read by demand, the dams and GR4J under pe 'pan'). An
// accept is one settings revision whose reason names the dataset, version
// and method (what an evidence pack prints), and an evaporation_accepted
// row. The server re-derives the values; the client only names the dataset.
import { PE_SOURCE_MAX } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginSettingsChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import {
	citeEvaporation,
	evaporationDatasets,
	KIND_LABEL,
	summariseEvaporation,
	TARGET_OF,
	type EvaporationDataset,
	type EvaporationKind,
	type EvaporationSummary,
	type EvaporationTarget
} from './evaporation.js';
import type { Geometry } from './geojson.js';

export const EvaporationFromMap = z.object({ dataset: z.string().trim().min(1).max(50) }).strict();

/** The proposals' one query parameter: a dataset label (absent = the default). */
export const EvaporationQuery = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

interface Boundary {
	id: string;
	name: string;
	geometry: Geometry;
}

/** The catchment boundary, if drawn. */
async function boundaryOf(db: Db, projectId: string): Promise<Boundary | null> {
	const { rows } = await db.query<Boundary>(
		`SELECT id, name, geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	return rows[0] ?? null;
}

/** The dataset asked for, or the default (a real one before the synthetic grid); null with none loaded. */
async function pickDataset(db: Db, wanted: string | undefined): Promise<{ dataset: EvaporationDataset | null; datasets: EvaporationDataset[] }> {
	const datasets = await evaporationDatasets(db);
	if (wanted === undefined) return { dataset: datasets[0] ?? null, datasets };
	const hit = datasets.find((d) => d.dataset === wanted);
	if (!hit) throw new ApiError(400, `No evaporation dataset “${wanted}” is loaded.`);
	return { dataset: hit, datasets };
}

/** The project's settings as stored, merged over the defaults. */
async function settingsOf(db: Db, projectId: string): Promise<{ stored: unknown; merged: ReturnType<typeof mergeSettings> }> {
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const stored = rows[0]?.settings;
	return { stored, merged: mergeSettings(stored) };
}

const sameRow = (a: readonly number[] | null | undefined, b: readonly number[]) => !!a && a.length === 12 && a.every((x, i) => Math.abs(x - b[i]!) < 0.05);

/** What the settings hold now for each target: the A-pan row, and the monthly PE row when there is one. */
function currentRows(s: ReturnType<typeof mergeSettings>): Record<EvaporationTarget, number[] | null> {
	return { apan: [...s.apanMm], pe: s.pe?.kind === 'monthly' ? [...s.pe.mm] : null };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** How the values were taken over this boundary, in a sentence. */
const howTaken = (b: Boundary, s: EvaporationSummary) =>
	`area-weighted over the ${s.cells} grid cell${s.cells === 1 ? '' : 's'} the catchment boundary “${b.name || 'unnamed'}” covers (${pct(s.coverage)} of it has values)`;

/** The PE row's `source` (at most PE_SOURCE_MAX): the dataset's citation and how it was taken. */
export const peSourceFor = (d: EvaporationDataset, b: Boundary, s: EvaporationSummary) =>
	`Proposed from the map: ${KIND_LABEL[d.kind]}, ${citeEvaporation(d)}, ${howTaken(b, s)}; taken as GR4J's PE unchanged.`.slice(0, PE_SOURCE_MAX);

export const evaporationRoutes = new Hono<AuthEnv>()
	.get('/:id/evaporation-proposals', async (c) => {
		const id = c.req.param('id');
		const { dataset: wanted } = EvaporationQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { dataset, datasets } = await pickDataset(db, wanted);
			const boundary = await boundaryOf(db, id);
			const summary = dataset && boundary ? await summariseEvaporation(db, dataset, boundary.geometry) : null;
			const { merged } = await settingsOf(db, id);
			const now = currentRows(merged);
			const { rows: accepted } = await db.query<{
				target: EvaporationTarget;
				monthly_mm: number[];
				dataset: string;
				kind: EvaporationKind;
				source: string;
				version: string;
				method: string;
				coverage: number;
				accepted_at: Date;
			}>(
				`SELECT target, monthly_mm, dataset, kind, source, version, method, coverage, accepted_at
				 FROM evaporation_accepted WHERE project_id = $1 ORDER BY target`,
				[id]
			);
			return c.json({
				dataset,
				datasets: datasets.map((d) => ({ dataset: d.dataset, kind: d.kind, version: d.version, synthetic: d.synthetic })),
				boundary: boundary ? { featureId: boundary.id, name: boundary.name } : null,
				target: dataset ? TARGET_OF[dataset.kind] : null,
				proposal: summary,
				settings: { apanMm: now.apan, peKind: merged.pe?.kind ?? 'pan', peMm: now.pe },
				accepted: accepted.map((r) => ({
					target: r.target,
					monthlyMm: r.monthly_mm,
					dataset: r.dataset,
					kind: r.kind,
					source: r.source,
					version: r.version,
					method: r.method,
					coverage: r.coverage,
					acceptedAt: r.accepted_at.toISOString(),
					// Still what the settings hold (they are rewritten whole on a save, so the link is by value).
					current: sameRow(now[r.target], r.monthly_mm)
				}))
			});
		});
	})
	.post('/:id/evaporation-from-map', async (c) => {
		const body = EvaporationFromMap.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { dataset } = await pickDataset(db, body.dataset);
			const d = dataset!;
			const boundary = await boundaryOf(db, id);
			if (!boundary) throw new ApiError(400, 'There is no catchment boundary on the map: draw or import it on the Map first.');
			// Re-derived here from the dataset and the boundary as they are now.
			const summary = await summariseEvaporation(db, d, boundary.geometry);
			if ('problem' in summary) throw new ApiError(400, `${citeEvaporation(d)} can’t be summarised over the boundary: ${summary.problem}.`);
			if (!summary.monthlyMm.some((x) => x > 0)) throw new ApiError(400, `${citeEvaporation(d)} has no evaporation over the boundary, so there is nothing to use.`);
			const target = TARGET_OF[d.kind];
			const before = await beginSettingsChange(db, id);
			const { stored } = await settingsOf(db, id);
			const patch = target === 'pe' ? { pe: { kind: 'monthly', mm: summary.monthlyMm, source: peSourceFor(d, boundary, summary) } } : { apanMm: summary.monthlyMm };
			const settings = patchSettings(stored, patch);
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(settings)]);
			await db.query(
				`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				 ON CONFLICT (project_id, target) DO UPDATE SET monthly_mm = EXCLUDED.monthly_mm, dataset = EXCLUDED.dataset, kind = EXCLUDED.kind,
					source = EXCLUDED.source, version = EXCLUDED.version, method = EXCLUDED.method, coverage = EXCLUDED.coverage, accepted_at = now()`,
				[id, target, summary.monthlyMm, d.dataset, d.kind, d.source, d.version, d.method, summary.coverage]
			);
			const what = target === 'pe' ? 'GR4J’s monthly PE' : 'A-pan evaporation';
			const revision = await recordModelRevision(db, id, {
				source: 'settings_patch',
				before,
				reason: `${what} from the map: ${summary.annualMm} mm a year of ${KIND_LABEL[d.kind]}, ${howTaken(boundary, summary)}; ${citeEvaporation(d)}. ${d.method}`.slice(0, 500)
			});
			return c.json({ target, monthlyMm: summary.monthlyMm, dataset: d.dataset, revisionId: revision?.id ?? null });
		});
	});
