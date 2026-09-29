// Per-project API keys and the ingest endpoint (WP-2.9, docs/ui.md § API
// keys): an owner makes a key under Settings, copies it once, and the push
// script (scripts/ingest/push-fixture.mjs, the local stand-in for a logger
// gateway) sends the synthetic logger CSV with it. The days appear on the Data
// tab, History shows the change by the key's name, and after a revoke the same
// push is refused. Editors see no API keys panel. Synthetic data only.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectNoViolations } from '../support/a11y.ts';
import { addMember, createProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../scripts/ingest/push-fixture.mjs', import.meta.url));

/** Run the push script with this key against the e2e API; resolves to its exit code and output. */
async function push(key: string): Promise<{ code: number; out: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--keep-dates'], {
			env: { PATH: process.env.PATH ?? '', WM_INGEST_KEY: key, WM_API_URL: API_URL },
			timeout: 20_000
		});
		return { code: 0, out: stdout + stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
	}
}

test('an owner makes a key, a gateway pushes days with it, History names the key, and a revoked key is refused', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Logger catchment');
	await page.goto(`/projects/${project.id}?tab=settings`);

	const panel = page.getByRole('region', { name: 'API keys' });
	await expect(panel.getByText('No API keys yet.')).toBeVisible();
	const form = panel.getByRole('form', { name: 'Make an API key' });
	await form.getByLabel('Name').fill('Weir gateway');
	await expect(form.getByLabel('Works for')).toHaveValue('0');
	await form.getByRole('button', { name: 'Make key' }).click();

	const secret = await panel.getByLabel('The new key').inputValue();
	expect(secret).toMatch(/^wm_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
	// The example uses a placeholder, never the key itself.
	const example = panel.getByLabel('Example request');
	await expect(example).toContainText('Bearer $WM_INGEST_KEY');
	await expect(example).not.toContainText(secret);
	const row = panel.getByRole('row', { name: /Weir gateway/ });
	await expect(row).toContainText('Live');
	await expect(row).toContainText(`wm_${secret.slice(3, 11)}_…`);
	await expect(row).toContainText('Any series');
	// Cells after the key's name: writes, made, ends, last used.
	const ends = row.getByRole('cell').nth(2);
	const lastUsed = row.getByRole('cell').nth(3);
	await expect(ends).toHaveText('Never');
	await expect(lastUsed).toHaveText('Never');
	await expectNoViolations(page, { include: '#set-api-keys' });

	const pushed = await push(secret);
	expect(pushed.out).toContain('pushed 7 days from 2024-01-01');
	expect(pushed.code).toBe(0);

	// The days are on the Data tab.
	await page.goto(`/projects/${project.id}?tab=series`);
	const inputs = page.getByRole('region', { name: 'Input time series' });
	await expect(inputs.getByRole('rowheader', { name: /^Flow — logger/ })).toBeVisible();

	// History names the key as the actor.
	await page.goto(`/projects/${project.id}?tab=history`);
	const entries = page.getByTestId('history-entry');
	// A series the key added holds the automatic runs for a person (issue #51, backend series/hold.ts heldFor).
	// The hold is recorded in the push's own change set, so it shares the push's entry.
	await expect(entries).toHaveCount(2);
	await expect(entries.nth(0)).toContainText('API key “Weir gateway”');
	await expect(entries.nth(0)).toContainText('Held automatic runs: an API key added the Flow — logger “Logger” series, which runs will read.');
	await expect(entries.nth(0)).toContainText('+1 more');
	await entries.nth(0).getByRole('link').click();
	await expect(page.getByTestId('history-detail')).toContainText('Added the Flow — logger “Logger” series (1 Jan 2024 to 7 Jan 2024)');
	await expect(entries.nth(1)).toContainText('Created an API key “Weir gateway”');
	await expect(entries.nth(1)).toContainText('Owner');

	// The list shows it was used; a revoke stops the next push.
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(lastUsed).not.toHaveText('Never');
	page.once('dialog', (d) => d.accept());
	await row.getByRole('button', { name: 'Revoke Weir gateway' }).click();
	await expect(row).toContainText('Revoked');
	await expect(row.getByRole('button', { name: 'Revoke Weir gateway' })).toHaveCount(0);
	const refused = await push(secret);
	expect(refused.code).toBe(1);
	expect(refused.out).toContain('ingest answered 401: invalid or missing API key');
});

test('an editor sees the data feeds but no API keys panel (the owner does)', async ({ page, owner, signIn }) => {
	void owner;
	const project = await createProject(page.request, 'Owners only');
	const editor = await signIn('Keys editor');
	await addMember(page.request, project.id, editor.user.email, 'editor');

	await editor.page.goto(`/projects/${project.id}?tab=settings`);
	await expect(editor.page.getByRole('region', { name: 'Data feeds' })).toBeVisible();
	await expect(editor.page.getByRole('region', { name: 'API keys' })).toHaveCount(0);
	// Positive control.
	await page.goto(`/projects/${project.id}?tab=settings`);
	await expect(page.getByRole('region', { name: 'API keys' })).toBeVisible();
});
