// The Restriction log (?tab=restrictions, docs/ui.md § Restriction log; the WUA persona's log of restriction
// decisions): opened from the Publication panel, it lists every restriction published and every change to its notice,
// newest first, with who, when, the notice in each language and the run, the newest of the current publication marked
// In force; a note-only change isn't one. More than a page loads with Show older decisions. A viewer reads the same
// list; a non-member's request is refused. Empty: says how the first one is made. Axe at 1440 and 390, light and dark.
// Synthetic data only.
import { readFile } from 'node:fs/promises';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

const decisions = (page: import('@playwright/test').Page) => page.getByTestId('restriction-decision');

test('the Restriction log lists every restriction decision, opened from the Publication panel, for staff and viewers', async ({ page, owner, signIn }) => {
	void owner;
	await page.setViewportSize({ width: 1440, height: 960 });
	const project = await seedRunnableProject(page.request, 'Restriction log');
	const runId = await createRun(page.request, project.id, 'Baseline');
	const published = await page.request.post(`${API_URL}/projects/${project.id}/publication`, {
		data: { runId, note: 'Dry spell', restriction: { level: 'advisory', pct: 10, notice: { en: 'Irrigate at night only.', af: 'Besproei net snags.' } }, nextExpectedOn: '2031-01-15' }
	});
	expect(published.status()).toBe(201);
	const pubId = (await published.json()).publication.id as string;
	const patch = (data: Record<string, unknown>) => page.request.patch(`${API_URL}/projects/${project.id}/publication/${pubId}`, { data });
	expect((await patch({ restriction: { level: 'restricted', pct: 25, notice: { en: 'Cut by a quarter.' } } })).status()).toBe(200);
	// The staff note alone: not a restriction decision (History keeps it).
	expect((await patch({ note: 'Only the note' })).status()).toBe(200);

	// From the Publication panel on Runs & results.
	await page.goto(`/projects/${project.id}?tab=runs`);
	await page.getByTestId('restriction-log-link').click();
	await expect(page).toHaveURL(/[?&]tab=restrictions/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Restriction log');
	// Linked-only: the sidebar shows it under Review while it is open.
	const nav = page.getByRole('navigation', { name: 'Project sections' });
	await expect(nav.getByRole('link', { name: 'Restriction log' })).toHaveAttribute('aria-current', 'page');
	await expect(sectionHeader(page).getByTestId('restriction-log-context')).toContainText('In force: Restricted · 25 %, since');

	await expect(decisions(page)).toHaveCount(2);
	const changed = decisions(page).first();
	await expect(changed.getByRole('heading', { level: 3 })).toHaveText('Changed the restriction');
	await expect(changed.getByTestId('restriction-level')).toHaveText('Restricted · 25 %');
	await expect(changed.getByTestId('restriction-in-force')).toHaveText('In force');
	await expect(changed).toContainText(`By ${owner.displayName}`);
	await expect(changed.locator('dd[lang="en"]')).toHaveText('Cut by a quarter.');
	const first = decisions(page).last();
	await expect(first.getByRole('heading', { level: 3 })).toHaveText('Published a run');
	await expect(first.getByTestId('restriction-level')).toHaveText('Advisory · 10 %');
	await expect(first.getByTestId('restriction-in-force')).toHaveCount(0);
	await expect(first.locator('dd[lang="af"]')).toHaveText('Besproei net snags.');
	await expect(first).toContainText('Sent to 2 hydrological units');
	await expect(first).toContainText('Next publication expected 15 Jan 2031');
	await expect(first).toContainText('Staff note (farmers don’t see it): Dry spell');
	await expect(page.getByTestId('restriction-log-more')).toHaveCount(0);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'light' });

	// Open the run: its Publication panel on Runs & results.
	await first.getByRole('link', { name: /^Open the run/ }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]tab=runs&run=${runId}#res-publication$`));
	await expect(page.getByTestId('publication-published')).toBeVisible();

	// More than a page: 50 at a time, the rest behind Show older decisions.
	for (let i = 1; i <= 50; i++) expect((await patch({ restriction: { level: 'advisory', pct: i } })).status()).toBe(200);
	await page.goto(`/projects/${project.id}?tab=restrictions`);
	await expect(decisions(page)).toHaveCount(50);
	await expect(decisions(page).first().getByTestId('restriction-level')).toHaveText('Advisory · 50 %');

	// Download CSV: the whole log in one file, not the page's 50, newest first, the notice per language.
	const download = page.waitForEvent('download');
	await sectionHeader(page).getByTestId('restriction-log-csv').click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/^restriction-log_restriction-log_\d{4}-\d{2}-\d{2}\.csv$/);
	const rows = (await readFile((await file.path())!, 'utf8')).replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
	expect(rows[0]).toMatch(/^decided_at_utc,decision,changed,by,automatic,level,restriction_pct,in_force,notice_en,notice_af,/);
	expect(rows).toHaveLength(53);
	expect(rows[1]).toContain(',notice_changed,restriction,');
	expect(rows[1]).toContain(',advisory,50,yes,');
	expect(rows[52]).toContain(',published,,');
	expect(rows[52]).toContain(',Irrigate at night only.,Besproei net snags.,yes,2031-01-15,');

	// On paper: the list and a line saying what it holds; the workspace's buttons and Show older decisions left off.
	await page.emulateMedia({ media: 'print' });
	await expect(page.getByTestId('restriction-log-printed')).toHaveText(/^Printed .*: 50 decisions, newest first\. Older decisions weren’t loaded: Download CSV holds the whole log\.$/);
	await expect(sectionHeader(page).getByTestId('header-actions')).toBeHidden();
	await expect(page.getByTestId('restriction-log-more')).toBeHidden();
	await expect(decisions(page).first()).toBeVisible();
	await expect(decisions(page).first().getByRole('link', { name: /^Open the run/ })).toBeHidden();
	await expect(decisions(page).first()).toContainText(`run ${runId.slice(0, 8)}`);
	await page.emulateMedia({ media: 'screen' });
	await expect(page.getByTestId('restriction-log-printed')).toBeHidden();

	await page.getByTestId('restriction-log-more').click();
	await expect(decisions(page)).toHaveCount(52);
	await expect(decisions(page).last().getByRole('heading', { level: 3 })).toHaveText('Published a run');
	await expect(page.getByTestId('restriction-log-more')).toHaveCount(0);

	// A viewer (the authority's member, say) reads the same list, on a phone, light and dark.
	const viewer = await signIn('Restriction log viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.setViewportSize({ width: 390, height: 844 });
	await v.goto(`/projects/${project.id}?tab=restrictions`);
	await expect(v.getByRole('heading', { level: 1 })).toHaveText('Restriction log');
	await expect(decisions(v)).toHaveCount(50);
	expect(await v.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await expectNoViolations(v);
	await v.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(v);

	// Someone outside the project is refused.
	const stranger = await signIn('Restriction log stranger');
	expect((await stranger.page.request.get(`${API_URL}/projects/${project.id}/restriction-log`)).status()).toBe(404);
	expect((await stranger.page.request.get(`${API_URL}/projects/${project.id}/restriction-log/export.csv`)).status()).toBe(404);
});

test('the Restriction log says how the first decision is made while nothing is published', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Restriction log, empty');
	await page.goto(`/projects/${project.id}?tab=restrictions`);
	await expect(page.getByTestId('restriction-log-empty')).toHaveText('No restriction decisions yet.');
	await expect(sectionHeader(page).getByTestId('restriction-log-context')).toHaveText('Nothing published yet');
	// Nothing to download yet.
	await expect(sectionHeader(page).getByTestId('restriction-log-csv')).toHaveCount(0);
	await expect(page.getByTestId('restriction-log').getByRole('link', { name: 'Publication panel' })).toHaveAttribute('href', '?tab=runs#res-publication');
	await expectNoViolations(page);
});
