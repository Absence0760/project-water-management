// Three layout faults round 4's audits saw along the way (issue #521, round 5). Synthetic data only.
// - The Map tab at 390 px: while the map's chunk loads, the map box was a line tall and the tool column
//   (Measure, Draw, Point…) ran out of it over the Features list. The box now keeps the tools' height.
// - Share the pain's hydrological unit table: a long badge ("below its equitable share by 25.8 m³/day")
//   wrapped five lines deep into a tall round blob. The name column has room, and a badge is a rounded box.
// - Add a registered volume: the "Licence conditions" legend wrapped and the fieldset's border ran through it.
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openMap } from '../support/map.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

test('at 390 px the map tools stay inside the map card while the map loads', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const project = await seedRunnableProject(page.request, 'Map tools loading');
	// Hold the map's own chunk (the only one with its data-testid) until the check is done.
	let release!: () => void;
	const held = new Promise<void>((done) => (release = done));
	let seen = false;
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const res = await route.fetch();
		const body = await res.text();
		if (/data-testid=["']?catchment-map/.test(body)) {
			seen = true;
			await held;
		}
		await route.fulfill({ response: res, body });
	});
	await openMap(page, project.id);
	const tools = page.locator('.tools-at');
	await expect(tools.getByRole('button', { name: /Measure/ })).toBeVisible();
	await expect(page.getByTestId('catchment-map')).toHaveCount(0);
	expect(seen).toBe(true);
	const box = await page.evaluate(() => {
		const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
		return { tools: r('.tools-at').bottom, card: r('.map-card').bottom, body: r('.map-body').bottom };
	});
	expect(box.tools).toBeLessThanOrEqual(box.body);
	expect(box.body).toBeLessThanOrEqual(box.card);
	await expectNoSidewaysScroll(page);
	release();
	await expect(page.getByTestId('catchment-map')).toBeVisible();
});

test('Share the pain’s unit names have room for their badge, and a long badge is a rounded box, not a blob', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await seedRunnableProject(page.request, 'Badge room');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}?tab=supply`);
	await expect(page.locator('#res-curtailment').getByTestId('curtailment-period')).toBeVisible();
	const heads = page.locator('#res-curtailment section.curtailment > .table-wrap > table > tbody > tr > th[scope="row"]');
	await expect(heads.first()).toBeVisible();
	const minWidth = await heads.first().evaluate((el) => parseFloat(getComputedStyle(el).minWidth) / parseFloat(getComputedStyle(document.documentElement).fontSize));
	expect(minWidth).toBe(11);
	const badges = page.locator('#res-curtailment section.curtailment > .table-wrap > table > tbody .badge');
	for (const radius of await badges.evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)))) expect(radius).toBeLessThan(12);
});

test('the Licence conditions legend stays on one line at 390 px, its note under it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Legend one line');
	await createRun(page.request, project.id, 'Baseline');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${project.id}?tab=allocations&volume=new`);
	const sheet = page.getByRole('dialog', { name: 'Add a registered volume' });
	const fieldset = sheet.getByRole('group', { name: /^Licence conditions/ });
	await expect(fieldset).toBeVisible();
	await expect(fieldset).toHaveAccessibleDescription('Optional; a cap run keeps to the months and the rate.');
	const legend = fieldset.locator('legend');
	// One line: no taller than its help button (a 24 px target) and a little; two lines of text are over 40 px.
	expect((await legend.boundingBox())!.height).toBeLessThan(34);
	for (const width of [320, 390]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
	}
});
