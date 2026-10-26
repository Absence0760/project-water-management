// The Calibration page's hand-built Try again buttons keep the focus (issue #586 R4-A, WCAG 2.4.3), as the shared
// LoadState does (586-a11y-load-state.spec.ts): each takes its alert out of the page, and the focus fell to <body>.
// Now it goes to the loading line while the retry loads, to the new Try again when it fails again, and to the heading
// of the part or panel round it once loaded. The runs list's Try again is aria-disabled while it loads, never
// disabled (a disabled button drops the focus too). Synthetic data only.
import type { Page, Route } from '@playwright/test';
import { createRun, seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test.use({ viewport: { width: 1440, height: 960 } });

/** A route that fails while `down`, and can hold its next answers back until `release()`. */
function flaky() {
	const s = { down: true, held: null as Promise<void> | null, release: () => {} };
	const hold = () => (s.held = new Promise<void>((resolve) => (s.release = resolve)));
	const handle = async (route: Route, body = '{"error":"Server unavailable"}') => {
		if (route.request().method() !== 'GET') return route.fallback();
		if (s.held) await s.held;
		return s.down ? route.fulfill({ status: 500, contentType: 'application/json', body }) : route.fallback();
	};
	return { s, hold, handle };
}

/** Enter on Try again: the loading line, then (still down) the new Try again, then (back up) `landed`. */
async function walk(page: Page, f: ReturnType<typeof flaky>, retry: () => ReturnType<Page['getByRole']>, loading: ReturnType<Page['getByRole']>, landed: ReturnType<Page['getByRole']>) {
	f.hold();
	await retry().focus();
	await page.keyboard.press('Enter');
	await expect(loading).toBeFocused();
	f.s.held = null;
	f.s.release();
	await expect(retry()).toBeFocused();
	f.s.down = false;
	await page.keyboard.press('Enter');
	await expect(landed).toBeFocused();
	await expect(page.locator('body')).not.toBeFocused();
}

test('the runs list: the loading line, the new Try again, then the part’s heading; aria-disabled while it loads', async ({ page, owner }) => {
	void owner;
	const p = await seedRunnableProject(page.request, 'Calibration list retry');
	await createRun(page.request, p.id, 'Baseline');
	const f = flaky();
	await page.route((url) => url.pathname.endsWith(`/projects/${p.id}/runs`), (r) => f.handle(r));
	await page.goto(`/projects/${p.id}?tab=calibration`);
	const part = page.locator('#cal-fit');
	const retry = () => part.getByRole('alert').getByRole('button', { name: 'Try again' });
	await expect(retry()).toBeVisible();
	await expect(retry()).not.toHaveAttribute('aria-disabled');
	await walk(page, f, retry, page.getByTestId('calibration-runs-loading'), part.getByRole('heading', { level: 2, name: 'How the shown run fits' }));
	await expect(page.getByTestId('calibration-results')).toBeVisible();
});

test('the shown run: the loading line, the new Try again, then the part’s heading', async ({ page, owner }) => {
	void owner;
	const p = await seedRunnableProject(page.request, 'Calibration run retry');
	const run = await createRun(page.request, p.id, 'Baseline');
	const f = flaky();
	await page.route((url) => url.pathname.endsWith(`/projects/${p.id}/runs/${run}`), (r) => f.handle(r));
	await page.goto(`/projects/${p.id}?tab=calibration`);
	const part = page.locator('#cal-fit');
	const retry = () => part.getByRole('alert').getByRole('button', { name: 'Try again' });
	await expect(retry()).toBeVisible();
	await walk(page, f, retry, page.getByTestId('calibration-run-loading'), part.getByRole('heading', { level: 2, name: 'How the shown run fits' }));
	await expect(page.getByTestId('calibration-results')).toHaveAttribute('data-run', run);
});

test('the calibration check’s series: the loading line, the new Try again, then the check’s heading', async ({ page, owner }) => {
	void owner;
	const p = await seedRunnableProject(page.request, 'Calibration check retry');
	await createRun(page.request, p.id, 'Baseline');
	const f = flaky();
	// Only the demand series, which the check alone asks for: the hydrograph above still loads.
	await page.route((url) => url.pathname.endsWith('/series') && url.searchParams.get('key') === 'demand', (r) => f.handle(r));
	await page.goto(`/projects/${p.id}?tab=calibration#res-calibration`);
	const check = page.getByTestId('calibration-check');
	const retry = () => check.getByRole('alert').getByRole('button', { name: 'Try again' });
	await expect(retry()).toBeVisible();
	await walk(page, f, retry, check.getByRole('status'), check.getByRole('heading', { name: 'Calibration check: flow against use, per gauge' }));
	await expect(check.getByRole('img', { name: /^Calibration check at the outflow gauge/ })).toBeVisible();
});
