// Seeds the licence comparison map example (licenceMap.ts, issue #510) for
// demo@example.com: the project, its map, a published baseline run, and the
// registered volumes that put each unit in its band of the Allocations tab's
// map, read from that run's comparison. "What viewers see" is on and the
// analyst is a viewer, so a viewer sees the map too. Built under a working
// name and renamed when complete, as the showcase is, so an interrupted seed
// is found and replaced by the next one rather than left half made.
import { findOwnedProject, importProjectData } from '../import-project.js';
import { apiAs } from './api.js';
import type { ExampleMapFeature } from './map.js';
import { buildLicenceMap, LICENCE_MAP_FILE, LICENCE_MAP_NAME, licenceAllocations, licenceMapFeatures } from './licenceMap.js';
import type { AllocationComparison, ProjectModel } from '@water-management/engine';

const WORKING_NAME = `${LICENCE_MAP_NAME} (seeding…)`;

type User = { email: string; password: string; displayName: string };
export interface LicenceMapDeps {
	demo: User;
	/** Made a viewer of the project. */
	viewer: User;
	userId: (email: string) => Promise<string>;
	share: (ownerEmail: string, projectId: string, email: string, role: 'viewer' | 'editor') => Promise<void>;
	publish: (email: string, projectId: string, runId: string) => Promise<void>;
	seedMap: (ownerEmail: string, projectId: string, fileName: string, features: ExampleMapFeature[]) => Promise<void>;
}

export async function seedLicenceMap(d: LicenceMapDeps): Promise<string | null> {
	if (await findOwnedProject(d.demo.email, LICENCE_MAP_NAME)) return null;
	const api = await apiAs(await d.userId(d.demo.email));
	// An earlier seed that stopped part way: start again (nothing in it keeps a project for good).
	const stale = await findOwnedProject(d.demo.email, WORKING_NAME);
	if (stale) await api('DELETE', `/projects/${stale}`);

	const ex = buildLicenceMap();
	const id = await importProjectData({ ...ex, name: WORKING_NAME }, d.demo.email);
	const at = `/projects/${id}`;
	const stored = (await api('GET', `${at}/model`)) as ProjectModel;
	await d.seedMap(d.demo.email, id, LICENCE_MAP_FILE, licenceMapFeatures(stored));

	// The baseline, then its use per unit (no volumes yet), then the volumes from that use.
	const runId = (await api('POST', `${at}/runs`, { label: 'Baseline' })).run.id as string;
	const { comparison } = (await api('GET', `${at}/runs/${runId}/allocations`)) as { comparison: AllocationComparison };
	for (const a of licenceAllocations(comparison)) await api('POST', `${at}/allocations`, { ...a, purpose: 'irrigation' });
	await api('PUT', `${at}/allocations/viewer-units`, { on: true });
	await d.publish(d.demo.email, id, runId);
	await d.share(d.demo.email, id, d.viewer.email, 'viewer');

	await api('PATCH', at, { name: LICENCE_MAP_NAME });
	console.log(`seeded ${LICENCE_MAP_NAME} (${d.demo.email}; ${d.viewer.email} views it)`);
	return id;
}
