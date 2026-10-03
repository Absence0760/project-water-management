// A viewer dropping a CSV on the workspace (routes/projects/[id]/+page.svelte):
// the page takes the drop, so the browser doesn't open the file in place of the
// app, and says why nothing happens. Synthetic data only.
import { addMember, createProject, putModel, sampleModel } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

test('a viewer’s dropped file is refused with "View only", and the page stays', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Viewer drop');
	await putModel(page.request, project.id, sampleModel());
	const viewer = await signIn('Viewer drop viewer');
	await addMember(page.request, project.id, viewer.user.email, 'viewer');
	const v = viewer.page;
	await v.goto(`/projects/${project.id}?tab=series`);
	await expect(v.getByRole('heading', { level: 1, name: 'Data' })).toBeVisible();
	const prevented = await v.evaluate(() => {
		const data = new DataTransfer();
		data.items.add(new File(['date,rain\n2024-01-01,3\n'], 'rain.csv', { type: 'text/csv' }));
		const main = document.querySelector('main.page')!;
		const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
		main.dispatchEvent(over);
		const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
		main.dispatchEvent(drop);
		return [over.defaultPrevented, drop.defaultPrevented];
	});
	expect(prevented).toEqual([true, true]);
	await expect(v.getByTestId('notice-line')).toContainText('View only: ask an editor to add data.');
	await expect(v.getByRole('dialog', { name: /Add data/ })).toHaveCount(0);
});
