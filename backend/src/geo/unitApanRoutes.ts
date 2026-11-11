// Each hydrological unit's mean monthly A-pan from an A-pan grid (geo/unitApan.ts;
// docs/api.md § Catchment map, docs/maps.md § A-pan for each unit):
//
//   GET /projects/:id/map/unit-apan[?dataset=]   (viewer) each land unit's 12 monthly A-pan means over its
//       parcel, beside the catchment boundary's average over the same grid, each unit's year and its
//       difference from the catchment's, and the units the grid doesn't describe with the reason
//   POST /projects/:id/map/unit-apan             (editor) save each covered unit's 12 months as
//       settings.apanUnits and choose them (settings.apanBasis 'units'), as one settings revision citing the grid
//
// The GET writes nothing. A grid asked for that isn't loaded (or isn't an
// A-pan grid) answers `dataset: null`, as the evaporation proposals do for
// Model settings → Demand's CCWR options: not loaded is a normal state. The
// POST re-derives the rows from the grid and the outlines as they are now;
// the client only names the grid. Units the grid doesn't cover get no row:
// the engine runs them on the covered units' area-weighted mean (engine ≥
// 1.117.0, docs/model.md §2.3b).
import { APAN_UNITS_SOURCE_MAX } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { beginSettingsChange, fitReason, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import { citeEvaporation, evaporationLabel, referenceEvaporation } from './evaporation.js';
import { unitApanProposal, UNIT_APAN_METHOD } from './unitApan.js';

const UseBody = z.object({ dataset: z.string().trim().min(1).max(50) }).strict();

const Query = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

export const unitApanRoutes = new Hono<AuthEnv>()
	.get('/:id/map/unit-apan', async (c) => {
		const { dataset } = Query.parse(c.req.query());
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [id]);
			return c.json(await unitApanProposal(db, id, dataset, mergeSettings(rows[0]?.settings)));
		});
	})
	.post('/:id/map/unit-apan', async (c) => {
		const body = UseBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// The history lock first, so the rows are worked out on the settings this change starts from.
			const before = await beginSettingsChange(db, id);
			const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [id]);
			const stored = rows[0]?.settings;
			const p = await unitApanProposal(db, id, body.dataset, mergeSettings(stored));
			const d = p.dataset;
			if (!d) throw new ApiError(400, `No A-pan grid “${body.dataset}” is loaded.`, { code: 'dataset_unknown' });
			if (!p.units.length) throw new ApiError(400, `${d.label} covers none of the units with an outline, so there is no unit A-pan to use.`, { code: 'nothing_covered' });
			const named = { dataset: d.label, kind: 'apan' as const, source: d.source, version: d.version, firstYear: d.firstYear, lastYear: d.lastYear };
			// The full citation when it fits the settings' source, else the dataset's reference (issue #763), never a cut-off citation.
			const cited = `${citeEvaporation(named)}; ${UNIT_APAN_METHOD}`;
			const source = cited.length <= APAN_UNITS_SOURCE_MAX ? cited : `${referenceEvaporation(named)}; ${UNIT_APAN_METHOD}`.slice(0, APAN_UNITS_SOURCE_MAX);
			const apanUnits = { dataset: d.label, source, units: Object.fromEntries(p.units.map((u) => [u.nodeId, u.monthlyMm])) };
			const settings = patchSettings(stored, { apanBasis: 'units', apanUnits });
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(settings)]);
			const left = [...p.uncovered, ...p.withoutPolygon, ...p.refused].map((u) => `“${u.name}”`);
			const revision = await recordModelRevision(db, id, {
				source: 'settings_patch',
				before,
				// The dataset's reference last and always whole; the unit names before it are what gets shortened (issue #763).
				reason: fitReason(
					`A-pan for each hydrological unit (CCWR A-pan (Hydrological Unit)): ${p.units.length} unit${p.units.length === 1 ? '' : 's'} from ${evaporationLabel({ kind: 'apan', source: d.source })}, ${UNIT_APAN_METHOD}${left.length ? `; on the covered units’ area-weighted mean: ${left.join(', ')}` : ''}`,
					`; ${referenceEvaporation(named)}`
				)
			});
			return c.json({ dataset: d.label, units: p.units.map((u) => ({ nodeId: u.nodeId, monthlyMm: u.monthlyMm })), source, revisionId: revision?.id ?? null });
		});
	});
