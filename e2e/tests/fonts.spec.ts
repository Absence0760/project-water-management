import { expect, test } from '../support/fixtures.ts';

// Every machine lays text out in the same fonts. Body text is the self-hosted
// Inter (app.css, brand/build.py), a web font, so a Mac, a Fedora laptop and the
// Ubuntu runner draw it alike; before, it was system-ui (SF Pro, Noto Sans,
// DejaVu Sans), and layout checks passed on one and failed on another (issues
// #162, #258). Monospace is still the platform's, pinned in e2e to DejaVu Sans
// Mono (e2e/fonts/fonts.conf, playwright.config.ts; Linux only, since macOS
// Chromium doesn't read fontconfig). Chromium reports the font it drew with.
test('the browser draws body text in the self-hosted Inter and monospace in the pinned DejaVu', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
	const fontsOf = async (selector: string) => {
		const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
		expect(nodeId, selector).toBeGreaterThan(0);
		const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
		return fonts.map((f) => f.familyName);
	};
	// A label is body text: the web font, never a fallback (a missing file or a
	// broken @font-face would draw the system's face and pass on no machine).
	await page.evaluate(() => document.fonts.ready);
	expect(await fontsOf('label')).toEqual(['Inter Variable']);
	await page.evaluate(() => {
		const code = document.createElement('code');
		code.id = 'font-probe';
		code.textContent = 'x = 1';
		document.body.append(code);
	});
	expect(await fontsOf('#font-probe')).toEqual(['DejaVu Sans Mono']);
});
