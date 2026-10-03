// Delineating in the background (191_delineation_request; docs/design/
// delineation.md § Where it runs, docs/ui.md § Map): a catchment too large for
// the request goes to the worker's `delineate` job, and the sheet waits for
// it. The synthetic DEM's valley fits the request, so the editor sends it
// with the "work it out in the background" tick, the path a catchment over
// about 100 km takes by itself. The sheet says it is queued (and still does
// after a reload), the worker's tick runs the job (support/jobs.ts, no
// sleeps: the sheet asks every 2 s), and the proposal is reviewed and
// accepted as any other. Axe-scanned while it waits.
import type { Page } from '@playwright/test';
import { expectNoViolations } from '../support/a11y.ts';
import { seedRunnableProject } from '../support/api.ts';
import { FIXTURE_OUTLET } from '../support/dem.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';
import { openMap } from '../support/map.ts';

const sheet = (page: Page, name = 'Delineate a catchment') => page.getByRole('dialog', { name });

test('a catchment sent to the background: the sheet waits for the worker, then the proposal is decided as usual', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Delineate in the background');
	await openMap(page, project.id);
	await page.getByTestId('map-tools').getByRole('button', { name: 'Delineate', exact: true }).click();
	await page.getByTestId('map-enter-coordinates').click();
	const s = sheet(page);
	await expect(s).toBeVisible();
	await s.getByRole('radio', { name: 'The catchment’s outlet' }).check();
	await s.getByLabel('Latitude').fill(String(FIXTURE_OUTLET[1]));
	await s.getByLabel('Longitude').fill(String(FIXTURE_OUTLET[0]));
	await s.getByTestId('delineate-background').check();
	await s.getByTestId('delineate-submit').click();

	const waiting = s.getByTestId('delineate-waiting');
	await expect(waiting).toHaveAttribute('data-status', 'queued');
	await expect(waiting).toContainText('queued for the background');
	await expectNoViolations(page);
	// A reload picks the waiting delineation up from the state.
	await page.reload();
	await expect(sheet(page).getByTestId('delineate-waiting')).toHaveAttribute('data-status', 'queued');

	// The worker runs it; the sheet's next ask finds the proposal.
	await runJobsTick({ projects: [project.id], schedule: false });
	const r = sheet(page, 'The delineated catchment');
	await expect(r).toBeVisible();
	// The synthetic valley is about 547 km² (backend/src/delineation/fixture.ts), as from the request.
	await expect(r.getByTestId('delineate-fact-area')).toHaveText(/^5[34]\d\.\d\d km²$/);
	await expect(page.getByTestId('delineate-waiting')).toHaveCount(0);

	await r.getByTestId('delineate-accept-area').click();
	await expect(page.getByTestId('map-notice')).toContainText('Saved Catchment above the outlet (delineated), 5');
	await expect(page.getByRole('dialog')).toHaveCount(0);
});
