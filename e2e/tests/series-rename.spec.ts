import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject, putSeries } from '../support/api.ts';
import { answerConfirm, confirmBox } from '../support/confirm.ts';
import { expect, test } from '../support/fixtures.ts';

// Issue #556: an editor renames a series in Data → Series details, saved on
// change. A rename that changes which series runs read (the first of each kind
// by name) says so and asks first. Synthetic series only.

test('an editor renames a series in Series details; a rename that changes what runs read asks first', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Series rename');
	const days = { startDate: '2021-10-01', values: [1, 2, 3, 4, 5] };
	await putSeries(page.request, project.id, { kind: 'flow_logger_m3s', name: 'Logger Q7 (Curr. Day)', unit: 'm³/s', ...days });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Average', unit: 'mm', ...days });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', name: 'Bergwater gauge', unit: 'mm', ...days });
	await page.goto(`/projects/${project.id}?tab=series`);

	const table = page.getByRole('region', { name: 'Input time series' });
	const details = page.getByRole('group', { name: 'Series details' });
	const nameBox = details.getByRole('textbox', { name: 'Name' });

	// The only logger: the new name changes nothing about what runs read, so it saves at once.
	await table.getByRole('row').filter({ hasText: 'Logger Q7 (Curr. Day)' }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(nameBox).toHaveValue('Logger Q7 (Curr. Day)');
	await nameBox.fill('Drift Logger');
	await nameBox.press('Enter');
	await expect(nameBox).toHaveAccessibleDescription('Saved');
	await expect(confirmBox(page)).toHaveCount(0);
	await expect(table.getByRole('row').filter({ hasText: 'Drift Logger' })).toHaveCount(1);

	// Runs read "Average" (first by name); renaming it behind "Bergwater gauge" would switch them, so it asks.
	await table.getByRole('row').filter({ hasText: 'Average' }).getByRole('button', { name: 'View', exact: true }).click();
	await expect(nameBox).toHaveValue('Average');
	await nameBox.fill('Rain average');
	await nameBox.press('Enter');
	await expectNoViolations(page);
	await answerConfirm(page, false, 'Runs will read “Bergwater gauge” instead of “Average”');
	await expect(nameBox).toHaveValue('Average');
	await nameBox.fill('Rain average');
	await nameBox.press('Enter');
	await answerConfirm(page, true, 'Runs will read “Bergwater gauge” instead of “Average”');
	await expect(nameBox).toHaveAccessibleDescription('Saved');

	// A name another series of the kind has is refused (409), and the box goes back to the stored name.
	await nameBox.fill('Bergwater gauge');
	await nameBox.press('Enter');
	await expect(nameBox).toHaveAccessibleDescription(/Not saved: another series of this kind already has that name/);
	await expect(nameBox).toHaveValue('Rain average');
	// A series needs a name: a cleared box is put back, nothing sent.
	await nameBox.fill('');
	await nameBox.press('Enter');
	await expect(nameBox).toHaveAccessibleDescription('Not saved: a series needs a name');
	await expect(nameBox).toHaveValue('Rain average');

	await page.reload();
	await expect(page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Rain average' })).toHaveCount(1);
	await expect(page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Drift Logger' })).toHaveCount(1);
	await expectNoViolations(page);

	// A viewer reads the name as words, with no box to change it.
	const viewer = await signIn('Series rename viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	await viewer.page.goto(`/projects/${project.id}?tab=series`);
	await viewer.page.getByRole('region', { name: 'Input time series' }).getByRole('row').filter({ hasText: 'Drift Logger' }).getByRole('button', { name: 'View', exact: true }).click();
	const vDetails = viewer.page.getByRole('group', { name: 'Series details' });
	await expect(vDetails.getByTestId('series-name')).toHaveText('Drift Logger');
	await expect(vDetails.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
});
