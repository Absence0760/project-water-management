// The error page (frontend routes/+error.svelte, docs/ui.md § Error page) and
// the crash report behind it (hooks.client.ts → POST /client-errors). A real
// render crash: the projects list's answer is changed so one project's
// lastRunAt is an object, not a date, and the list's "Last run" cell throws
// while it renders (no debug hook in the app). The page must show the
// thrown message and an error id, and the report sent to the API must carry
// that same id.
import { createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

test('a page that crashes shows its error id and message, and reports the crash with that id', async ({ page, owner, fetchRoute }) => {
	void owner;
	await createProject(page.request, 'Crashing list');
	await fetchRoute(page, `${API_URL}/projects`, async (route) => {
		const res = await route.fetch();
		const body = (await res.json()) as { projects: Record<string, unknown>[] };
		body.projects[0]!.lastRunAt = {};
		await route.fulfill({ response: res, json: body });
	});
	const reported = page.waitForRequest((r) => r.method() === 'POST' && r.url() === `${API_URL}/client-errors`);
	const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url() === `${API_URL}/client-errors`);

	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong on this page' })).toBeVisible();
	await expect(page).toHaveTitle('Something went wrong on this page · IC-WBT');
	const message = page.locator('[data-error-message]');
	await expect(message).toContainText('split');
	const id = (await page.locator('[data-error-id]').textContent())!;
	expect(id).toMatch(/^[0-9a-f]{8}$/);
	await expect(page.getByText(`Error id: ${id}`)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reload the page' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to your projects' })).toHaveAttribute('href', '/');

	const report = (await reported).postDataJSON() as Record<string, unknown>;
	expect(report).toMatchObject({ id, status: 500, name: 'TypeError', path: '/' });
	expect(String(report.message)).toBe(await message.textContent());
	expect(String(report.stack)).not.toBe('');
	expect(typeof report.version).toBe('string');
	// The API took it (logged, nothing stored): a signed-in report is a 204.
	expect((await answered).status()).toBe(204);
});

test('an address that matches no page says so, with no error id and no report', async ({ page, owner }) => {
	void owner;
	const reports: string[] = [];
	page.on('request', (r) => {
		if (r.url() === `${API_URL}/client-errors`) reports.push(r.url());
	});
	await page.goto('/no-such-page');
	await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
	await expect(page.getByText('Check the address, or go back and follow a link.')).toBeVisible();
	await expect(page.locator('[data-error-id]')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Reload the page' })).toHaveCount(0);
	// The link back is the one way on: following it shows the projects list, so the page had settled with no report sent.
	await page.getByRole('link', { name: 'Back to your projects' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
	expect(reports).toEqual([]);
});
