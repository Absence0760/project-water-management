// Alert emails (WP-2.13, docs/ui.md § Alerts): a farmer chooses how often
// they get their farm's dam alerts on /account/alerts (saved as they choose,
// kept on reload); an alert email's unsubscribe link works signed out, asks
// before it acts, says what it turned off and takes the token out of the
// address bar; a replaced or tampered link says it no longer works. Both
// pages pass axe, on a phone. A bounced address (SES, stood in for by
// `pnpm dev:mail:bounce`) pauses a person's alert emails behind a banner on
// the account and alert pages, which turns them back on. An editor sets a
// staleness level per data feed on Overview's rule editor.
import { expectNoViolations } from '../support/a11y.ts';
import { createProject, seedRunnableProject } from '../support/api.ts';
import { plantAlertSubscription } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { simulateBounce } from '../support/jobs.ts';

const PHONE = { width: 360, height: 740 };

test('a farmer chooses how often they get their dam alerts, and the choice is kept', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Alerting catchment');
	const farm = project.model.nodes.find((n) => n.name === 'Lower farm')!;
	const farmer = await signIn('Alert farmer');
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farm.id] } });
	expect(add.status(), await add.text()).toBe(201);
	// The WUA switches dam alerts on for that farm (restriction notices stay off).
	const rules = await page.request.put(`${API_URL}/projects/${project.id}/alert-rules`, { data: { rules: [{ kind: 'dam_below', nodeId: farm.id, threshold: 0.3, enabled: true }] } });
	expect(rules.status(), await rules.text()).toBe(200);

	const p = farmer.page;
	await p.setViewportSize(PHONE);
	await p.goto('/account');
	await p.getByRole('link', { name: 'Choose your alert emails' }).click();
	await expect(p).toHaveURL(/\/account\/alerts$/);
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	await expect(p.getByRole('heading', { level: 1, name: 'Alert emails' })).toBeVisible();
	const section = p.getByRole('region', { name: 'Alerting catchment' });
	const dam = section.getByRole('group', { name: 'Dam running low: Lower farm' });
	const notice = section.getByRole('group', { name: 'Restriction notices from the WUA' });
	// Nothing of the other farm, and nothing catchment-wide a farmer doesn't get.
	await expect(section.getByRole('group')).toHaveCount(2);
	await expect(dam.getByRole('radio', { name: 'Right away' })).toBeChecked();
	await expect(notice.getByText('Not switched on for this catchment yet')).toBeVisible();
	await expect(dam.getByText('Not switched on for this catchment yet')).toHaveCount(0);
	await expectNoViolations(p);

	await dam.getByRole('radio', { name: 'Once a day (06:00)' }).check();
	await expect(section.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	await p.reload();
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	await expect(p.getByRole('region', { name: 'Alerting catchment' }).getByRole('group', { name: 'Dam running low: Lower farm' }).getByRole('radio', { name: 'Once a day (06:00)' })).toBeChecked();
});

// Screen use (issue #17): one card per catchment, side by side on a wide
// screen, stacked on a phone, never a sideways scroll.
test('the alert emails page lays its catchments out as cards across the width', async ({ page, owner }) => {
	void owner;
	await seedRunnableProject(page.request, 'Cards catchment A');
	await seedRunnableProject(page.request, 'Cards catchment B');
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/account/alerts');
	await expect(page.locator('main[data-ready="true"]')).toBeVisible();
	const a = (await page.getByRole('region', { name: 'Cards catchment A' }).boundingBox())!;
	const b = (await page.getByRole('region', { name: 'Cards catchment B' }).boundingBox())!;
	expect(Math.abs(a.y - b.y)).toBeLessThan(1);
	expect(Math.abs(a.x - b.x)).toBeGreaterThan(a.width - 1);

	await page.setViewportSize(PHONE);
	const a2 = (await page.getByRole('region', { name: 'Cards catchment A' }).boundingBox())!;
	const b2 = (await page.getByRole('region', { name: 'Cards catchment B' }).boundingBox())!;
	expect(Math.abs(a2.x - b2.x)).toBeLessThan(1);
	expect(Math.abs(a2.y - b2.y)).toBeGreaterThan(Math.min(a2.height, b2.height) - 1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
	await expectNoViolations(page);
});

test('an alert email’s unsubscribe link works signed out, asks first, and a dead link says so', async ({ page, owner, browser }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Unsubscribe catchment');
	// The owner's dam alerts (for the WUA, one choice covers every farm), as if an alert email had carried its link.
	const token = await plantAlertSubscription(owner.email, project.id, 'dam_below');

	const context = await browser.newContext({ viewport: PHONE });
	const p = await context.newPage();
	try {
		await p.goto(`/alerts/unsubscribe#t=${token}`);
		await expect(p.locator('[data-state="ask"]')).toBeVisible();
		await expect(p.getByRole('heading', { name: 'Stop alert emails' })).toBeVisible();
		// The token is read, then taken out of the address bar.
		await expect(p).toHaveURL(/\/alerts\/unsubscribe$/);
		await expectNoViolations(p);

		await p.getByRole('button', { name: 'Stop these emails' }).click();
		await expect(p.getByRole('status')).toHaveText('You won’t get dam level emails for Unsubscribe catchment any more.');
		await expect(p.getByRole('link', { name: 'Manage alerts' }).first()).toBeVisible();
		await expectNoViolations(p);

		// The owner's preferences now show it off.
		const mine = await page.request.get(`${API_URL}/me/alerts`);
		const entry = ((await mine.json()).projects as { id: string; choices: { kind: string; mode: string }[] }[]).find((x) => x.id === project.id)!;
		expect(entry.choices.find((c) => c.kind === 'dam_below')!.mode).toBe('off');

		// A tampered token: the page says the link no longer works.
		const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
		await p.goto('/');
		await p.goto(`/alerts/unsubscribe#t=${tampered}`);
		await p.getByRole('button', { name: 'Stop these emails' }).click();
		await expect(p.getByRole('alert')).toHaveText(/This link doesn’t work any more/);
		await expectNoViolations(p);

		// No token at all.
		await p.goto('/');
		await p.goto('/alerts/unsubscribe');
		await expect(p.locator('[data-state="incomplete"]')).toBeVisible();
		await expect(p.getByRole('alert')).toHaveText(/This link is incomplete/);
	} finally {
		await context.close();
	}
});

test('a bounced address pauses the alert emails behind a banner, which turns them back on', async ({ signIn }) => {
	const farmer = await signIn('Bounced farmer');
	const email = farmer.user.email;
	expect(await simulateBounce(email)).toContain('alert emails paused');

	const p = farmer.page;
	await p.setViewportSize(PHONE);
	await p.goto('/account/alerts');
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	const banner = p.locator('[data-mail-suppressed="bounce"]');
	await expect(banner.getByText(`Your alert emails are paused. Our emails to ${email} bounced back: the address may be wrong, or the mailbox full or closed.`)).toBeVisible();
	await expect(banner.getByText(`Once ${email} can receive email again, turn alert emails back on. Your choices are kept.`)).toBeVisible();
	await expectNoViolations(p);

	// The account page says the same, and turns them back on.
	await p.goto('/account');
	const onAccount = p.locator('[data-mail-suppressed="bounce"]');
	await expect(onAccount).toBeVisible();
	await expectNoViolations(p);
	await onAccount.getByRole('button', { name: 'Turn alert emails back on' }).click();
	await expect(p.getByRole('status').filter({ hasText: 'Alert emails are back on.' })).toBeVisible();
	await expect(p.locator('[data-mail-suppressed]')).toHaveCount(0);
	await p.goto('/account/alerts');
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	await expect(p.locator('[data-mail-suppressed]')).toHaveCount(0);
});

test('an editor sets a staleness level per data feed, starting from its source’s default', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Stale levels catchment');
	const res = await page.request.post(`${API_URL}/projects/${project.id}/feeds`, { data: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] } } });
	expect(res.status(), await res.text()).toBe(201);
	const feedId = ((await res.json()) as { feed: { id: string } }).feed.id;

	await page.goto(`/projects/${project.id}`);
	const panel = page.getByRole('region', { name: 'Active alerts' });
	await expect(panel).toHaveAttribute('data-ready', 'true');
	await panel.getByRole('button', { name: 'Set up alert emails' }).click();
	const feeds = panel.getByRole('group', { name: 'Data feeds behind' });
	await expect(feeds.getByText('Each feed has its own level: the days past that feed’s usual delay before it alerts.')).toBeVisible();
	const on = feeds.getByRole('checkbox', { name: 'CHIRPS daily rainfall' });
	const level = feeds.getByRole('spinbutton', { name: 'Alert after (days later than usual for this feed)' });
	await expect(on).not.toBeChecked();
	// CHIRPS's default level, off until switched on.
	await expect(level).toHaveValue('3');
	await expect(level).toBeDisabled();
	await expectNoViolations(page, { include: '.alerts' });

	await on.check();
	await level.fill('5');
	await panel.getByRole('button', { name: 'Save alert rules' }).click();
	await expect(panel.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	const saved = await page.request.get(`${API_URL}/projects/${project.id}/alert-rules`);
	const rule = ((await saved.json()).rules as { kind: string; feedId: string | null; threshold: number; enabled: boolean }[]).find((r) => r.kind === 'data_stale')!;
	expect(rule).toMatchObject({ feedId, threshold: 5, enabled: true });
});
