// The farm view's small map (issue #326 A3, decision D-A1/A3; docs/ui.md
// § Farmer view, docs/maps.md § The farmer's map) as the seeded farmers see
// it: farmer1@ is linked to Vaalbank on Sandspruit, whose seeded map has a
// parcel and a dam for every farm, the gauges, the streams and the boundary;
// farmer2@'s Kareebos is in Droëvlei, which has no map. The test reads the
// card's words and key, never the map's pixels: the map is never the only way
// to read what it shows, and a neighbour's parcel or dam is never named.
import type { BrowserContext, Page } from '@playwright/test';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { FARMER1, FARMER2, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(90_000);
	const api = await playwright.request.newContext();
	await seedExamplesOnce(api);
	await api.dispose();
});

const PHONE = { width: 360, height: 740 };
/** Sandspruit's other farms (seed backend/scripts/examples/map.ts), whose names no stream shares. */
const NEIGHBOURS = ['Klipdrift', 'Lemoenkraal', 'Bosrand', 'Grootdraai', 'Uitkyk'];

async function signIn(page: Page, who: { email: string; password: string }) {
	await page.goto('/login');
	await page.getByLabel('Email').fill(who.email);
	await page.getByLabel('Password').fill(who.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** The farmer's project whose name matches, and its farms, from the API as they see it. */
async function farmIn(context: BrowserContext, name: RegExp) {
	const { projects } = (await (await context.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string; role: string }[] };
	const project = projects.find((p) => p.role === 'farmer' && name.test(p.name))!;
	const index = (await (await context.request.get(`${API_URL}/projects/${project.id}/farm`)).json()) as { farms: { nodeId: string; name: string }[] };
	return { projectId: project.id, farms: index.farms };
}

test('a farmer sees their own land and dam on a small map, said in words, and never a neighbour’s', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER1);
	const { projectId, farms } = await farmIn(page.context(), /Sandspruit/);
	const vaalbank = farms.find((f) => f.name === 'Vaalbank')!;
	await page.goto(`/farm/${projectId}`);
	await expect(page.getByRole('heading', { level: 1, name: /^Vaalbank/ })).toBeVisible();

	const card = page.getByRole('region', { name: 'Your hydrological unit on the map' });
	await expect(card).toBeVisible();
	await expect(card).toContainText('The map shows your own land and dam, with the catchment boundary, the rivers and the gauges to find your way. It shows no other hydrological unit.');
	// Everything on the map, in words: the land with its area, the dam, the streams, the gauges, the boundary, and where.
	const lines = page.getByTestId('farm-map-lines').getByRole('listitem');
	await expect(lines).toHaveText([/^Your land: Vaalbank \([\d\s]+\sha\)$/, 'Your dam: Vaalbank dam', /^Rivers: .*Melkhoutspruit/, 'Gauges: Melkhout Gauge, Sandspruit Outlet', 'The catchment boundary']);
	await expect(card).toContainText(/Where: about 33\.\d{3}° S, 21\.\d{3}° E\./);
	// The build has no basemap tiles, so the card says only these features are drawn.
	await expect(card).toContainText('There is no background map here, so only these are drawn.');

	// The key: one line, the land in the farm view's own band (the "Model: …" chip), said in the text too.
	const key = page.getByTestId('farm-map-legend');
	await expect(key).toBeVisible();
	const land = key.getByRole('listitem').first();
	await expect(land).toHaveText(/^Your land( · Model: (OK|watch|short))?$/);
	const band = (await land.textContent())!.match(/Model: (OK|watch|short)/)?.[0];
	if (band) await expect(card).toContainText(`Your land is coloured by the model’s look back: ${band}.`);
	else await expect(card).not.toContainText('Your land is coloured by');
	await expect(key.getByRole('listitem')).toHaveText([/^Your land/, 'Your dam', 'River', 'Gauge', 'Catchment boundary']);

	// No neighbour, on the map card or in the map's answer (positive control: Vaalbank is in both).
	const answer = await (await page.context().request.get(`${API_URL}/projects/${projectId}/farm/${vaalbank.nodeId}/map`)).text();
	expect(answer).toContain('Vaalbank dam');
	for (const name of NEIGHBOURS) {
		await expect(card).not.toContainText(name);
		expect(answer, name).not.toContain(name);
	}
	expect(answer).not.toMatch(/Rietspruit dam|Wilgerivier dam/);

	// Phone first: the card fits a 360 px screen without sideways scroll.
	const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
	expect(scroll).toBeLessThanOrEqual(inner);
	// The map has drawn or said why it can't (no WebGL in some headless browsers): either way the page stays accessible.
	await expect(page.getByTestId('catchment-map').locator('xpath=..')).toHaveAttribute('data-status', /ready|failed/);
	await expectNoViolations(page);
});

test('a farm with nothing of its own on the map shows no map card', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await signIn(page, FARMER2);
	const { projectId, farms } = await farmIn(page.context(), /Droëvlei/);
	const kareebos = farms.find((f) => f.name === 'Kareebos')!;
	const answered = page.waitForResponse((r) => r.url().endsWith(`/farm/${kareebos.nodeId}/map`) && r.status() === 200);
	await page.goto(`/farm/${projectId}?node=${kareebos.nodeId}`);
	await expect(page.getByRole('heading', { level: 1, name: /^Kareebos/ })).toBeVisible();
	expect(await (await answered).json()).toEqual({ features: [] });
	await expect(page.getByRole('region', { name: 'Your hydrological unit on the map' })).toHaveCount(0);
	await expect(page.getByTestId('farm-map-failed')).toHaveCount(0);
});
