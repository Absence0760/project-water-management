// API keys and Scheduled reports on the Project page (issue #586 Round 1; docs/ui.md § Project, § API keys,
// § Scheduled reports): moved from Settings, each in its own chunk with its anchor on a wrapper outside it
// (`#project-api-keys`, `#project-report-schedules`), so a link waits for the panel and lands on its heading.
// Both save as they change, unlike the details form above them (the save bar), and say so. Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { openProject } from '../support/project.ts';
import { expectNoSidewaysScroll, resizeTo } from '../support/reflow.ts';

const SAVES = 'Saves as you change it, not with Save changes at the foot of the page.';
const keysPanel = (page: Page) => page.getByRole('region', { name: 'API keys' });
const schedulesPanel = (page: Page) => page.getByRole('region', { name: 'Scheduled reports' });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('an owner finds Scheduled reports under the model and API keys after Share links, each saying it saves as it changes', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 900 });
	const project = await createProject(page.request, 'Keys and schedules');
	await openProject(page, project.id);
	const keys = keysPanel(page);
	const schedules = schedulesPanel(page);
	await expect(keys.getByText('No API keys yet.')).toBeVisible();
	await expect(schedules.getByText('No scheduled reports.')).toBeVisible();
	await expect(keys.getByTestId('api-keys-saves')).toHaveText(SAVES);
	await expect(schedules.getByTestId('schedules-saves')).toHaveText(SAVES);

	// Scheduled reports at the foot of the left column, under The model; API keys in the right, between Share links and Two-step sign-in.
	const box = async (name: string) => (await region(page, name).boundingBox())!;
	const model = await box('The model');
	const sched = (await schedules.boundingBox())!;
	expect(Math.abs(sched.x - model.x)).toBeLessThanOrEqual(1);
	expect(sched.y).toBeGreaterThan(model.y + model.height - 1);
	const share = await box('Share links');
	const keysBox = (await keys.boundingBox())!;
	const twoStep = await box('Two-step sign-in');
	expect(Math.abs(keysBox.x - share.x)).toBeLessThanOrEqual(1);
	expect(keysBox.y).toBeGreaterThan(share.y + share.height - 1);
	expect(twoStep.y).toBeGreaterThan(keysBox.y + keysBox.height - 1);

	// Each head's action opens its card with its own action row in the window, and Cancel gives the focus back.
	const make = keys.getByRole('button', { name: 'Make a key' });
	await keys.evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await make.click();
	await expect(keys.getByRole('form', { name: 'Make an API key' }).getByLabel('Name')).toBeFocused();
	await expect(keys.getByRole('button', { name: 'Make key' })).toBeInViewport();
	await keys.getByRole('button', { name: 'Cancel' }).click();
	await expect(make).toBeFocused();

	const add = schedules.getByRole('button', { name: 'Add a schedule' });
	await schedules.evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await add.click();
	const form = schedules.getByRole('form', { name: 'Add a schedule' });
	await expect(form.getByLabel('Every', { exact: true })).toBeFocused();
	await expect(form.getByRole('button', { name: 'Add schedule' })).toBeInViewport();
	expect((await form.boundingBox())!.y).toBeLessThan((await schedules.getByText('No scheduled reports.').boundingBox())!.y);
	await expectNoViolations(page, { include: '#project-report-schedules' });
	await form.getByRole('button', { name: 'Cancel' }).click();
	await expect(add).toBeFocused();
	await expectNoViolations(page, { include: '#project-api-keys' });

	// Neither waits for the save bar: a schedule added while the details are unsaved is saved, and the bar stays for the details.
	await page.getByLabel('Description').fill('Unsaved words');
	await add.click();
	await form.getByRole('button', { name: 'Add schedule' }).click();
	await expect(schedules.getByRole('list', { name: 'Scheduled reports' }).getByRole('listitem')).toHaveCount(1);
	await expect(page.getByRole('region', { name: 'Unsaved project details' })).toBeVisible();
	const saved = await page.request.get(`${API_URL}/projects/${project.id}/report-schedules`);
	expect(((await saved.json()) as { schedules: unknown[] }).schedules).toHaveLength(1);
});

for (const [id, name] of [
	['project-report-schedules', 'Scheduled reports'],
	['project-api-keys', 'API keys']
] as const) {
	test(`a link to #${id} waits for the lazy panel and lands on its heading, focused`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1440, height: 960 });
		const project = await createProject(page.request, `Land on ${name}`);
		await page.goto(`/projects/${project.id}?tab=project#${id}`);
		const heading = page.locator(`#${id} h2`);
		await expect(heading).toHaveText(new RegExp(`^${name}`));
		await expect(heading).toBeFocused();
		await expect(heading).toBeInViewport();
		// The wrapper is the page's anchor: it's there before the chunk, so the panel's heading is the first inside it.
		await expect(page.locator(`#${id} > *`).first()).toBeVisible();
	});
}

test('on a phone both panels and their open cards fit the screen, with nothing scrolling sideways', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Keys phone');
	await page.setViewportSize({ width: 390, height: 844 });
	await openProject(page, project.id);
	await keysPanel(page).getByRole('button', { name: 'Make a key' }).click();
	await schedulesPanel(page).getByRole('button', { name: 'Add a schedule' }).click();
	for (const width of [390, 320]) {
		await resizeTo(page, { width, height: 844 });
		await expectNoSidewaysScroll(page);
	}
	await resizeTo(page, { width: 390, height: 844 });
	await expectNoViolations(page, { include: '#project-api-keys' });
	await expectNoViolations(page, { include: '#project-report-schedules' });
});

test('thirty keys scroll inside their card, and the page keeps its width', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Thirty keys');
	for (let i = 1; i <= 30; i++) {
		const r = await page.request.post(`${API_URL}/projects/${project.id}/api-keys`, { data: { name: `Gateway ${i} at the weir`, allowedSeries: null, expiresInDays: i % 2 ? 90 : null } });
		expect(r.status()).toBe(201);
	}
	await openProject(page, project.id);
	const wrap = keysPanel(page).locator('.table-wrap');
	await expect(wrap.getByRole('row')).toHaveCount(31);
	const { scroll, client } = await wrap.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
	expect(scroll).toBeGreaterThan(client);
	expect(client).toBeLessThanOrEqual(960 * 0.7 + 1);
	await expectNoSidewaysScroll(page);
});

test('a viewer reads the scheduled reports without controls or the saves line, and has no API keys', async ({ page, owner, signIn }) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await createProject(page.request, 'Viewer schedules');
	const viewer = await signIn('Schedules viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const r = await page.request.post(`${API_URL}/projects/${project.id}/report-schedules`, { data: { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [owner.id] } });
	expect(r.status()).toBe(201);
	await openProject(viewer.page, project.id);
	const theirs = schedulesPanel(viewer.page);
	await expect(theirs.getByRole('listitem')).toContainText('Every Monday at 07:00 (UTC)');
	await expect(theirs.getByRole('button', { name: 'Add a schedule' })).toHaveCount(0);
	await expect(theirs.getByRole('button', { name: /^(?:Pause|Remove)/ })).toHaveCount(0);
	await expect(theirs.getByTestId('schedules-saves')).toHaveCount(0);
	await expect(keysPanel(viewer.page)).toHaveCount(0);
	await expectNoViolations(viewer.page, { include: '#project-report-schedules' });
});
