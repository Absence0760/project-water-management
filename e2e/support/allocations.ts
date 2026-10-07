// The Allocations page (?tab=allocations, issue #17 option A, WP-3.10):
// locators and a big synthetic catchment with many registered volumes.
// Invented names, registration numbers and values only.
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { createProject, createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, updateSettings, type Model } from './api.ts';
import { API_URL } from './env.ts';

export const compareCard = (page: Page) => page.getByRole('region', { name: 'Modelled use vs registered volume' });
export const volumesCard = (page: Page) => page.getByRole('region', { name: 'Registered volumes' });

export async function openAllocations(page: Page, projectId: string, query = '') {
	await page.goto(`/projects/${projectId}?tab=allocations${query}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Allocations' })).toBeVisible();
	// Settled: the volumes and the run's comparison have loaded (AllocationsTab's aria-busy). The comparison lands above
	// the rest of the page and moves it, so a click before then can miss (a CI flake: a checkbox click that changed nothing).
	await expect(page.getByTestId('allocations-page')).toHaveAttribute('aria-busy', 'false');
}

export interface AllocationBody {
	nodeId: string | null;
	registrationNo?: string;
	propertyRef?: string;
	holder?: string;
	authorisation: 'registration' | 'licence' | 'general_authorisation' | 'schedule_1' | 'existing_lawful_use_claimed' | 'existing_lawful_use';
	purpose?: string;
	waterSource: 'surface' | 'groundwater';
	volumeM3PerYear: number;
	storageM3?: number | null;
	validFrom?: string | null;
	validTo?: string | null;
	reference?: string;
	/** The s21 water use (issue #72): '21b' is a dam's storage only (volume 0, a storage, surface). */
	waterUse?: '21a' | '21b';
}

export async function addAllocation(request: APIRequestContext, projectId: string, body: AllocationBody): Promise<string> {
	const res = await request.post(`${API_URL}/projects/${projectId}/allocations`, { data: body });
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { allocation: { id: string } }).allocation.id;
}

/**
 * A runnable project with `farms` units (long names, one crop each), `days`
 * of synthetic rain and flow from 2019-10-01 (so whole water years), a run,
 * and a registered volume for most units: every unit a surface volume, every
 * fifth one groundwater too, a handful set well above or below what the model
 * uses, and `unmatched` volumes with no unit.
 */
export async function seedManyAllocations(
	request: APIRequestContext,
	name: string,
	{ farms = 30, days = 3 * 365 + 1, unmatched = 4 }: { farms?: number; days?: number; unmatched?: number } = {}
): Promise<{ id: string; model: Model; units: { id: string; name: string }[]; runId: string }> {
	const project = await createProject(request, name);
	const model = sampleModel();
	const gauge = model.nodes[0]!;
	const crop = model.crops[0]!;
	const units = Array.from({ length: farms }, (_, i) => ({
		...model.nodes[1]!,
		id: crypto.randomUUID(),
		name: `${['Upper', 'Middle', 'Lower', 'Riverside', 'Hillcrest'][i % 5]} ${['Kloof', 'Vlei', 'Rant', 'Bos'][i % 4]} farm ${i + 1}`,
		sortOrder: i + 2,
		downstreamNodeId: gauge.id,
		damCapacityM3: 40_000 + 5_000 * (i % 6)
	}));
	model.nodes = [gauge, ...units];
	model.cropAreas = units.map((u, i) => ({ nodeId: u.id as string, cropId: crop.id, areaM2: 60_000 + 20_000 * (i % 7) }));
	model.transfers = [];
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2019-10-01', values: syntheticRain(days) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2019-10-01', values: syntheticFlow(days) });
	const runId = await createRun(request, project.id, 'Baseline');

	const auth = ['registration', 'licence', 'existing_lawful_use', 'general_authorisation'] as const;
	for (const [i, u] of units.entries()) {
		// Most volumes are in the model's range; every seventh is small (so above registered), every ninth large.
		const volume = i % 7 === 3 ? 2_000 : i % 9 === 4 ? 900_000 : 60_000 + 7_500 * (i % 8);
		await addAllocation(request, project.id, {
			nodeId: u.id as string,
			registrationNo: `SYN-${String(1000 + i)}`,
			propertyRef: `Portion ${i + 1} of Example ${100 + i}`,
			holder: `Invented Holdings ${i + 1}`,
			authorisation: auth[i % auth.length]!,
			purpose: 'irrigation',
			waterSource: 'surface',
			volumeM3PerYear: volume,
			storageM3: i % 3 === 0 ? 50_000 : null,
			validFrom: '2015-01-01',
			reference: 'synthetic'
		});
		if (i % 5 === 0)
			await addAllocation(request, project.id, {
				nodeId: u.id as string,
				registrationNo: `SYN-G${String(1000 + i)}`,
				holder: `Invented Holdings ${i + 1}`,
				authorisation: 'registration',
				waterSource: 'groundwater',
				volumeM3PerYear: 8_000
			});
	}
	for (let i = 0; i < unmatched; i++)
		await addAllocation(request, project.id, {
			nodeId: null,
			registrationNo: `SYN-U${String(1000 + i)}`,
			propertyRef: `Portion ${90 + i} of Nowhere 9`,
			holder: `Unmatched Holder ${i + 1}`,
			authorisation: 'registration',
			waterSource: 'surface',
			volumeM3PerYear: 15_000
		});
	return { id: project.id, model, units: units.map((u) => ({ id: u.id as string, name: u.name as string })), runId };
}
