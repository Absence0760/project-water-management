// Alert emails (WP-2.13, docs/ui.md § Alerts): a farmer chooses how often
// they get their farm's dam alerts on /account/alerts (saved as they choose,
// kept on reload); an alert email's unsubscribe link works signed out, asks
// before it acts, says what it turned off and takes the token out of the
// address bar; a replaced or tampered link says it no longer works. Both
// pages pass axe, on a phone. The alert emails page's layout (issue #17) is
// pinned at 1440 × 960 and on a phone, with an owner's four catchments and a
// farmer's thirty farms. A bounced address (SES, stood in for by
// `pnpm dev:mail:bounce`) pauses a person's alert emails behind a banner on
// the account and alert pages, which turns them back on. An editor sets a
// staleness level per data feed on Overview's rule editor.
import { expectNoViolations } from '../support/a11y.ts';
import { acceptInvites, addMember, createProject, putModel, seedRunnableProject, type Model } from '../support/api.ts';
import { words } from '../support/lang.ts';
import { plantAlertSubscription } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { simulateBounce } from '../support/jobs.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';

const PHONE = { width: 360, height: 740 };
const af = await words('af');

test('a farmer chooses how often they get their dam alerts, and the choice is kept', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Alerting catchment');
	const farm = project.model.nodes.find((n) => n.name === 'Lower farm')!;
	const farmer = await signIn('Alert farmer');
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farm.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);
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
	// An alert the WUA hasn't switched on is starred, and the card's footnote
	// says what the star means (read out as the row's description).
	const off = 'Not switched on for this catchment yet: you get nothing until the WUA turns it on.';
	await expect(notice).toHaveAccessibleDescription(off);
	await expect(notice.locator('legend')).toHaveText('Restriction notices from the WUA*');
	await expect(dam).not.toHaveAccessibleDescription(off);
	await expect(dam.locator('legend')).toHaveText('Dam running low: Lower farm');
	// The level it warns below, the WUA's 30 % (issue #51), read out as the row's description.
	await expect(dam).toHaveAccessibleDescription(/^Warns when the model puts your dam below 30\s%\. Your WUA sets this level\.$/);
	await expect(notice.getByText(/Warns when/)).toHaveCount(0);
	await expect(section.getByText(off)).toBeVisible();
	await expectNoViolations(p);

	await dam.getByRole('radio', { name: 'Once a day (06:00)' }).check();
	await expect(section.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
	// The switch is a radio group underneath: the arrow keys move the choice, and it saves.
	await dam.getByRole('radio', { name: 'Once a day (06:00)' }).focus();
	await p.keyboard.press('ArrowRight');
	await expect(dam.getByRole('radio', { name: 'Off' })).toBeChecked();
	await expect(dam.getByRole('radio', { name: 'Off' })).toBeFocused();
	const saved = async () => {
		const mine = await p.request.get(`${API_URL}/me/alerts`);
		const entry = ((await mine.json()).projects as { id: string; choices: { kind: string; mode: string }[] }[]).find((x) => x.id === project.id)!;
		return entry.choices.find((c) => c.kind === 'dam_below')!.mode;
	};
	await expect.poll(saved).toBe('off');
	await dam.getByRole('radio', { name: 'Once a day (06:00)' }).check();
	await expect.poll(saved).toBe('daily_digest');
	await p.reload();
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	await expect(p.getByRole('region', { name: 'Alerting catchment' }).getByRole('group', { name: 'Dam running low: Lower farm' }).getByRole('radio', { name: 'Once a day (06:00)' })).toBeChecked();
});

// A farmer-only user has no workspace: their account pages sit in the farmer
// view's frame (FarmShell), translated, with the way back to their farms,
// not in the workspace's English sidebar. Once they are also a member of a
// catchment, the workspace frame comes back.
test('a farmer-only user’s account pages sit in the farm frame, in their language', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Farm frame catchment');
	const farm = project.model.nodes.find((n) => n.name === 'Lower farm')!;
	const farmer = await signIn('Frame farmer');
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [farm.id] } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	const p = farmer.page;
	for (const viewport of [PHONE, { width: 1440, height: 960 }]) {
		await p.setViewportSize(viewport);
		await p.goto('/account/alerts');
		await expect(p.locator('main[data-ready="true"]')).toBeVisible();
		await expect(p.locator('.farm-header')).toBeVisible();
		await expect(p.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
		await expect(p.getByRole('link', { name: 'Projects' })).toHaveCount(0);
		await expect(p.locator('.farm-header').getByRole('link', { name: 'Your hydrological units' })).toHaveAttribute('href', /\/farm$/);
		await expect(p.getByRole('main')).toHaveCount(1);
		await expect(p.locator('.farm-header').getByRole('group', { name: 'Language' })).toBeVisible();
		await expectNoSidewaysScroll(p);
		for (const colorScheme of ['light', 'dark'] as const) {
			await p.emulateMedia({ colorScheme });
			await expectNoViolations(p);
		}
		await p.emulateMedia({ colorScheme: 'light' });
	}

	// The farm menu reaches the account page, in the same frame.
	await p.setViewportSize(PHONE);
	await p.getByRole('button', { name: 'Menu' }).click();
	// …and the privacy notice (issue #48: linked from the farm view too).
	await expect(p.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/privacy');
	await p.getByRole('link', { name: 'Account', exact: true }).click();
	await expect(p).toHaveURL(/\/account$/);
	await expect(p.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
	await expect(p.locator('.farm-header')).toBeVisible();
	await expect(p.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
	await expectNoViolations(p);

	// The farm pages' 16 px base and card styles stay off the account page.
	expect(await p.getByText('Changing your password signs you out').evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
	// One language switch on the account page: its own, not the header's too.
	await expect(p.getByRole('group', { name: 'Language' })).toHaveCount(1);
	await expect(p.locator('.farm-header').getByRole('group', { name: 'Language' })).toHaveCount(0);
	// Afrikaans: the frame's words turn with the page's.
	// (<html lang="af"> in this frame is af-layout.spec.ts's check, on the seeded farmer.)
	await p.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Afrikaans' }).click();
	await expect(p.locator('.farm-header').getByRole('link', { name: af('Your hydrological units') })).toBeVisible();
	await expect(p.getByRole('heading', { level: 1, name: af('Account') })).toBeVisible();
	await p.getByRole('group', { name: af('Language') }).getByRole('button', { name: 'English' }).click();

	// A member of a catchment as well: the workspace frame.
	const other = await createProject(page.request, 'Frame viewer catchment');
	await addMember(page.request, other.id, farmer.user.email, 'viewer');
	await p.reload();
	await expect(p.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
	await expect(p.locator('.farm-header')).toHaveCount(0);
	await expect(p.getByRole('button', { name: 'Account menu for Frame farmer' })).toBeVisible();
});

// Screen use (issue #17): the section header is the page's one title; one
// card per catchment, side by side on a wide screen, stacked on a phone,
// never a sideways scroll; each alert one row, its name beside the switch.
// Four catchments of an owner's six alerts each fit 1440 × 960 unscrolled.
test('the alert emails page lays its catchments out as cards across the width', async ({ page, owner }) => {
	void owner;
	for (const name of ['Cards catchment A', 'Cards catchment B', 'Cards catchment C', 'Cards catchment D']) await seedRunnableProject(page.request, name);
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/account/alerts');
	await expect(page.locator('main[data-ready="true"]')).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(page.getByTestId('section-header').getByRole('heading', { level: 1, name: 'Alert emails' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Back to your account' })).toHaveAttribute('href', /\/account$/);
	const a = (await page.getByRole('region', { name: 'Cards catchment A' }).boundingBox())!;
	const b = (await page.getByRole('region', { name: 'Cards catchment B' }).boundingBox())!;
	expect(Math.abs(a.y - b.y)).toBeLessThan(1);
	expect(Math.abs(a.x - b.x)).toBeGreaterThan(a.width - 1);
	// A row: the alert's name and its switch side by side, one 32 px control tall.
	const row = page.getByRole('region', { name: 'Cards catchment A' }).getByRole('group', { name: 'Dam running low' });
	const legend = (await row.locator('legend').boundingBox())!;
	const right = (await row.getByRole('radio', { name: 'Right away' }).boundingBox())!;
	expect(Math.abs(legend.y + legend.height / 2 - (right.y + right.height / 2))).toBeLessThan(4);
	expect(right.x).toBeGreaterThan(legend.x + legend.width);
	expect(right.height).toBeGreaterThanOrEqual(32);
	// Every card inside the window: no page scroll.
	const d = (await page.getByRole('region', { name: 'Cards catchment D' }).boundingBox())!;
	expect(d.y + d.height).toBeLessThanOrEqual(960);
	expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });
		await expectNoViolations(page);
	}
	await page.emulateMedia({ colorScheme: 'light' });

	await page.setViewportSize(PHONE);
	const a2 = (await page.getByRole('region', { name: 'Cards catchment A' }).boundingBox())!;
	const b2 = (await page.getByRole('region', { name: 'Cards catchment B' }).boundingBox())!;
	expect(Math.abs(a2.x - b2.x)).toBeLessThan(1);
	expect(Math.abs(a2.y - b2.y)).toBeGreaterThan(Math.min(a2.height, b2.height) - 1);
	// On a phone the switch sits under the name, full width, 44 px tall.
	const legend2 = (await row.locator('legend').boundingBox())!;
	const right2 = (await row.getByRole('radio', { name: 'Right away' }).boundingBox())!;
	expect(right2.y).toBeGreaterThanOrEqual(legend2.y + legend2.height - 1);
	expect(right2.height).toBeGreaterThanOrEqual(44);
	await expectNoSidewaysScroll(page);
	await expectNoViolations(page);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expectNoViolations(page);
});

// The big case: a farmer with thirty farms in one catchment. The lone card
// takes the whole width and lays its thirty rows out in two columns, so the
// page is a short read rather than thirty stacked groups; on a phone it stacks.
test('thirty farms’ dam alerts read as two columns of rows in one wide card', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Thirty-farm catchment');
	const gauge = project.model.nodes.find((n) => n.kind === 'gauge')!;
	const lower = project.model.nodes.find((n) => n.name === 'Lower farm')!;
	const extra = Array.from({ length: 28 }, (_, i) => ({ ...lower, id: crypto.randomUUID(), name: `Farm number ${i + 3} on the long river road`, downstreamNodeId: gauge.id, sortOrder: 4 + i }));
	const model: Model = { ...project.model, nodes: [...project.model.nodes, ...extra] };
	await putModel(page.request, project.id, model);
	const farmer = await signIn('Thirty-farm farmer');
	const farms = model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
	const add = await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: farms } });
	expect(add.status(), await add.text()).toBe(201);
	await acceptInvites(farmer.user.email, project.id);

	const p = farmer.page;
	await p.setViewportSize({ width: 1440, height: 960 });
	await p.goto('/account/alerts');
	await expect(p.locator('main[data-ready="true"]')).toBeVisible();
	const card = p.getByRole('region', { name: 'Thirty-farm catchment' });
	// Thirty farms and the WUA's notices.
	await expect(card.getByRole('group')).toHaveCount(31);
	const main = (await p.locator('main').boundingBox())!;
	const box = (await card.boundingBox())!;
	expect(box.width).toBeGreaterThan(main.width * 0.9);
	const first = (await card.getByRole('group').nth(0).boundingBox())!;
	const second = (await card.getByRole('group').nth(1).boundingBox())!;
	expect(Math.abs(first.y - second.y)).toBeLessThan(1);
	expect(second.x).toBeGreaterThan(first.x + first.width);
	// Two columns of rows: well under two screens at 1440 × 960 (it was about three).
	expect(await p.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(1400);
	await expectNoViolations(p);

	await p.setViewportSize(PHONE);
	const first2 = (await card.getByRole('group').nth(0).boundingBox())!;
	const second2 = (await card.getByRole('group').nth(1).boundingBox())!;
	expect(second2.y).toBeGreaterThan(first2.y + first2.height - 1);
	await expectNoSidewaysScroll(p);
	await expectNoViolations(p);
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
		// One Manage alerts: the answer's button (the footer doesn't repeat it), and focus on the page title.
		await expect(p.getByRole('link', { name: 'Manage alerts' })).toHaveCount(1);
		await expect(p.getByRole('heading', { level: 1 })).toBeFocused();
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
