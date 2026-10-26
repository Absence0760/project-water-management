// Dams → "Proposed from the register and the map" (issue #326 B-dams; docs/ui.md
// § Dams, docs/maps.md § Dams from the register and the map). A unit's dam on
// the map lists the registered dams within 1 km (the committed synthetic
// register, region Z) with their capacities for reference only (the unit's
// dam is its composite dam, its volume the user's: #523 C1), and proposes its
// full-supply area from its polygon, each row with its source; Use asks first
// and saves that one value, and History names the source. A viewer reads the
// proposals but can't use them. With a run the box sits in the picked dam's
// chart panel, folded to one line, and follows (and moves) the page's pick.
// The table is read, never the map's pixels.
// Invented data only.
import type { Locator, Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { answerConfirm } from '../support/confirm.ts';
import { loadSyntheticDamRegister } from '../support/damRegister.ts';
import { API_URL } from '../support/env.ts';
import { DEMO, SANDSPRUIT, seedExamplesOnce } from '../support/examples.ts';
import { expect, test } from '../support/fixtures.ts';
import { box } from '../support/map.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const panel = (page: Page) => page.getByTestId('dam-proposals');
const rowOf = (page: Page, key: string) => panel(page).locator(`tr[data-key="${key}"]`);

/** The Dams page with the proposals for `unit` loaded. */
async function openProposals(page: Page, projectId: string, unit: string) {
	await page.goto(`/projects/${projectId}?tab=dams`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	await expect(panel(page).getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	// With a run the box is folded inside the picked dam's chart panel: open it first.
	const fold = panel(page).locator('details.fold');
	if ((await fold.count()) && (await fold.getAttribute('open')) === null) await fold.locator('> summary').click();
	await panel(page).getByLabel('Dam of').selectOption({ label: unit });
	await expect(panel(page).getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).locator('caption')).toHaveText(`Values proposed for ${unit}’s dam, beside the saved model’s`);
}

test.beforeAll(async () => {
	await loadSyntheticDamRegister();
});

test('the seeded Sandspruit: a dam’s registered capacity and its polygon’s area are proposed, each with its source, to its viewer without Use', async ({ page }) => {
	test.setTimeout(120_000);
	await seedExamplesOnce(page.request);
	// seedExamplesOnce probes the demo login with this page's request context, so once the examples exist (another
	// spec, or --repeat-each) the page is already signed in and /login skips the form: sign in through it from scratch.
	await page.context().clearCookies();
	await page.goto('/login');
	await page.getByLabel('Email').fill(DEMO.email);
	await page.getByLabel('Password').fill(DEMO.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	const { projects } = (await (await page.request.get(`${API_URL}/projects`)).json()) as { projects: { id: string; name: string }[] };
	const id = projects.find((p) => p.name === SANDSPRUIT)!.id;

	await openProposals(page, id, 'Grootdraai');
	await expect(panel(page)).toContainText('Searched from “Grootdraai dam” (its polygon’s centre');
	await expect(panel(page).getByTestId('dam-proposals-synthetic')).toContainText('Synthetic test data.');
	const cap = rowOf(page, 'Z100/01');
	await expect(cap.getByRole('rowheader')).toContainText(/^Capacity: Grootdraai Dam \(Z100\/01\)\d+ m from the dam on the map · wall 9[.,]5 m · completed 1978/);
	await expect(cap.getByTestId('dam-proposal-source')).toHaveText('The register of dams, “synthetic”: SYNTHETIC test data, invented for this repository (not the DWS List of Registered Dams): Z100/01');
	await expect(cap.getByRole('cell').nth(1)).toHaveText(/^820\D000 m³$/);
	// demo@ is a viewer on Sandspruit (the analyst owns it): the values and sources, no Use.
	await expect(panel(page).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(panel(page)).toContainText('Only an editor can use a value.');
	const area = rowOf(page, 'area');
	await expect(area.getByRole('rowheader')).toContainText('Full-supply area: “Grootdraai dam”');
	await expect(area.getByTestId('dam-proposal-source')).toHaveText(/^The map: the dam polygon’s area, computed on the server/);
	// Only the dams within 1 km: Grootdraai's register entry, not its neighbours'.
	await expect(panel(page).getByTestId('dam-proposal-source')).toHaveCount(2);

	// Bosrand's registered dam is 1.5 km off: none proposed, the polygon's area still is.
	await panel(page).getByLabel('Dam of').selectOption({ label: 'Bosrand' });
	await expect(panel(page).locator('caption')).toHaveText('Values proposed for Bosrand’s dam, beside the saved model’s');
	await expect(panel(page).getByTestId('dam-proposals-none')).toHaveText('No registered dam within 1 km of the dam on the map.');
	await expect(panel(page).locator('tbody tr')).toHaveCount(1);
	await expectNoViolations(page, { include: '[data-testid="dam-proposals"]' });
});

test('an editor uses the map’s area; the register’s capacity is a reference only, never used; History names the source; a viewer can’t', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	// Upper farm's dam on the map, ~250 m from the synthetic register's Z100/07 (Bo-dam, 140 000 m³).
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.004)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	const areaM2 = ((await made.json()) as { feature: { areaM2: number } }).feature.areaM2;

	await openProposals(page, project.id, 'Upper farm');
	const area = rowOf(page, 'area');
	await expect(area.getByRole('cell').nth(0)).toHaveText('Not set (estimated from capacity)');
	await area.getByRole('button', { name: 'Use the map’s area' }).click();
	// Cancel changes nothing.
	await answerConfirm(page, false, 'Set Upper farm’s full-supply area from the map?');
	await expect(area.getByRole('cell').nth(0)).toHaveText('Not set (estimated from capacity)');
	await area.getByRole('button', { name: 'Use the map’s area' }).click();
	await answerConfirm(page, true, /Set Upper farm’s full-supply area from the map\?\s*Upper farm’s dam has no area when full set/);
	await expect(panel(page).getByTestId('dam-proposals-notice')).toHaveText(/^Upper farm’s full-supply area is now [\d\s,.]+ m² \([\d,.]+ ha\), from the map\. Run the model to see its effect\.$/);
	await expect(area.getByRole('cell').last()).toHaveText('Saved');
	// The Use button is gone: the keyboard lands on what happened (ProposalPanel's notice), not the top of the page.
	await expect(panel(page).getByTestId('dam-proposals-notice')).toBeFocused();
	// Only that value changed.
	const model = async () => ((await (await page.request.get(`${API_URL}/projects/${project.id}/model`)).json()) as { nodes: { id: string; damAreaFullM2: number | null; damCapacityM3: number }[] }).nodes.find((n) => n.id === upper.id)!;
	expect((await model()).damAreaFullM2).toBeCloseTo(areaM2, 6);
	expect((await model()).damCapacityM3).toBe(150_000);

	// The registered capacity is listed with its source, for reference only: no Use, and the capacity stays the user's.
	const cap = rowOf(page, 'Z100/07');
	await expect(cap.getByTestId('dam-proposal-source')).toContainText('The register of dams, “synthetic”: SYNTHETIC');
	await expect(cap.getByRole('cell').nth(1)).toHaveText(/^140\D000 m³$/);
	await expect(cap.getByTestId('dam-proposal-reference')).toHaveText('Reference only');
	await expect(cap.getByRole('button')).toHaveCount(0);
	await expect(panel(page)).toContainText('its volume is yours to enter');
	// On a wide page it stays a table, its columns named in its head row.
	await expect(panel(page).locator('thead')).toBeVisible();
	expect((await model()).damCapacityM3).toBe(150_000);
	await expectNoViolations(page, { include: '[data-testid="dam-proposals"]' });

	// History names the source.
	await page.goto(`/projects/${project.id}?tab=history`);
	const entries = page.getByTestId('history-entry');
	await expect(entries.nth(0)).toContainText(/Dam full-supply area of Upper farm from the map: “Upper dam” \(\d+ m², computed from its polygon\)/);

	// A viewer reads the proposals, with their sources, and has no Use; on a phone nothing scrolls sideways.
	const viewer = await signIn('Dam proposals viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await openProposals(v, project.id, 'Upper farm');
	await expect(rowOf(v, 'Z100/07').getByTestId('dam-proposal-source')).toContainText('SYNTHETIC');
	await expect(panel(v).getByRole('button', { name: /^Use / })).toHaveCount(0);
	await expect(panel(v)).toContainText('Only an editor can use a value.');
	await expectNoSidewaysScroll(v);
	// Nor inside its own box: the table (549 px as columns) stacks each row as a block, its values under their labels.
	const wrap = panel(v).locator('.table-wrap');
	const fit = await wrap.evaluate((w) => ({ scroll: w.scrollWidth, client: w.clientWidth }));
	expect(fit.scroll, `the proposals table scrolls sideways: ${fit.scroll} px in ${fit.client}`).toBeLessThanOrEqual(fit.client);
	await expect(panel(v).locator('thead')).toBeHidden();
	const label = (cell: Locator) => cell.evaluate((c) => getComputedStyle(c, '::before').content);
	await expect.poll(() => label(rowOf(v, 'Z100/07').getByRole('cell').nth(0))).toBe('"Saved now"');
	await expect.poll(() => label(rowOf(v, 'Z100/07').getByRole('cell').nth(1))).toBe('"Proposed"');
	await expect.poll(() => label(rowOf(v, 'Z100/07').getByTestId('dam-proposal-source'))).toBe('"Source"');
	await expectNoViolations(v, { include: '[data-testid="dam-proposals"]' });
});

test('a Use that answers after Dam of moved on leaves the box, and the keyboard, on the unit now picked', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals use race');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Polygon', coordinates: [box(21.32, -33.68, 0.004)] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	// Hold the save until Dam of has moved to another unit and that unit's proposals are in.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let posted!: () => void;
	const arrived = new Promise<void>((r) => (posted = r));
	await page.route(/\/dam-area-from-map$/, async (route) => {
		posted();
		await held;
		await route.continue();
	});

	await openProposals(page, project.id, 'Upper farm');
	await rowOf(page, 'area').getByRole('button', { name: 'Use the map’s area' }).click();
	await answerConfirm(page, true, /Set Upper farm’s full-supply area from the map\?/);
	await arrived;
	await panel(page).getByLabel('Dam of').selectOption({ label: 'Lower farm' });
	await expect(panel(page).locator('caption')).toHaveCount(0);
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Lower farm.');
	const saved = page.waitForResponse(/\/dam-area-from-map$/);
	// The box's reload after the save: one GET of proposals, whichever unit it asks for.
	const reloaded = page.waitForResponse((r) => r.request().method() === 'GET' && /\/dam-proposals$/.test(new URL(r.url()).pathname));
	// The keyboard is on Dam of, where the user moved on.
	await panel(page).getByLabel('Dam of').focus();
	await expect(panel(page)).toHaveAttribute('data-saving', 'true');
	release();
	expect((await saved).status()).toBe(200);
	await reloaded;
	// The Use has finished, its focus step included.
	await expect(panel(page)).not.toHaveAttribute('data-saving');
	// The notice still reports the save (it names its unit), but doesn't take the keyboard from Dam of: it's about a unit
	// the user has left.
	await expect(panel(page).getByTestId('dam-proposals-notice')).toContainText('Upper farm’s full-supply area is now');
	await expect(panel(page).getByTestId('dam-proposals-notice')).not.toBeFocused();
	await expect(panel(page).getByLabel('Dam of')).toBeFocused();
	// The box still shows Lower farm, the unit Dam of names, not the reload of Upper farm the save asked for.
	await expect(panel(page).getByLabel('Dam of')).toHaveValue(project.model.nodes.find((n) => n.name === 'Lower farm')!.id as string);
	await expect(panel(page).getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Lower farm.');
	await expect(panel(page).locator('caption')).toHaveCount(0);
});

test('a Use that fails after Dam of moved on reports it in the notice, naming its unit, not on the other unit’s map row', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals use fails');
	// A dam on the map for both units, so Lower farm's box has a map row too: its key is 'area' on every unit.
	for (const [unit, name, x] of [['Upper farm', 'Upper dam', 21.32], ['Lower farm', 'Lower dam', 21.34]] as const) {
		const node = project.model.nodes.find((n) => n.name === unit)!;
		const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
			data: { kind: 'dam', name, nodeId: node.id, geometry: { type: 'Polygon', coordinates: [box(x, -33.68, 0.004)] } }
		});
		expect(made.status(), await made.text()).toBe(201);
	}
	// Hold the save until Dam of has moved to Lower farm and its proposals are in, then fail it.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	let posted!: () => void;
	const arrived = new Promise<void>((r) => (posted = r));
	await page.route(/\/dam-area-from-map$/, async (route) => {
		posted();
		await held;
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong' }) });
	});

	await openProposals(page, project.id, 'Upper farm');
	await rowOf(page, 'area').getByRole('button', { name: 'Use the map’s area' }).click();
	await answerConfirm(page, true, /Set Upper farm’s full-supply area from the map\?/);
	await arrived;
	await panel(page).getByLabel('Dam of').selectOption({ label: 'Lower farm' });
	await expect(panel(page).getByTestId('dam-proposals-body')).toHaveAttribute('data-ready', 'true');
	await expect(rowOf(page, 'area')).toContainText('Lower dam');
	await expect(panel(page)).toHaveAttribute('data-saving', 'true');
	release();
	await expect(panel(page)).not.toHaveAttribute('data-saving');
	// Lower farm's map row (the same key) carries no error; the notice names the unit the failure was for.
	await expect(rowOf(page, 'area').getByRole('alert')).toHaveCount(0);
	const notice = panel(page).getByTestId('dam-proposals-notice');
	await expect(notice).toHaveText('Couldn’t save Upper farm’s full-supply area: Something went wrong');
	await expect(notice).toHaveClass(/alert-error/);
	await expect(panel(page).getByLabel('Dam of')).toHaveValue(project.model.nodes.find((n) => n.name === 'Lower farm')!.id as string);
});

test('with a run the box is the picked dam’s, folded in its chart panel; Dam of moves the pick, keeps units with no dam, and a card’s Proposals opens it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals follow');
	// A unit with no dam: no card, so the page can't pick it, but Dam of can still show its proposals.
	const model = project.model;
	model.nodes.push({ ...model.nodes[2]!, id: crypto.randomUUID(), name: 'Dry unit', sortOrder: 9, damCapacityM3: 0 });
	await putModel(page.request, project.id, model);
	await createRun(page.request, project.id, 'Baseline');
	const idOf = (name: string) => model.nodes.find((n) => n.name === name)!.id as string;
	await page.goto(`/projects/${project.id}?tab=dams`);
	await expect(page.getByRole('heading', { level: 1, name: 'Dams' })).toBeVisible();
	const card = (name: string) => page.getByRole('list', { name: 'Dams' }).getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
	const chart = page.getByRole('region', { name: /^Storage/ });
	const storage = chart.getByRole('heading', { level: 2 });
	const summary = panel(page).locator('details.fold > summary');
	const unit = panel(page).getByLabel('Dam of');

	// Inside the chart panel, one line, about the dam the chart shows (the first card) before anything is picked.
	await expect(chart.getByTestId('dam-proposals')).toHaveCount(1);
	await expect(page.getByTestId('dam-proposals')).toHaveCount(1);
	await expect(storage).toHaveText(/^Storage: /);
	const first = (await storage.textContent())!.replace('Storage: ', '');
	await expect(summary).toContainText(`${first}:`);
	await expect(panel(page).getByTestId('dam-proposals-line')).toHaveText('no dam on the map is linked to it');
	await expect(unit).toBeHidden();

	// A card's pick moves the box with the chart.
	await card('Lower farm').locator('a.name').click();
	await expect(page).toHaveURL(new RegExp(`[?&]dam=${idOf('Lower farm')}$`));
	await expect(summary).toContainText('Lower farm:');
	await expect(unit).toHaveValue(idOf('Lower farm'));

	// Opened, Dam of picks a dam for the whole page: the chart, the card and the URL, a step Back undoes.
	await summary.click();
	await unit.selectOption({ label: 'Upper farm' });
	await expect(page).toHaveURL(new RegExp(`[?&]dam=${idOf('Upper farm')}$`));
	await expect(storage).toHaveText('Storage: Upper farm');
	await expect(card('Upper farm').locator('a.name')).toHaveAttribute('aria-current', 'true');
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Upper farm.');
	await page.goBack();
	await expect(storage).toHaveText('Storage: Lower farm');
	await expect(unit).toHaveValue(idOf('Lower farm'));

	// A unit with no dam is listed apart and shown in the box alone; the page's pick stays.
	await expect(unit.locator('optgroup[label="Hydrological units with no dam yet"] option')).toHaveText(['Dry unit']);
	await expect(unit.locator('optgroup[label="Dams"] option')).toHaveCount(2);
	await unit.selectOption({ label: 'Dry unit' });
	await expect(summary).toContainText('Dry unit:');
	await expect(panel(page).getByTestId('dam-proposals-no-dam')).toContainText('No dam on the map is linked to Dry unit.');
	await expect(page).toHaveURL(new RegExp(`[?&]dam=${idOf('Lower farm')}$`));
	await expect(storage).toHaveText('Storage: Lower farm');

	// Closed again, a card's Proposals picks its dam, opens the box and gives its picker the keyboard, in view.
	await summary.click();
	await expect(unit).toBeHidden();
	await card('Upper farm').getByRole('link', { name: 'Upper farm: proposals from the register and the map' }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]dam=${idOf('Upper farm')}$`));
	await expect(unit).toHaveValue(idOf('Upper farm'));
	await expect(unit).toBeFocused();
	await expect(panel(page).getByRole('heading', { name: 'Proposed from the register and the map' })).toBeInViewport();
	await expect(storage).toHaveText('Storage: Upper farm');

	// A fresh load of the same URL agrees.
	await page.reload();
	await expect(storage).toHaveText('Storage: Upper farm');
	await expect(summary).toContainText('Upper farm:');
	await expectNoViolations(page, { include: '[data-testid="dam-proposals"]' });
});

test('folded, a failed load says so on its line, and opening it offers Try again', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals fail folded');
	await createRun(page.request, project.id, 'Baseline');
	let failed = false;
	await page.route(/\/dam-proposals(\?|$)/, async (route) => {
		if (failed || route.request().method() !== 'GET') return route.continue();
		failed = true;
		await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test outage' }) });
	});
	await page.goto(`/projects/${project.id}?tab=dams`);
	await expect(panel(page).getByTestId('dam-proposals-line')).toHaveText('couldn’t be loaded: open to try again');
	await panel(page).locator('details.fold > summary').click();
	await panel(page).getByRole('button', { name: 'Try again' }).click();
	await expect(panel(page).getByTestId('dam-proposals-line')).toHaveText('no dam on the map is linked to it');
});

test('the dam’s place is written in degrees with a hemisphere', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Dam proposals place');
	const upper = project.model.nodes.find((n) => n.name === 'Upper farm')!;
	const made = await page.request.post(`${API_URL}/projects/${project.id}/map/features`, {
		data: { kind: 'dam', name: 'Upper dam', nodeId: upper.id, geometry: { type: 'Point', coordinates: [21.32, -33.68] } }
	});
	expect(made.status(), await made.text()).toBe(201);
	await openProposals(page, project.id, 'Upper farm');
	await expect(panel(page)).toContainText('Searched from “Upper dam” (a point, 33.6800° S, 21.3200° E)');
});
