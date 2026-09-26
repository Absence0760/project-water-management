// Alert emails (WP-2.13, docs/ui.md § Alerts): a farmer chooses how often
// they get their farm's dam alerts on /account/alerts (saved as they choose,
// kept on reload); an alert email's unsubscribe link works signed out, asks
// before it acts, says what it turned off and takes the token out of the
// address bar; a replaced or tampered link says it no longer works. Both
// pages pass axe, on a phone.
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { plantAlertSubscription } from '../support/db.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

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
