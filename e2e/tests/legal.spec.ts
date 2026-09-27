// The legal pages (/privacy, /terms): prerendered static HTML like /welcome,
// open to anyone signed in or out, linked from the landing page's footer, the
// sign-in pages and the sign-up form (which says that signing up accepts
// them). docs/ui.md § Legal pages.
import { expectNoViolations } from '../support/a11y.ts';
import { LEGAL_VERSION } from '../support/api.ts';
import { legalEffective } from '../../packages/engine/src/legal.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const PAGES = [
	{ path: '/privacy', title: 'Privacy notice', must: ['Jared Howard', 'jared@jaredhoward.com', 'Information Regulator', 'POPIAComplaints@inforegulator.org.za', 'af-south-1'] },
	{ path: '/terms', title: 'Terms of use', must: ['Jared Howard', 'jared@jaredhoward.com', 'Model results are estimates', 'Commonwealth of Virginia'] }
];

for (const p of PAGES) {
	test(`${p.path} is prerendered HTML naming who runs the service and how to reach them`, async ({ request }) => {
		const res = await request.get(p.path);
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html).toMatch(new RegExp(`<h1[^>]*>${p.title}</h1>`));
		for (const text of p.must) expect(html, text).toContain(text);
		// The effective line is the version the sign-up form sends (engine LEGAL_VERSION).
		expect(html).toContain(legalEffective(LEGAL_VERSION));
	});
}

test('the legal pages open signed out and signed in, and pass an a11y scan on a desktop and a phone', async ({ page, signIn }) => {
	test.setTimeout(60_000);
	for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(size);
		for (const p of PAGES) {
			await page.goto(p.path);
			await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
			await expect(page).toHaveURL(p.path);
			await expectNoViolations(page);
			await expectNoSidewaysScroll(page);
		}
	}
	const member = await signIn('Legal reader');
	await member.page.goto('/terms');
	await expect(member.page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
	await expect(member.page).toHaveURL('/terms');
});

test('the legal pages pass an a11y scan in the dark theme, on a desktop and a phone', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(size);
		for (const p of PAGES) {
			await page.goto(p.path);
			await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
			await expectNoViolations(page);
		}
	}
});

test('the contents list shows on a desktop and folds on a phone, and the header opens the app', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/privacy');
	const toc = page.getByRole('navigation', { name: 'Contents' });
	await expect(toc.getByRole('link', { name: '1. Who we are' })).toBeVisible();
	await expect(toc.getByText(/^Contents/)).toBeHidden();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/privacy');
	const fold = toc.getByText(/^Contents/);
	await expect(fold).toBeVisible();
	await expect(toc.getByRole('link', { name: '1. Who we are' })).toBeHidden();
	// Folded, the privacy notice's own words start on the first screen.
	await expect(page.getByText('This notice explains what personal information')).toBeInViewport();
	await fold.click();
	await toc.getByRole('link', { name: '10. Your rights' }).click();
	await expect(page).toHaveURL('/privacy#rights');

	// The page can't know the session: its header button opens the app (sign-in, or on to the projects when signed in).
	const open = page.getByRole('banner').getByRole('link', { name: 'Open the app' });
	expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await open.click();
	await expect(page).toHaveURL('/login');
});

test('the landing footer, the sign-in pages and the sign-up form link both pages', async ({ page }) => {
	await page.goto('/');
	const footer = page.getByRole('contentinfo');
	await footer.getByRole('link', { name: 'Privacy notice' }).click();
	await expect(page).toHaveURL('/privacy');
	await page.getByRole('link', { name: 'Water Management, home' }).click();
	await expect(page).toHaveURL('/');

	await page.goto('/login');
	await expect(page.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/terms');

	await page.goto('/register');
	const agree = page.getByText('By creating an account, you agree to the');
	await expect(agree).toHaveText('By creating an account, you agree to the Terms of use and Privacy notice.');
	// Above the button that makes the account, so it is read before the click that accepts it.
	const agreeBox = (await agree.boundingBox())!;
	const button = (await page.getByRole('button', { name: 'Create account' }).boundingBox())!;
	expect(agreeBox.y + agreeBox.height).toBeLessThanOrEqual(button.y);
	await expect(agree.getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/terms');
	await expect(agree.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/privacy');
	await expect(page.getByRole('navigation', { name: 'Legal' })).toHaveCount(0);
});
