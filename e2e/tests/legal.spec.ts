// The legal pages (/privacy, /terms): prerendered static HTML like /welcome,
// open to anyone signed in or out, linked from the landing page's footer, the
// sign-in pages and the sign-up form (whose required checkbox accepts
// them). docs/ui.md § Legal pages.
import { expectNoViolations } from '../support/a11y.ts';
import { LEGAL_VERSION } from '../support/api.ts';
import { legalEffective } from '../../packages/engine/src/legal.ts';
import { ENGINE_VERSION } from '../../packages/engine/src/version.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { expect, test } from '../support/fixtures.ts';

const PAGES = [
	{ path: '/privacy', title: 'Privacy notice', must: ['Jared Howard', 'jared@jaredhoward.com', 'Information Regulator', 'POPIAComplaints@inforegulator.org.za', 'af-south-1', 'POPIA section 21', 'It is never put in someone', 'a sign-off’s typed name and'] },
	{ path: '/terms', title: 'Terms of use', must: ['Jared Howard', 'jared@jaredhoward.com', 'Model results are estimates', 'The short version', 'the law of the Republic of South Africa', 'Commonwealth of Virginia'] }
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

// WCAG 2.4.2 Page Titled (issue #51): each prerendered page names itself, in
// its HTML and in the browser. The document's title is the first <title>, and
// the legal and methods pages run no script to correct it, so app.html's
// fallback must come after the page's own.
const TITLED = [
	{ path: '/privacy', title: 'Privacy notice · Water Management' },
	{ path: '/terms', title: 'Terms of use · Water Management' },
	{ path: '/methods', title: 'How the model is checked · Water Management' },
	{ path: '/data-sources', title: 'Data sources and credits · Water Management' },
	{ path: '/welcome', title: 'Water Management: daily water balance for a catchment' }
];
test('every prerendered page names itself, before and without any script', async ({ request, page }) => {
	for (const p of TITLED) {
		const html = await (await request.get(p.path)).text();
		expect(/<title>([^<]*)<\/title>/.exec(html)?.[1], p.path).toBe(p.title);
		await page.goto(p.path);
		await expect(page).toHaveTitle(p.title);
	}
});

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

test('the contents list shows on a desktop and folds on a phone', async ({ page }) => {
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
});

// Issue #162: the Help shell's layout. Wide, the contents are a column on the
// left that stays in view, the text beside it at a reading measure, and the
// footer's links start where the text does; on a phone the contents sit above
// the text and the footer still lines up with it.
test('the legal pages use the Help layout: contents on the left in view, text at a reading width, footer in line', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/terms');
	const toc = page.getByRole('navigation', { name: 'Contents' });
	const h1 = page.getByRole('heading', { level: 1, name: 'Terms of use' });
	const footLink = page.getByRole('contentinfo').getByRole('link').first();
	const tocBox = (await toc.boundingBox())!;
	const h1Box = (await h1.boundingBox())!;
	expect(tocBox.x + tocBox.width).toBeLessThan(h1Box.x);
	expect(tocBox.y).toBeLessThanOrEqual(h1Box.y + h1Box.height);
	// The Help shell's 1480 px frame, not the old ~830 px column.
	const para = page.locator('main p').filter({ hasText: 'The rest of this page is the full text' });
	const paraBox = (await para.boundingBox())!;
	expect(paraBox.width).toBeLessThanOrEqual(760);
	expect(Math.abs((await footLink.boundingBox())!.x - h1Box.x)).toBeLessThanOrEqual(1);
	// In view while reading: far down the page the contents are still on screen.
	await page.getByRole('heading', { level: 2, name: '17. General' }).scrollIntoViewIfNeeded();
	await expect(toc.getByRole('link', { name: '19. Contact' })).toBeInViewport();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/terms');
	const phoneToc = (await toc.boundingBox())!;
	const phoneH1 = (await h1.boundingBox())!;
	expect(phoneToc.y).toBeGreaterThan(phoneH1.y);
	expect(Math.abs(phoneToc.x - phoneH1.x)).toBeLessThanOrEqual(1);
	expect(Math.abs((await footLink.boundingBox())!.x - phoneH1.x)).toBeLessThanOrEqual(1);
	await expectNoSidewaysScroll(page);
});

// Issue #162: the logo is the one way home (no "Open the app" beside it), and
// the footer's Contact goes to the terms' contact section, where the address
// is written once, rather than being a second mailto.
test('the header has only the logo, and the footer’s Contact opens the terms’ contact section', async ({ page }) => {
	await page.goto('/privacy');
	const banner = page.getByRole('banner');
	await expect(banner.getByRole('link')).toHaveCount(1);
	const home = banner.getByRole('link', { name: 'Water Management, home' });
	expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	const contact = page.getByRole('contentinfo').getByRole('link', { name: 'Contact' });
	await expect(contact).toHaveAttribute('href', /\/terms#contact$/);
	await expect(page.locator('footer a[href^="mailto:"]')).toHaveCount(0);
	await contact.click();
	await expect(page).toHaveURL('/terms#contact');
	await expect(page.getByRole('heading', { level: 2, name: '19. Contact' })).toBeInViewport();
	await expect(page.locator('#contact').locator('xpath=following-sibling::p[1]')).toContainText('jared@jaredhoward.com');
	await home.click();
	await expect(page).toHaveURL('/');
});

test('the landing footer, the sign-in pages and the sign-up form link both pages', async ({ page }) => {
	await page.goto('/');
	const footer = page.getByRole('contentinfo');
	await expect(footer.getByRole('link', { name: 'Data sources' })).toHaveAttribute('href', '/data-sources');
	await footer.getByRole('link', { name: 'Privacy notice' }).click();
	await expect(page).toHaveURL('/privacy');
	await page.getByRole('link', { name: 'Water Management, home' }).click();
	await expect(page).toHaveURL('/');

	await page.goto('/login');
	await expect(page.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/terms');

	await page.goto('/register');
	// The main points first, then a required box, unticked, then the button:
	// read before the click that accepts them.
	const summary = page.getByRole('region', { name: 'The main things you agree to' });
	await expect(summary.getByRole('listitem')).toHaveCount(4);
	await expect(summary).toContainText('our total liability to you is limited to the fees you paid in the last 12 months or US $100');
	await expect(summary).not.toContainText('this summary is in your language');
	const box = page.getByRole('checkbox', { name: 'I have read the main points above and accept the Terms of use and Privacy notice.' });
	await expect(box).not.toBeChecked();
	await expect(box).toHaveAttribute('required', '');
	const agree = page.locator('label[for="agree"]');
	const summaryBox = (await summary.boundingBox())!;
	const agreeBox = (await agree.boundingBox())!;
	const button = (await page.getByRole('button', { name: 'Create account' }).boundingBox())!;
	expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(agreeBox.y);
	expect(agreeBox.y + agreeBox.height).toBeLessThanOrEqual(button.y);
	await expect(agree.getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/terms');
	await expect(agree.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/privacy');
	await expect(page.getByRole('navigation', { name: 'Legal' })).toHaveCount(0);
});

// The methods page (/methods): the engine audit's public summary, in the same
// frame, backing the landing page's first trust statement (issue #57).
test('/methods is prerendered HTML with the engine version, the known limitations and the full audit', async ({ request }) => {
	const res = await request.get('/methods');
	expect(res.status()).toBe(200);
	const html = await res.text();
	expect(html).toMatch(/<h1[^>]*>How the model is checked<\/h1>/);
	expect(html).toContain(`Engine version ${ENGINE_VERSION}`);
	// The known limitations are the list every report prints, generated from
	// docs/engine-audit.md (B3 is open there; limitations.test.ts pins it).
	expect(html).toContain('6. Known limitations');
	expect(html).toMatch(/<td data-label="Item"[^>]*>B3<\/td>/);
	expect(html).toContain('https://github.com/Absence0760/project-water-management/blob/main/docs/engine-audit.md');
});

test('the trust strip links the methods page, which passes an a11y scan light and dark, on a desktop and a phone', async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto('/');
	await page.getByRole('region', { name: 'Why trust it' }).getByRole('link', { name: 'How the model is checked' }).click();
	await expect(page).toHaveURL('/methods');
	await expect(page.getByRole('heading', { level: 1, name: 'How the model is checked' })).toBeVisible();
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(size);
			await page.goto('/methods');
			await expect(page.getByRole('heading', { level: 1, name: 'How the model is checked' })).toBeVisible();
			await expectNoViolations(page);
			await expectNoSidewaysScroll(page);
		}
	}
	await page.getByRole('contentinfo').getByRole('link', { name: 'Home' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('contentinfo').getByRole('link', { name: 'How the model is checked' })).toHaveAttribute('href', '/methods');
});

// The data sources page (/data-sources): the credit each third-party
// dataset's licence asks for (lib/components/legal/dataCredits.ts; docs/maps.md
// § Sources), the legal notice HydroRIVERS and the Copernicus DEM need before
// production serves them. Linked from the legal pages' footer and Terms §9.
test('/data-sources is prerendered HTML with each licence’s credit, reached from the terms, and passes an a11y scan', async ({ request, page }) => {
	test.setTimeout(60_000);
	const res = await request.get('/data-sources');
	expect(res.status()).toBe(200);
	const html = await res.text();
	expect(html).toMatch(/<h1[^>]*>Data sources and credits<\/h1>/);
	for (const text of [
		'This product [Water Management] incorporates data from the HydroSHEDS version 1 database which is © World Wildlife Fund, Inc. (2006-2022)',
		'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30',
		'© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
		'© Protomaps © OpenStreetMap contributors',
		'Source: EC JRC/Google',
		'hPET/dPET © Singer et al. 2021, University of Bristol, CC BY 4.0.'
	])
		expect(html, text).toContain(text);
	await page.goto('/terms');
	// §9 binds users to the end-user terms licensed map data needs (HydroRIVERS: no stand-alone copy, no reverse engineering).
	await expect(page.locator('#third-party ~ p').filter({ hasText: 'Map data licensed to us.' })).toContainText(
		'you may not decompile, reverse engineer or disassemble it'
	);
	await expect(page.locator('#third-party ~ p').filter({ hasText: 'Map data licensed to us.' }).getByRole('link', { name: 'data sources' })).toHaveAttribute('href', /^(\.)?\/data-sources$/);
	await page.locator('#third-party + p').getByRole('link', { name: 'data sources' }).click();
	await expect(page).toHaveURL('/data-sources');
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(size);
			await page.goto('/data-sources#hydrorivers');
			await expect(page.getByRole('heading', { level: 2, name: '3. HydroRIVERS v1.0' })).toBeVisible();
			await expectNoViolations(page);
			await expectNoSidewaysScroll(page);
		}
	}
	// The prerendered pages' links are relative (`base` is relative while prerendering).
	await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Data sources' })).toHaveAttribute('href', /^(\.)?\/data-sources$/);
});
