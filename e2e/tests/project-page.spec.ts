// The Project page (?tab=project, issue #17 option A, docs/ui.md § Project): the model's headline facts, the
// project's details, import record and notes, and who can open it (team, members, farmers, share links), moved
// unchanged from below the Summary's first screen. The Summary links here, and its old `#…-h` links land here.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, LEGAL_VERSION, PASSWORD, register, seedRunnableProject } from '../support/api.ts';
import { plantEmailToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { fact, membersPanel, openProject } from '../support/project.ts';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const summaryLink = (page: Page) => page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ });

test('the page: one title, its context and Download in the header, the facts, details and who has access', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Project page');
	await createRun(page.request, project.id, 'Baseline');
	await openProject(page, project.id);

	// Under Review in the sections, marked as the open tab; the section header is the only page title.
	await expect(strip(page).getByRole('group', { name: 'Review' }).getByRole('link').first()).toHaveText('Project');
	await expect(strip(page).getByRole('link', { name: 'Project', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('h1')).toHaveCount(1);
	await expect(page.getByTestId('section-context')).toHaveText(/^Personal project · created \d{1,2} [A-Z][a-z]{2} \d{4} · time zone Africa\/Johannesburg$/);
	const header = page.getByTestId('section-header');
	await header.getByRole('button', { name: 'Download' }).click();
	await expect(header.getByRole('button', { name: /Download project \(JSON\)/ })).toBeVisible();
	await page.keyboard.press('Escape');

	// The model's facts, each counting from the page's lists.
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toBeVisible();
	await expect(fact(page, 'Hydrological units')).toHaveText('2+ 1 gauge');
	await expect(fact(page, 'Time series')).toHaveText('2');
	await expect(fact(page, 'Model runs')).toHaveText('1');
	await expect(fact(page, 'Outflow gauge')).toHaveText('Outflow gauge');

	// Every panel that sat below the Summary's first screen (an owner sees share links; the import record is an imported project's only).
	for (const name of ['Project details', 'Recent notes', 'Team', 'Members', 'Share links']) await expect(region(page, name)).toBeVisible();
	await expect(page.getByRole('region', { name: /^Farmers/ })).toBeVisible();
	await expect(region(page, 'Import record')).toHaveCount(0);

	// Details on the left, who has access on the right: Team above Members, level with the details.
	const details = (await region(page, 'Project details').boundingBox())!;
	const team = (await region(page, 'Team').boundingBox())!;
	const members = (await region(page, 'Members').boundingBox())!;
	expect(Math.round(team.x)).toBe(Math.round(members.x));
	expect(team.x).toBeGreaterThan(details.x + details.width);
	expect(team.y + team.height).toBeLessThanOrEqual(members.y);
	expect(Math.round(team.y)).toBe(Math.round(details.y));
	// The first screen answers "what is this project and who has it": facts, details and the team are in the window.
	for (const el of [page.locator('dl.stats'), region(page, 'Project details'), region(page, 'Team')]) await expect(el).toBeInViewport({ ratio: 1 });
	await expect(region(page, 'Members')).toBeInViewport();

	// The Summary keeps none of it.
	await strip(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(region(page, 'Project details')).toHaveCount(0);
	await expect(region(page, 'Members')).toHaveCount(0);
});

test('the Summary links here and Back returns; details save from here', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Project from the Summary');
	await page.goto(`/projects/${project.id}`);
	await summaryLink(page).click();
	await expect(page).toHaveURL(/\?tab=project$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();

	const name = page.getByLabel('Name', { exact: true });
	await name.fill('Project renamed');
	await page.getByRole('button', { name: 'Save details' }).click();
	await expect(region(page, 'Project details').getByRole('status')).toHaveText('Saved.');
	await expect(page.getByTestId('project-name')).toHaveText('Project renamed');

	// The WUA's name, which the farm pages' contact lines use (095_wua_name).
	await page.getByLabel('WUA name').fill('Summary Valley WUA');
	await page.getByRole('button', { name: 'Save details' }).click();
	await expect(region(page, 'Project details').getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.getByLabel('WUA name')).toHaveValue('Summary Valley WUA');

	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	await expect(summaryLink(page)).toBeVisible();
});

test('old links: a Summary #…-h fragment lands on its panel here, focused, and Back skips the redirect; the aliases open it', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1280, height: 800 });
	const project = await createProject(page.request, 'Project old links');
	await page.goto('/');
	await page.goto(`/projects/${project.id}#share-h`);
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}\\?tab=project#share-h$`));
	const heading = page.getByRole('heading', { level: 2, name: 'Share links' });
	await expect(heading).toBeFocused();
	await expect(heading).toBeInViewport();
	// The redirect replaced the Summary's entry: Back leaves the project.
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);

	await page.goto(`/projects/${project.id}#members-h`);
	await expect(page).toHaveURL(/\?tab=project#members-h$/);
	await expect(page.getByRole('heading', { level: 2, name: 'Members' })).toBeFocused();

	// A fragment that isn't one of the moved panels stays on the Summary.
	await page.goto(`/projects/${project.id}#setup-h`);
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}#setup-h$`));

	for (const alias of ['details', 'members', 'sharing']) {
		await page.goto(`/projects/${project.id}?tab=${alias}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();
	}
});

test('a viewer sees the page without the model inputs, read-only, with no share links or invites', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Project for a viewer');
	const viewer = await signIn('Project viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}`);
	await strip(v).getByRole('link', { name: 'Project', exact: true }).click();
	await expect(membersPanel(v).getByRole('rowheader').first()).toBeVisible();

	await expect(v.getByLabel('Name', { exact: true })).not.toBeEditable();
	await expect(v.getByRole('button', { name: 'Save details' })).toHaveCount(0);
	await expect(v.getByRole('button', { name: 'Invite farmers' })).toHaveCount(0);
	await expect(region(v, 'Share links')).toHaveCount(0);
	// Anyone who can open the project can download a copy.
	await expect(v.getByTestId('section-header').getByRole('button', { name: 'Download' })).toBeEnabled();
	await expectNoViolations(v);
});

test('a fresh project: every fact at zero, and each fact opens the tab behind it from anywhere on its tile', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Project facts');
	await openProject(page, project.id);
	await expect(fact(page, 'Hydrological units')).toHaveText('0+ 0 gauges');
	await expect(fact(page, 'Time series')).toHaveText('0');
	await expect(fact(page, 'Model runs')).toHaveText('0');
	await expect(fact(page, 'Outflow gauge')).toHaveText('–');

	const tabs: [string, string][] = [
		['Hydrological units', 'Network'],
		['Irrigated area', 'Crops & demand'],
		['Active transfers', 'Transfers'],
		['Time series', 'Data'],
		['Model runs', 'Runs & results']
	];
	for (const [term, tab] of tabs) {
		await openProject(page, project.id);
		// Click the tile's bottom-right corner, away from the label: the link covers the whole tile.
		const tile = page.locator('dl.stats > div').filter({ has: page.getByRole('term').filter({ hasText: term }) });
		const box = (await tile.boundingBox())!;
		await tile.click({ position: { x: box.width - 6, y: box.height - 6 } });
		await expect(strip(page).getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
	}
});

test('data added on the Project page shows in its counts straight away', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Project upload');
	await openProject(page, project.id);
	await expect(fact(page, 'Time series')).toHaveText('0');
	await page.getByRole('button', { name: 'Add data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add data' });
	await dialog.getByLabel('Kind').selectOption({ label: 'Rainfall — catchment' });
	await dialog.getByLabel('CSV file').setInputFiles({ name: 'rain.csv', mimeType: 'text/csv', buffer: Buffer.from('date,value\n2021-10-01,1\n2021-10-02,0\n') });
	await dialog.getByRole('button', { name: 'Upload' }).click();
	await expect(dialog).toBeHidden();
	await expect(fact(page, 'Time series')).toHaveText('1');
});

test.describe('the big case: 30 members and 30 pending farmer invites', () => {
	for (const [label, viewport] of [
		['desktop', { width: 1440, height: 960 }],
		['phone', { width: 390, height: 844 }]
	] as const) {
		test(label, async ({ page, owner, playwright }) => {
			void owner;
			test.setTimeout(120_000);
			await page.setViewportSize(viewport);
			const project = await seedRunnableProject(page.request, `Project big case ${label} with a long catchment name to wrap`);
			// Registered through their own client, so the page stays signed in as the owner.
			const others = await playwright.request.newContext();
			const users = [];
			for (let i = 0; i < 30; i++) users.push(await register(others, `Hydrologist ${i + 1} with a long display name`));
			await others.dispose();
			for (const u of users) await addMember(page.request, project.id, u.email, 'viewer');
			const farm = project.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
			for (let i = 0; i < 30; i++) {
				const res = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, {
					data: { email: `big-case-farmer-${i}-${process.pid}-${Date.now()}@example.com`, nodeIds: [farm[i % farm.length]] }
				});
				expect(res.status()).toBe(201);
			}
			await openProject(page, project.id);
			await expect(region(page, 'Members').getByRole('rowheader')).toHaveCount(31);
			await expect(page.getByRole('region', { name: /^Farmers/ })).toContainText('Pending farmer invitations (30)');
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			if (label === 'desktop') await expect(region(page, 'Project details')).toBeInViewport({ ratio: 1 });
			await expectNoViolations(page);
		});
	}
});

test.describe('no accessibility violations', () => {
	for (const [label, viewport, scheme] of [
		['desktop, light', { width: 1440, height: 960 }, 'light'],
		['desktop, dark', { width: 1440, height: 960 }, 'dark'],
		['phone', { width: 390, height: 844 }, 'light']
	] as const) {
		test(label, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme: scheme });
			const project = await seedRunnableProject(page.request, `Project a11y ${label}`);
			await createRun(page.request, project.id, 'Baseline');
			await openProject(page, project.id);
			await expect(region(page, 'Share links').getByText('No share links yet.')).toBeVisible();
			await expect(page.getByRole('region', { name: 'Recent notes' })).toHaveAttribute('data-notes-ready', 'true');
			if (label === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			await expectNoViolations(page);
		});
	}
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 360, height: 740 } });

	test('the page stacks facts, details, team, members, and a long description shows in full', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Project phone stack');
		await openProject(page, project.id);
		const desc = page.getByLabel('Description');
		await desc.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long catchment description.`).join('\n'));
		// It grows to fit rather than hiding the text behind an inner scrollbar.
		expect(await desc.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

		const ys = [(await page.locator('dl.stats').boundingBox())!.y];
		for (const name of ['Project details', 'Team', 'Members']) ys.push((await region(page, name).boundingBox())!.y);
		expect(ys).toEqual([...ys].sort((a, b) => a - b));
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
	});

	test('a long email in a member row wraps at its dots and @, never mid-word', async ({ page }) => {
		// Realistic parts (a short unique tag): one part longer than the column may still break anywhere.
		const tag = `${process.pid}${Date.now()}`.slice(-7);
		const email = `catchment.hydrology-consultant.${tag}@very-long-subdomain.example.com`;
		const res = await page.request.post(`${API_URL}/auth/register`, { data: { email, password: PASSWORD, displayName: 'Long Address', acceptTerms: LEGAL_VERSION } });
		expect(res.status()).toBe(202);
		// Confirmed, then signed in (issue #57): this page is Long Address's.
		expect((await page.request.post(`${API_URL}/auth/verify-email`, { data: { token: await plantEmailToken(email, 'verify') } })).status()).toBe(200);
		expect((await page.request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } })).status()).toBe(200);
		const project = await createProject(page.request, 'Long email');
		await openProject(page, project.id);
		const cell = region(page, 'Members').getByRole('rowheader', { name: /Long Address/ });
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
