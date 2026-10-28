// A unit's dam seen from space (issue #604 R5-B; docs/ui.md § Dams): a
// project whose Upper farm has a 50 000 m² dam outline on the map, satellite
// views of it loaded the way the worker loads them (plantDamObservations),
// and a run. dam-observed.spec.ts and non-text-contrast.spec.ts start from
// it. Invented data only.
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { createRun, putModel, seedRunnableProject } from './api.ts';
import { plantDamObservations } from './db.ts';
import { API_URL } from './env.ts';
import { box } from './map.ts';

export const OBSERVED_FULL_M2 = 50_000;
export interface View {
	date: string;
	wetAreaM2: number;
	pctObserved: number;
}

/** Inside the run (1 Oct 2021, 120 days): seen full, seen empty, a plain view, and one under 90 % clear. */
export const OBSERVED_VIEWS: View[] = [
	{ date: '2021-10-20', wetAreaM2: OBSERVED_FULL_M2, pctObserved: 100 },
	{ date: '2021-11-15', wetAreaM2: 0, pctObserved: 100 },
	{ date: '2021-12-10', wetAreaM2: 20_000, pctObserved: 97 },
	{ date: '2021-12-20', wetAreaM2: 5_000, pctObserved: 40 }
];

/** `n` clear views (up to 60 inside the run), one every second day from the run's first, between a quarter and three quarters full. */
export const manyViews = (n: number): View[] =>
	Array.from({ length: n }, (_, i) => ({
		date: new Date(Date.UTC(2021, 9, 1 + 2 * i)).toISOString().slice(0, 10),
		wetAreaM2: OBSERVED_FULL_M2 * (0.25 + ((i * 7) % 11) / 22),
		pctObserved: 100
	}));

/** The project, its Upper farm (with the outline) and Lower farm (none), the run, and the outline's feature id. */
export async function seedObservedDam(request: APIRequestContext, name: string, views: View[] = OBSERVED_VIEWS) {
	const project = await seedRunnableProject(request, name);
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')! as { id: string; damAreaFullM2?: number | null };
	upper.damAreaFullM2 = OBSERVED_FULL_M2;
	await putModel(request, project.id, project.model);
	const runId = await createRun(request, project.id, 'Baseline');
	const made = await request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.002)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	const featureId = ((await made.json()) as { feature: { id: string } }).feature.id;
	await plantDamObservations(featureId, { status: 'merged' }, views);
	return { project, upper, runId, featureId, lower: project.model.nodes.find((n) => n.name === 'Lower farm')! as { id: string } };
}
