// Rainfall stations and what Flow share splits (issue #553; docs/ui.md §
// Settings & calibration, § Data; docs/model.md §2.4h, §2.5). On the sample
// model and its catchment rain series (synthetic):
// - Settings → Flow generation's flow-share line follows the method:
//   Fragmentation, GR4J's one run's flow and the EWR; Per unit, only the EWR
//   and the land cover's low-flow threshold (issue #553 round 3).
// - Units without a station reads the gauge's MAP from the catchment rain station:
//   an older project's settings gaugeMapMm until the station has one, then
//   the station's. Its link opens the series in Series details, where an
//   editor sets the station's MAP, source and place (checked before Save),
//   and a viewer reads them.
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, seedRunnableProject, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { openSettings, saveSettings, showExplanations } from '../support/settings.ts';

test('Flow generation’s flow share says what it splits, by the method, and stays as a state line under Per unit', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Flow share hint');
	await openSettings(page, project.id);
	await showExplanations(page);
	const share = page.locator('#set-share');
	const hint = share.getByTestId('share-hint');
	await expect(hint).toHaveAttribute('data-unit-rain', 'off');
	await expect(hint).toHaveText(
		'GR4J runs once on the catchment rain; the flow share splits its flow and the EWR between units. To give each unit its own runoff, choose Per unit above.'
	);

	// Per unit (unsaved is enough: the line reads the form), it says the flow is no longer split.
	await share.getByRole('radio', { name: 'Per unit' }).check();
	await expect(hint).toHaveAttribute('data-unit-rain', 'on');
	await expect(hint).toHaveText('Each unit makes its own runoff; the flow share now splits only the EWR and the land cover’s low-flow threshold between units, not the flow.');
	await saveSettings(page);
	await page.reload();
	await expect(hint).toHaveAttribute('data-unit-rain', 'on');
	// A state line: it stays with the explanations off.
	await page.getByRole('checkbox', { name: 'Explain each setting under its field' }).uncheck();
	await expect(hint).toBeVisible();
	await expect(share.getByTestId('unit-rain-settings')).toBeVisible();
	await expectNoViolations(page, { include: '#set-share' });
});

test('the gauge’s MAP is the catchment rain station’s, set in Series details; an older project shows its own until then', async ({ page, owner, signIn }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Station MAP');
	// A project from before stations: the gauge MAP is in the settings, the station has none.
	await updateSettings(page.request, project.id, { unitRain: { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'the gauge’s synthetic record, 1991–2020' } });
	await openSettings(page, project.id);
	const group = page.getByTestId('unit-rain-settings');
	const readout = group.getByTestId('unit-rain-gauge-map-value');
	await expect(readout).toHaveAttribute('data-from', 'settings');
	await expect(readout).toContainText('640 mm (the gauge’s synthetic record, 1991–2020), kept from these settings');
	// No input: the MAP is edited on the station.
	await expect(group.getByRole('textbox', { name: /^Rain gauge’s MAP/ })).toHaveCount(0);
	await group.getByRole('link', { name: 'Set it in Series details' }).click();
	await expect(page).toHaveURL(/[?&]tab=series&series=[^&#]+#data-chart$/);

	const station = page.getByRole('group', { name: 'Rainfall station' });
	const save = station.getByRole('button', { name: 'Save the station' });
	await expect(save).toBeDisabled();
	await station.getByLabel(/^MAP/).fill('745');
	await station.getByLabel(/^MAP/).blur();
	// A MAP needs its source: the problem under the fields, Save blocked.
	await expect(station.getByTestId('station-error')).toHaveText(
		'Say where the station’s MAP comes from: the source is required (the record or study, and its years).'
	);
	await expect(station.getByLabel('Source of the MAP')).toHaveAttribute('aria-invalid', 'true');
	await expect(save).toBeDisabled();
	await station.getByLabel('Source of the MAP').fill('the station’s synthetic record, 1991–2020');
	// Half a place is refused too.
	await station.getByLabel(/^Latitude/).fill('-33.92');
	await station.getByLabel(/^Latitude/).blur();
	await expect(station.getByTestId('station-error')).toHaveText('A station’s coordinates need both a latitude and a longitude, or neither.');
	await expect(save).toBeDisabled();
	await station.getByLabel(/^Longitude/).fill('18.86');
	await station.getByLabel(/^Longitude/).blur();
	await expect(station.getByTestId('station-error')).toHaveCount(0);
	await expectNoViolations(page, { include: '[data-testid="series-station"]' });
	const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/series\/[^/]+$/.test(new URL(r.url()).pathname));
	await save.click();
	const res = await patched;
	expect(res.status()).toBe(200);
	expect(((await res.json()) as { station: unknown }).station).toEqual({
		mapMm: 745,
		mapSource: 'the station’s synthetic record, 1991–2020',
		lat: -33.92,
		lon: 18.86
	});
	await expect(station.getByTestId('station-saved')).toHaveText('Saved the station.');
	await expect(save).toBeDisabled();

	// Settings now reads the station's MAP, which wins over the settings'.
	await openSettings(page, project.id);
	await expect(readout).toHaveAttribute('data-from', 'station');
	await expect(readout).toContainText('745 mm (the station’s synthetic record, 1991–2020), the station MAP of');
	await expect(group.getByRole('link', { name: 'Change it in Series details' })).toBeVisible();

	// A viewer reads the station, with nothing to change.
	const viewer = await signIn('Station viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await openSettings(viewer.page, project.id);
	await viewer.page.getByTestId('unit-rain-settings').getByRole('link', { name: 'See it in Series details' }).click();
	const seen = viewer.page.getByRole('group', { name: 'Rainfall station' });
	await expect(seen.getByTestId('station-map')).toHaveText('745 mm (the station’s synthetic record, 1991–2020)');
	await expect(seen.getByTestId('station-place')).toHaveText('−33.9200, 18.8600');
	await expect(seen.getByRole('button', { name: 'Save the station' })).toHaveCount(0);
	await expect(seen.getByRole('textbox')).toHaveCount(0);
});
