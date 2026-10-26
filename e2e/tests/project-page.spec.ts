// The Project page (?tab=project, issue #17 option A, docs/ui.md § Project): the project's details, import
// record and notes, the model's headline facts, and who can open it (team, members, farmers, share links), moved
// unchanged from below the Summary's first screen. The Summary links here, and its old `#…-h` links land here.
// Synthetic data only.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, LEGAL_VERSION, PASSWORD, register, seedRunnableProject } from '../support/api.ts';
import { plantEmailToken } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { fact, membersPanel, openProject } from '../support/project.ts';
import { answerConfirm } from '../support/confirm.ts';

const strip = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
/** The page's save bar while only the project details are unsaved. */
const detailsBar = (page: Page) => page.getByRole('region', { name: 'Unsaved project details' });
const summaryLink = (page: Page) => page.getByRole('link', { name: /^Model facts, details, team and sharing\s+Project$/ });

test('the page: one title, its context and Download in the header, the facts, details and who has access', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Project page');
	await createRun(page.request, project.id, 'Baseline');
	// A project that wasn't imported asks for its import record and gets "none", not a 404 (issue #162).
	const importReport = page.waitForResponse((r) => r.url().endsWith(`/projects/${project.id}/import-report`));
	await openProject(page, project.id);
	const noReport = await importReport;
	expect(noReport.status()).toBe(200);
	expect(await noReport.json()).toEqual({ report: null });

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
	// No Recent changes (issue #177): History is in the sidebar, and its header names the latest change.
	await expect(region(page, 'Recent changes')).toHaveCount(0);

	// The notes list fills in after its card is on the page and moves what follows it: measure once it has.
	await expect(region(page, 'Recent notes')).toHaveAttribute('data-notes-ready', 'true');
	// One column in the side index's order (issue #586 R4-B; it was details on the left, who has access on the right):
	// the details, then the team over the members, every panel the column's width.
	const details = (await region(page, 'Project details').boundingBox())!;
	const team = (await region(page, 'Team').boundingBox())!;
	const members = (await region(page, 'Members').boundingBox())!;
	for (const box of [team, members]) {
		expect(Math.round(box.x)).toBe(Math.round(details.x));
		expect(Math.round(box.width)).toBe(Math.round(details.width));
	}
	expect(team.y).toBeGreaterThanOrEqual(details.y + details.height);
	expect(members.y).toBeGreaterThanOrEqual(team.y + team.height);
	// The first screen answers "what is this project and who has it": details and the team are in the window.
	for (const el of [region(page, 'Project details'), region(page, 'Team')]) await expect(el).toBeInViewport({ ratio: 1 });
	await expect(region(page, 'Members')).toBeInViewport();
	// The model's facts repeat each tab's header line, so they come after who has access, under the notes (issue #176).
	const facts = (await region(page, 'The model').boundingBox())!;
	const notes = (await region(page, 'Recent notes').boundingBox())!;
	const farmers = (await page.getByRole('region', { name: /^Farmers/ }).boundingBox())!;
	expect(Math.round(facts.x)).toBe(Math.round(details.x));
	expect(notes.y).toBeGreaterThanOrEqual(farmers.y + farmers.height);
	expect(facts.y).toBeGreaterThanOrEqual(notes.y + notes.height);
	// Four tiles a row across the column: 4 × 2.
	const tiles = page.locator('dl.stats > div');
	const tops = new Set(await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top))));
	expect(tops.size).toBe(2);
	// The details' fields two a row (name beside the time zone, description beside the WUA name), not stretched across.
	const name = (await page.getByLabel('Name', { exact: true }).boundingBox())!;
	const zone = (await page.getByRole('combobox', { name: 'Time zone' }).boundingBox())!;
	expect(zone.x).toBeGreaterThan(name.x + name.width);
	expect(name.width).toBeLessThan(details.width / 2);

	// Members and Responsible authority explain themselves in their headings' ⓘ (and the glossary behind them), not in
	// paragraphs that repeated them (issue #521 § 13): the authority's form starts under its heading.
	const membersRegion = region(page, 'Members');
	await expect(membersRegion.getByRole('button', { name: 'About roles' })).toBeVisible();
	await expect(membersRegion).not.toContainText('Anyone without an account gets an email invitation');
	const authority = page.getByTestId('authority-panel');
	await expect(authority.getByRole('button', { name: 'About the responsible authority' })).toBeVisible();
	await expect(authority).not.toContainText('Who decides this project’s licence applications');
	const authorityHeading = (await authority.getByRole('heading', { level: 2 }).boundingBox())!;
	const authorityName = (await authority.getByLabel('Authority name').boundingBox())!;
	expect(authorityName.y - (authorityHeading.y + authorityHeading.height)).toBeLessThan(60);

	// The Summary keeps none of it.
	await strip(page).getByRole('link', { name: 'Summary', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Latest run', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'The model' })).toHaveCount(0);
	await expect(region(page, 'Project details')).toHaveCount(0);
	await expect(region(page, 'Members')).toHaveCount(0);
});

test('the Summary links here and Back returns; details save from the page’s save bar', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Project from the Summary');
	await page.goto(`/projects/${project.id}`);
	await summaryLink(page).click();
	await expect(page).toHaveURL(/\?tab=project$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Project', exact: true })).toBeVisible();

	// The details go through the same sticky bar as the model's edits (issue #162 item 12): no button of their own.
	await expect(page.getByRole('button', { name: 'Save details' })).toHaveCount(0);
	const name = page.getByLabel('Name', { exact: true });
	await name.fill('Project renamed');
	await expect(detailsBar(page)).toContainText('Unsaved changes to the project details');
	await detailsBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(detailsBar(page)).toHaveCount(0);
	await expect(page.getByTestId('project-name')).toHaveText('Project renamed');

	// An empty name can't be saved: the bar says why.
	await name.fill(' ');
	await expect(detailsBar(page)).toContainText('The project needs a name.');
	await expect(detailsBar(page).getByRole('button', { name: 'Save changes' })).toBeDisabled();
	// Discard puts the saved name back.
	await detailsBar(page).getByRole('button', { name: 'Discard' }).click();
	await answerConfirm(page, true, 'Your unsaved changes to the project details will be lost.');
	await expect(name).toHaveValue('Project renamed');
	await expect(detailsBar(page)).toHaveCount(0);

	// The WUA's name, which the farm pages' contact lines use (095_wua_name).
	await page.getByLabel('WUA name').fill('Summary Valley WUA');
	await detailsBar(page).getByRole('button', { name: 'Save changes' }).click();
	await expect(detailsBar(page)).toHaveCount(0);
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

	// The facts' old fragment lands on them, after who has access (issue #176, issue #586 R4-B).
	await page.goto(`/projects/${project.id}#model-h`);
	await expect(page).toHaveURL(/\?tab=project#model-h$/);
	const model = page.getByRole('heading', { level: 2, name: 'The model' });
	await expect(model).toBeFocused();
	await expect(model).toBeInViewport();

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
	await expect(v.getByTestId('details-save-hint')).toHaveCount(0);
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
			const members = region(page, 'Members');
			const farmers = page.getByRole('region', { name: /^Farmers/ });
			const invites = farmers.getByRole('region', { name: /^Pending farmer invitations/ });
			await expect(invites).toContainText('Pending farmer invitations (30)');
			await expect(region(page, 'Recent notes')).toHaveAttribute('data-notes-ready', 'true');

			// Each long list shows its first eight and opens the rest in place, never scrolling inside its card (issue
			// #586 R4-F): unfolded, Recent notes sat 5,063 px down at 1440 and 13,960 px down on a phone.
			await expect(members.getByRole('rowheader')).toHaveCount(8);
			await expect(members.getByRole('rowheader').first()).toContainText(`${owner.displayName} (you)`);
			// By name as a reader counts (the server sorts as text: 1, 10, 11 … 19, 2).
			await expect(members.getByRole('rowheader').nth(2)).toContainText('Hydrologist 2 with');
			await expect(invites.getByRole('listitem')).toHaveCount(8);
			const showMembers = members.getByRole('button', { name: 'Show all 31 members' });
			const showInvites = invites.getByRole('button', { name: 'Show all 30 invitations' });
			for (const b of [showMembers, showInvites]) await expect(b).toHaveAttribute('aria-expanded', 'false');
			const notesTop = (await region(page, 'Recent notes').boundingBox())!.y;
			// Measured 3,663 px at 1440 and 6,961 px on a phone, the rest being the panels between (who decides, share
			// links, two-step sign-in …), which the side index reaches in one click.
			expect(notesTop).toBeLessThan(label === 'desktop' ? 4_000 : 7_600);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			if (label === 'desktop') await expect(region(page, 'Project details')).toBeInViewport({ ratio: 1 });
			await expectNoViolations(page);

			// Opened: every row, the list growing with the page rather than scrolling inside its card.
			await showMembers.click();
			await expect(members.getByRole('rowheader')).toHaveCount(31);
			const less = members.getByRole('button', { name: 'Show the first 8 members' });
			await expect(less).toHaveAttribute('aria-expanded', 'true');
			await expect(less).toBeFocused();
			expect(await members.locator('.table-wrap').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
			await showInvites.click();
			await expect(invites.getByRole('listitem')).toHaveCount(30);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
			await less.click();
			await expect(members.getByRole('rowheader')).toHaveCount(8);
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

	test('the page stacks details, team, members, facts, and a long description shows in full', async ({ page, owner }) => {
		void owner;
		const project = await createProject(page.request, 'Project phone stack');
		await openProject(page, project.id);
		const desc = page.getByLabel('Description');
		await desc.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long catchment description.`).join('\n'));
		// It grows to fit rather than hiding the text behind an inner scrollbar.
		expect(await desc.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

		// The side index's order (issue #586 R4-B): who has access before the facts.
		const ys: number[] = [];
		for (const name of ['Project details', 'Team', 'Members', 'The model']) ys.push((await region(page, name).boundingBox())!.y);
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

// The in-page menu (common/SectionNav, issue #586 R1-E): a side index from a 1440 px window, the two-row bar below
// that and one sideways strip on a phone, every link a panel's heading word for word (a trailing count dropped:
// "Farmers (0)" is "Farmers"), read from the page, so a panel a reader isn't shown has no link and a panel added to
// PROJECT_ANCHORS gets one with no other change.
const sections = (page: Page) => page.getByRole('navigation', { name: 'Project page sections' });
/** The panels' headings as the page draws them, in page order, without their ⓘ or a trailing count. */
const panelHeadings = (page: Page) =>
	page.locator('.project-page').evaluate((root) =>
		// Each panel's own heading: the first h2 of each column's child (not a closed dialog's inside it, Notes').
		[...root.querySelectorAll<HTMLElement>('[data-nav-group] > *')].flatMap((p) => (p.querySelector('h2') ? [p.querySelector('h2')!] : [])).map((h) => {
			const copy = h.cloneNode(true) as HTMLElement;
			copy.querySelectorAll('button, .helptip, .visually-hidden, [aria-hidden="true"]').forEach((n) => n.remove());
			return (copy.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\s*\(\d[\d\s]*\)$/, '');
		})
	);
/** Every link the menu has, on the bar and (opened) in More, in order. */
async function menuLinks(page: Page): Promise<string[]> {
	const nav = sections(page);
	const more = nav.getByRole('button', { name: /^More/ });
	if (await more.count()) await more.click();
	const names = await nav.getByRole('link').allInnerTexts();
	if (await more.count()) await page.keyboard.press('Escape');
	return names.map((n) => n.trim());
}

test.describe('the page’s side index and bar', () => {
	test('at 1440: a side index beside the panels, grouped by column, each link its heading; a link lands on its heading and Back returns', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1440, height: 960 });
		const project = await seedRunnableProject(page.request, 'Project side index');
		await openProject(page, project.id);
		const nav = sections(page);
		// Three groups, one per column of the one-column page (issue #586 R4-B).
		await expect(nav.getByRole('list', { name: 'The project' }).getByRole('link')).toHaveText(['Project details']);
		await expect(nav.getByRole('list', { name: 'People and access' }).getByRole('link').first()).toHaveText('Team');
		await expect(nav.getByRole('list', { name: 'Notes, facts and reports' }).getByRole('link')).toHaveText(['Recent notes', 'The model', 'Scheduled reports']);
		const headings = await panelHeadings(page);
		// API keys and Scheduled reports came from Settings (issue #586 R1-B) and got their links with no other change.
		expect(headings).toEqual(expect.arrayContaining(['Project details', 'Scheduled reports', 'Members', 'Farmers', 'Share links', 'API keys', 'Two-step sign-in', 'Licence record']));
		expect(await menuLinks(page)).toEqual(headings);

		// Beside the page, not above it: the details start level with the index, and the whole index is in the window.
		const rail = (await nav.boundingBox())!;
		const details = (await region(page, 'Project details').boundingBox())!;
		expect(details.x).toBeGreaterThanOrEqual(rail.x + rail.width);
		expect(rail.y + rail.height).toBeLessThanOrEqual(960);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

		// Following a link: the fragment, the heading focused and in view, the link marked; Back goes to the top again.
		await nav.getByRole('link', { name: 'Licence record' }).click();
		await expect(page).toHaveURL(/\?tab=project#licence-record$/);
		const heading = page.getByRole('heading', { level: 2, name: 'Licence record' });
		await expect(heading).toBeFocused();
		await expect(heading).toBeInViewport();
		await expect(nav.getByRole('link', { name: 'Licence record' })).toHaveAttribute('aria-current', 'location');
		await page.goBack();
		await expect(page).toHaveURL(/\?tab=project$/);
		await expect(region(page, 'Project details')).toBeInViewport();
	});

	// Issue #586 R4-B: the page was two columns, and a link to a panel in the taller right column (Farmers onward) put
	// it at the window's top beside an empty left column. It is one column in the index's order now, so a link to any
	// panel fills the space beside the index from the panel down.
	for (const [width, height] of [
		[1440, 960],
		[1280, 800]
	] as const) {
		test(`at ${width}: one column in the index’s order, so a link to a panel far down shows it, and what follows, the column’s full width`, async ({ page, owner }) => {
			void owner;
			await page.setViewportSize({ width, height });
			const project = await seedRunnableProject(page.request, `Project one column ${width}`);
			await openProject(page, project.id);
			const nav = sections(page);
			// Every panel has the same left edge and width: one column.
			const boxes = await page.locator('.project-page [data-nav-group] > *').evaluateAll((els) =>
				els.filter((el) => el.getBoundingClientRect().height > 0).map((el) => ({ x: Math.round(el.getBoundingClientRect().x), w: Math.round(el.getBoundingClientRect().width) }))
			);
			expect(boxes.length).toBeGreaterThan(10);
			expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
			expect(new Set(boxes.map((b) => b.w)).size).toBe(1);
			// The page reads in the index's order: each panel's heading below the one before it, as the menu lists them.
			const names = await menuLinks(page);
			const tops: number[] = [];
			for (const name of names) tops.push((await page.getByRole('heading', { level: 2, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().boundingBox())!.y);
			expect(tops).toEqual([...tops].sort((a, b) => a - b));

			await nav.getByRole('link', { name: 'Farmers' }).click();
			await expect(page).toHaveURL(/\?tab=project#farmers-h$/);
			const farmers = page.getByRole('heading', { level: 2, name: /^Farmers/ });
			await expect(farmers).toBeFocused();
			await expect(farmers).toBeInViewport();
			// Beside the index, the column from Farmers down: the panel spans it, and the panels after it carry on under
			// it to the window's foot, with no empty column beside them.
			const panel = (await page.getByRole('region', { name: /^Farmers/ }).boundingBox())!;
			const details = (await region(page, 'Project details').boundingBox())!;
			expect(Math.round(panel.x)).toBe(Math.round(details.x));
			expect(Math.round(panel.width)).toBe(Math.round(details.width));
			const after = (await region(page, 'Share links').boundingBox())!;
			expect(after.y).toBeLessThan(height);
			expect(Math.round(after.x)).toBe(Math.round(panel.x));
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			await page.goBack();
			await expect(page).toHaveURL(/\?tab=project$/);
		});
	}

	test('at 1280: the bar, at most two rows, every heading on it or in More; a reload of a link lands on its heading', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 1280, height: 800 });
		const project = await seedRunnableProject(page.request, 'Project bar');
		await openProject(page, project.id);
		const nav = sections(page);
		// Two rows of 30 px pills and their gaps: never a third.
		expect((await nav.boundingBox())!.height).toBeLessThan(90);
		expect(await menuLinks(page)).toEqual(await panelHeadings(page));
		// The bar sits above the panels.
		expect((await region(page, 'Project details').boundingBox())!.y).toBeGreaterThan((await nav.boundingBox())!.y);

		// A fresh load (not a hash change on the open page).
		await page.goto('/');
		await openProject(page, project.id, '#project-two-step-h');
		const twoStep = page.getByRole('heading', { level: 2, name: 'Two-step sign-in' });
		await expect(twoStep).toBeFocused();
		await expect(twoStep).toBeInViewport();
		// Not under the sticky bar (WCAG 2.4.11).
		expect((await twoStep.boundingBox())!.y).toBeGreaterThanOrEqual((await nav.boundingBox())!.y + (await nav.boundingBox())!.height - 1);
	});

	test('on a phone: one strip with every link, and the page doesn’t scroll sideways', async ({ page, owner }) => {
		void owner;
		await page.setViewportSize({ width: 390, height: 844 });
		const project = await seedRunnableProject(page.request, 'Project strip');
		await openProject(page, project.id);
		const nav = sections(page);
		await expect(nav.getByRole('button', { name: /^More/ })).toHaveCount(0);
		expect(await menuLinks(page)).toEqual(await panelHeadings(page));
		const tops = new Set(await nav.getByRole('link').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top))));
		expect(tops.size).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await expectNoViolations(page);
	});

	test('a viewer’s menu lists only the panels a viewer is shown', async ({ page, owner, signIn }) => {
		void owner;
		const project = await createProject(page.request, 'Project viewer menu');
		const viewer = await signIn('Project menu viewer');
		await addMember(page.request, project.id, viewer.user.email, 'viewer');
		const v = viewer.page;
		await v.setViewportSize({ width: 1440, height: 960 });
		await openProject(v, project.id);
		const names = await menuLinks(v);
		expect(names).toEqual(await panelHeadings(v));
		for (const owners of ['Share links', 'Two-step sign-in', 'Registration checks', 'Licence record']) expect(names).not.toContain(owners);
		expect(names).toContain('Members');
	});
});

test('share links before anything is published link to where a run is published, landing on it', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Project unpublished');
	await createRun(page.request, project.id, 'Baseline');
	await openProject(page, project.id);
	const note = page.getByTestId('share-unpublished');
	await expect(note).toHaveText('Nothing is published yet: a link opens only once a run is published, from its Publication on Runs & results.');
	await note.getByRole('link', { name: 'Publication on Runs & results' }).click();
	await expect(page).toHaveURL(/\?tab=runs&run=[0-9a-f-]+#res-publication$/);
	await expect(page.getByRole('heading', { name: 'Publication', exact: true })).toBeFocused();
});
