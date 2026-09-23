// The Overview tab: setup checklist and headline facts, built from the lists
// the project page loads (series, runs) and the model being edited.
import type { Page } from '@playwright/test';
import { createProject, createRun, PASSWORD, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const stat = (page: Page, term: string) =>
	page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) }).getByRole('definition');
const setup = (page: Page) => page.getByRole('region', { name: /^Set(up| up this catchment)/ });

test('a fresh project: nothing loaded, every step to do', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview empty');
	await page.goto(`/projects/${project.id}`);
	await expect(setup(page).getByRole('heading', { name: 'Set up this catchment' })).toBeVisible();
	await expect(setup(page)).toContainText('0 of 5 done');
	await expect(setup(page)).toContainText('Upload daily catchment rainfall (mm).');
	await expect(setup(page)).toContainText('Run it to get farm supply & deficit');
	await expect(stat(page, 'Time series')).toHaveText('0');
	await expect(stat(page, 'Model runs')).toHaveText('0');
	await expect(stat(page, 'Farms')).toHaveText('0+ 0 gauges');
});

test('a project with data and a run: setup complete, counts shown', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Overview ready');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const done = setup(page);
	await expect(done.getByRole('heading', { name: 'Setup complete' })).toBeVisible();
	await done.getByText('All 5 steps done. Show checklist').click();
	await expect(done).toContainText('Rainfall and observed flow loaded.');
	await expect(done).toContainText(/1 run, latest \d{4}-\d{2}-\d{2}\./);
	await expect(stat(page, 'Time series')).toHaveText('2');
	await expect(stat(page, 'Model runs')).toHaveText('1');
	await expect(stat(page, 'Farms')).toHaveText('2+ 1 gauge');
	await expect(stat(page, 'Outflow gauge')).toHaveText('Outflow gauge');
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 360, height: 740 } });

	test('a long email in a member row wraps at its dots and @, never mid-word', async ({ page }) => {
		// Realistic parts (a short unique tag): one part longer than the column may still break anywhere.
		const tag = `${process.pid}${Date.now()}`.slice(-7);
		const email = `catchment.hydrology-consultant.${tag}@very-long-subdomain.example.com`;
		const res = await page.request.post(`${API_URL}/auth/register`, { data: { email, password: PASSWORD, displayName: 'Long Address' } });
		expect(res.status()).toBe(201);
		const project = await createProject(page.request, 'Long email');
		await page.goto(`/projects/${project.id}`);
		const cell = page.getByRole('region', { name: 'Members' }).getByRole('rowheader', { name: /Long Address/ });
		await expect(cell).toContainText(email);

		// Each part between break points is its own text node; none may span two lines.
		const lines = await cell.locator('.sub-email').evaluate((el) => {
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
			const out: { text: string; lines: number }[] = [];
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const r = document.createRange();
				r.selectNodeContents(n);
				const tops = new Set([...r.getClientRects()].map((b) => Math.round(b.top)));
				out.push({ text: n.textContent ?? '', lines: tops.size });
			}
			return { parts: out, height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) };
		});
		expect(lines.parts.map((p) => p.text).join('')).toBe(email);
		expect(lines.height).toBeGreaterThan(lines.lineHeight * 1.5); // it did wrap
		expect(lines.parts.filter((p) => p.lines > 1)).toEqual([]);
	});
});

test('data added from the Overview tab shows up in its counts and checklist straight away', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Overview upload');
	await page.goto(`/projects/${project.id}`);
	await expect(stat(page, 'Time series')).toHaveText('0');

	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await dialog.getByLabel('CSV file').setInputFiles({
		name: 'rain.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,value\n2021-10-01,1\n2021-10-02,0\n2021-10-03,4\n')
	});
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(dialog).toBeHidden();

	await expect(stat(page, 'Time series')).toHaveText('1');
	await expect(setup(page)).toContainText('Rainfall loaded. No observed flow yet');
});
