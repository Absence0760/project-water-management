// Each hydrological unit's MAP from the MAP grid (issue #482 follow-up;
// geo/unitMap.ts; docs/api.md § Catchment map, docs/maps.md § MAP for each
// unit):
//
//   GET  /projects/:id/map/unit-map[?dataset=]   (editor) the proposal: the grid chosen (one for the whole
//        project, the finest real grid covering every unit), each unit's area-weighted MAP from it, the
//        units it doesn't cover, and every loaded grid's coverage
//   POST /projects/:id/map/unit-map              (editor, as PUT /model for a node's fields) write each
//        chosen unit's mapMm and mapSource, as one model revision (History)
//
// The map proposes, the modeller decides. The server re-derives the values
// from the grid and the parcels as they are now; the client only names the
// grid and, optionally, the units. A unit the grid doesn't cover is never
// filled from another grid, and an apply that would leave units on two grids
// is refused (grid_mixed).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { beginModelChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { gridCitation, gridOfSource, unitMapProposal, unitMapSource, UNIT_MAP_METHOD } from './unitMap.js';

/** The most units one request names (the model holds at most 500 nodes). */
const MAX_UNITS = 500;

const Dataset = z.string().trim().min(1).max(50);
const Query = z.object({ dataset: Dataset.optional() });

const ApplyBody = z
	.object({
		/** The grid the proposal was read from (its label). */
		dataset: Dataset,
		/** Only these units; absent: every unit the grid covers. */
		nodeIds: z.array(z.uuid()).min(1).max(MAX_UNITS).optional()
	})
	.strict();

const unknownDataset = (label: string) => new ApiError(400, `No MAP grid “${label}” is loaded.`, { code: 'dataset_unknown' });

export const unitMapRoutes = new Hono<AuthEnv>()
	.get('/:id/map/unit-map', async (c) => {
		const { dataset } = Query.parse(c.req.query());
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await unitMapProposal(db, id, dataset);
			if (!p) throw unknownDataset(dataset!);
			return c.json(p);
		});
	})
	.post('/:id/map/unit-map', async (c) => {
		const body = ApplyBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// The history lock first, so the proposal is worked out on the model this change starts from.
			const change = await beginModelChange(db, id);
			const p = await unitMapProposal(db, id, body.dataset);
			if (!p) throw unknownDataset(body.dataset);
			const grid = p.dataset!;
			const listed = new Map(p.units.map((u) => [u.nodeId, u]));
			if (body.nodeIds) {
				const named = new Set(body.nodeIds);
				const blocked = [
					...p.uncovered.map(({ nodeId, name, reason }) => ({ nodeId, name, reason })),
					...p.refused,
					...p.withoutPolygon.map((u) => ({ ...u, reason: 'the unit has no polygon on the map' }))
				].filter((u) => named.has(u.nodeId));
				if (blocked.length) {
					throw new ApiError(409, `${gridCitation({ dataset: grid.label, version: grid.version })} can’t give these units a MAP: ${blocked.map((u) => `“${u.name}”: ${u.reason}`).join('; ')}`, {
						code: 'unit_uncovered',
						units: blocked
					});
				}
				if (body.nodeIds.some((n) => !listed.has(n))) throw new ApiError(400, 'nodeIds: not a land unit of this project', { code: 'unit_unknown' });
			}
			const chosen = body.nodeIds ? p.units.filter((u) => body.nodeIds!.includes(u.nodeId)) : p.units;
			if (!chosen.length) throw new ApiError(400, `${gridCitation({ dataset: grid.label, version: grid.version })} covers none of the units with a polygon, so there is no MAP to use.`, { code: 'nothing_covered' });
			// Never two grids in one project: the units left out of this apply whose MAP came from another grid, and,
			// with nodeIds, the covered units left out that hold another grid's MAP.
			const cite = gridCitation({ dataset: grid.label, version: grid.version });
			const leftOn = [
				...p.otherGrid,
				...p.units.filter((u) => !chosen.includes(u) && u.current.mapMm !== null && gridOfSource(u.current.mapSource) !== null && gridOfSource(u.current.mapSource) !== cite).map((u) => ({ nodeId: u.nodeId, name: u.name, mapSource: u.current.mapSource! }))
			];
			if (leftOn.length) {
				throw new ApiError(
					409,
					`These units would keep a MAP from another grid, and one project never mixes two: ${leftOn.map((u) => `“${u.name}” (${u.mapSource})`).join('; ')}. Apply to them too, or clear their MAP on their form first.`,
					{ code: 'grid_mixed', units: leftOn }
				);
			}
			// The values are the engine's range already (unitMap.ts fromShares, mapMmError's bounds); the source line is
			// at most 50 + 100 + ~60 characters. The node's CHECKs (209) hold them too.
			for (const u of chosen) {
				await db.query('UPDATE node SET map_mm = $3, map_source = $4 WHERE id = $1 AND project_id = $2', [u.nodeId, id, u.mapMm, unitMapSource({ dataset: grid.label, version: grid.version }, u.cells)]);
			}
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `MAP of ${chosen.length === 1 ? `“${chosen[0]!.name}”` : `${chosen.length} units`} from the MAP grid ${cite} (${grid.cellDeg}° cells), ${UNIT_MAP_METHOD}; ${grid.source}`.slice(0, 500)
			});
			return c.json({
				dataset: grid.label,
				units: chosen.map((u) => ({ nodeId: u.nodeId, mapMm: u.mapMm, mapSource: unitMapSource({ dataset: grid.label, version: grid.version }, u.cells) })),
				changed: chosen.filter((u) => !u.same).length,
				revisionId: revision?.id ?? null
			});
		});
	});
