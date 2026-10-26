// The shared loading / error state (common/LoadState.svelte) keeps the focus
// through a Try again (issue #586 R4-D, WCAG 2.4.3). Try again takes itself
// out of the page (the loading line replaces the error), and the focus fell
// to <body>: the next Tab started again from the top of the page, and a
// screen reader heard nothing of the retry. Now the focus goes to the loading
// line while it loads, to the new Try again when it fails again, and to the
// panel's heading once it has loaded. Shown on Project's API keys panel, one
// of the LoadState panels on the pages #586 reworked.
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('Try again keeps the focus: on the loading line, on the new Try again, then on the panel heading', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Retry focus');
	// The keys list fails while `down`; `held` keeps one answer back until the test lets it go.
	let down = true;
	let release: () => void = () => {};
	let held: Promise<void> | null = null;
	await page.route(new RegExp(`/projects/${project.id}/api-keys$`), async (r) => {
		if (r.request().method() !== 'GET') return r.fallback();
		if (held) await held;
		return down ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server unavailable"}' }) : r.fallback();
	});
	await page.goto(`/projects/${project.id}?tab=project`);
	const panel = page.getByRole('region', { name: 'API keys' });
	const retry = panel.getByRole('button', { name: 'Try again' });
	await expect(panel.getByRole('alert')).toContainText('Server unavailable');

	// Pressed from the keyboard while the answer is held back: the loading line has the focus, not <body>.
	held = new Promise((resolve) => (release = resolve));
	await retry.focus();
	await page.keyboard.press('Enter');
	await expect(panel.getByRole('status').filter({ hasText: 'Loading…' })).toBeFocused();
	// Still failing: the new Try again has it, so Enter tries once more.
	held = null;
	release();
	await expect(panel.getByRole('alert')).toContainText('Server unavailable');
	await expect(retry).toBeFocused();

	// Back up: the list loads and the panel's heading has the focus, so Tab goes on from the panel.
	down = false;
	await page.keyboard.press('Enter');
	await expect(panel.getByText('No API keys yet.')).toBeVisible();
	await expect(panel.getByRole('heading', { level: 2, name: /^API keys/ })).toBeFocused();
	await expect(page.locator('body')).not.toBeFocused();
});
