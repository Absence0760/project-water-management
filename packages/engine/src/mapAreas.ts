// A unit's area taken from a polygon on the map that has been redrawn since
// (issue #646 F6; docs/model.md § Run warning codes, docs/maps.md § Checks).
//
// The Map's Use copies a polygon's area into the unit (node.areaKm2); redrawing
// the polygon changes only the map's figure, so the model runs the old area
// until someone uses the new one. The Map's Checks say so, and so does the run:
// the backend names each such unit with the area its outline gives now
// (ModelInput.mapAreas, runs/execute.ts), and the run warns, so the results
// carry it. Only a warning reads it; nothing in the model changes.
import type { ModelInput } from './project';
import { warn } from './warningCodes';

/** A unit's area and its outline's differ by more than this (km², 1 m²) before the run warns. */
const SLACK_KM2 = 1e-6;

const km2 = (x: number) => `${x.toFixed(2)} km²`;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * One warning per land unit whose area was taken from a polygon since redrawn: the area the run used and the one
 * the outline gives now. Only for a unit whose area in the run is still the one the model held (`modelKm2`), so a
 * scenario that sets the area itself isn't told its area is an old outline's. Never throws (it only warns).
 */
export function mapAreaWarnings(input: Pick<ModelInput, 'model' | 'mapAreas'>): string[] {
	const list = input.mapAreas;
	if (!Array.isArray(list)) return [];
	const out: string[] = [];
	for (const a of list) {
		if (!a || typeof a !== 'object' || !isNum(a.outlineKm2) || !isNum(a.modelKm2)) continue;
		const n = input.model.nodes.find((x) => x.id === a.nodeId);
		if (!n || n.kind !== 'farm' || !isNum(n.areaKm2)) continue;
		if (Math.abs(n.areaKm2 - a.modelKm2) > SLACK_KM2 || Math.abs(n.areaKm2 - a.outlineKm2) <= SLACK_KM2) continue;
		out.push(
			warn(
				'map.areaFromEarlierOutline',
				{ unit: n.name, modelKm2: Math.round(n.areaKm2 * 1000) / 1000, mapKm2: Math.round(a.outlineKm2 * 1000) / 1000 },
				`"${n.name}": its area is from an earlier outline of its polygon on the map: the run used ${km2(n.areaKm2)}, the outline is ${km2(a.outlineKm2)} now. Use the new area on the Map (Checks), or keep the old one.`
			)
		);
	}
	return out;
}
