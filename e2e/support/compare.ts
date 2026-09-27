// Helpers for the Compare runs specs (issue #17, board A4): a catchment with a
// baseline run and two what-if runs that differ from it, and locators for the
// run cards.
import type { APIRequestContext, Page } from '@playwright/test';
import { createRun, putModel, putSeries, sampleModel, syntheticFlow, syntheticRain, createProject, updateSettings, type Model } from './api.ts';

/** Days of synthetic record: three water years from 2021-10-01, so the per-year chart has several groups. */
export const WHAT_IF_DAYS = 365 * 3;

/**
 * A project run three times: the baseline; what-if 1 with Upper farm's
 * orchard doubled; what-if 2 with that and Upper farm's dam twice the size.
 */
export async function seedWhatIfs(
	request: APIRequestContext,
	name: string
): Promise<{ id: string; model: Model; baseline: string; whatIf1: string; whatIf2: string }> {
	const project = await createProject(request, name);
	const model = sampleModel();
	await putModel(request, project.id, model);
	await updateSettings(request, project.id, {
		apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110],
		ewrPragmaticM3PerDay: [2000, 1500, 1000, 1000, 1000, 1500, 2500, 4000, 5000, 5000, 4000, 3000]
	});
	await putSeries(request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(WHAT_IF_DAYS) });
	await putSeries(request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(WHAT_IF_DAYS) });
	const baseline = await createRun(request, project.id, 'Baseline');

	const upper = model.nodes[1]!;
	const more: Model = { ...model, cropAreas: model.cropAreas.map((a) => (a.nodeId === upper.id ? { ...a, areaM2: a.areaM2 * 2 } : a)) };
	await putModel(request, project.id, more);
	const whatIf1 = await createRun(request, project.id, 'More orchard');

	const bigger: Model = { ...more, nodes: more.nodes.map((n) => (n.id === upper.id ? { ...n, damCapacityM3: 300_000 } : n)) };
	await putModel(request, project.id, bigger);
	const whatIf2 = await createRun(request, project.id, 'More orchard and a bigger dam');
	return { id: project.id, model: bigger, baseline, whatIf1, whatIf2 };
}

/** The workspace's section header (title, context line, Export impact report, + New what-if). */
export const sectionHeader = (page: Page) => page.getByTestId('section-header');

export type CompareSlot = 'Baseline' | 'What-if 1' | 'What-if 2';

/** A run card (its picker fieldset, named by its legend). */
export const runCard = (page: Page, slot: CompareSlot) => page.getByRole('group', { name: slot, exact: true });
/** A run card's run select. */
export const runSelect = (page: Page, slot: CompareSlot) => runCard(page, slot).getByRole('combobox', { name: 'Run' });

/**
 * The full comparison's What changed list. A what-if's card also leads with
 * one of its changes, so a change's text appears twice on the page: look for
 * it here.
 */
export const whatChanged = (page: Page) => page.getByRole('region', { name: 'What changed', exact: true });
