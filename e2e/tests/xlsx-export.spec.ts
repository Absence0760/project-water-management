// The run workbook (WP-1.28): "Workbook (.xlsx)" in the Runs tab's Download
// menu builds the file in a Web Worker from the bulk series route and the
// summary CSV. The test downloads it, parses it with SheetJS here in Node,
// and checks every value against the CSV exports of the same run, as text:
// a number cell must print exactly as the CSV wrote it (full precision).
// A farm's audit workbook (issue #68) is built the same way: live formulas
// beside the model's numbers.
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { createRun, putModel, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { projectDay } from '../support/dates.ts';

/** A runnable synthetic project whose upper farm has a formula-looking name, with one run. */
async function seeded(request: APIRequestContext) {
	const project = await seedRunnableProject(request, 'Workbook export');
	const model = { ...project.model, nodes: project.model.nodes.map((n) => (n.name === 'Upper farm' ? { ...n, name: '=Upper farm' } : n)) };
	await putModel(request, project.id, model);
	const runId = await createRun(request, project.id, 'Baseline');
	return { id: project.id, runId, nodes: model.nodes as { id: string; name: string }[] };
}

/** RFC 4180 → rows of text fields (the BOM dropped). */
function parseCsv(text: string): string[][] {
	const s = text.replace(/^﻿/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (quoted) {
			if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
			else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') row.push(field), (field = '');
		else if (ch === '\r' && s[i + 1] === '\n') {
			row.push(field);
			rows.push(row);
			(row = []), (field = ''), i++;
		} else field += ch;
	}
	if (field || row.length) row.push(field), rows.push(row);
	return rows;
}

async function csv(request: APIRequestContext, path: string) {
	const res = await request.get(`${API_URL}${path}`);
	expect(res.status()).toBe(200);
	return parseCsv(new TextDecoder().decode(await res.body()));
}

/**
 * A daily CSV's table: the rows after its leading `#` disclaimer and `# run=…` provenance lines, which the workbook
 * carries once, on its Summary sheet, rather than atop every daily sheet.
 */
async function dailyCsv(request: APIRequestContext, path: string) {
	const [disclaimer, provenance, ...rows] = await csv(request, path);
	expect(disclaimer![0]).toMatch(/^# model estimates /);
	expect(disclaimer).toHaveLength(1);
	expect(provenance![0]).toMatch(/^# run=Baseline; engine=/);
	expect(provenance).toHaveLength(1); // one cell: the line holds no comma or quote
	return rows;
}

/** A sheet as rows of text, the way the CSV prints each cell: numbers by String(), dates as shown. */
function sheetText(ws: XLSX.WorkSheet): string[][] {
	const range = XLSX.utils.decode_range(ws['!ref']!);
	const rows: string[][] = [];
	for (let r = range.s.r; r <= range.e.r; r++) {
		const row: string[] = [];
		for (let c = range.s.c; c <= range.e.c; c++) {
			const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
			row.push(!cell ? '' : cell.t === 'n' && cell.z === 'yyyy-mm-dd' ? String(cell.w) : String(cell.v));
		}
		rows.push(row);
	}
	return rows;
}

/** Rows with their trailing empty cells dropped, blank rows removed (sheets and CSV lay blocks out differently). */
const trimmed = (rows: string[][]) =>
	rows
		.map((r) => {
			let n = r.length;
			while (n && r[n - 1] === '') n--;
			return r.slice(0, n);
		})
		.filter((r) => r.length);

/** Open the selected run's Download menu; the workbook item and the menu's own status line. */
async function openRunDownloads(page: Page, projectId: string, runId: string) {
	await page.goto(`/projects/${projectId}?tab=runs&run=${runId}`);
	await expect(page.getByRole('heading', { level: 2, name: 'Baseline' })).toBeVisible();
	const trigger = page.getByRole('button', { name: 'Download', exact: true });
	// The open menu closes on scroll (it is fixed to the viewport), so bring the
	// button into view first and let that scroll land before opening it: on a
	// phone it starts below the fold, and the click's own scroll-into-view
	// would otherwise close the menu it opens.
	await trigger.scrollIntoViewIfNeeded();
	await expect(trigger).toBeInViewport();
	await trigger.click();
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	return {
		item: page.getByRole('button', { name: /^Workbook \(\.xlsx\)/ }),
		status: page.locator('.download', { has: trigger }).getByRole('status')
	};
}

const isBulk = (url: URL, nodeId?: string) => url.pathname.endsWith('/series/bulk') && (nodeId === undefined || url.searchParams.get('nodeId') === nodeId);

test('the run workbook downloads and every value equals the CSV exports', async ({ page, owner }) => {
	void owner;
	const { id, runId, nodes } = await seeded(page.request);
	const { item, status } = await openRunDownloads(page, id, runId);
	const download = page.waitForEvent('download');
	// Dated by the project's calendar day (South Africa by default), not UTC's (issue #45).
	const before = projectDay();
	await item.click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/^workbook-export_baseline_workbook_\d{4}-\d{2}-\d{2}\.xlsx$/);
	expect([before, projectDay()]).toContain(/_(\d{4}-\d{2}-\d{2})\.xlsx$/.exec(file.suggestedFilename())![1]);
	await expect(status).toHaveText(/^Downloaded workbook-export_baseline_workbook_\d{4}-\d{2}-\d{2}\.xlsx$/);

	const wb = XLSX.read(await readFile((await file.path())!), { type: 'buffer', cellNF: true, cellText: true });
	// The disclaimer first; network order after the catchment; a formula-looking farm name is a plain sheet name.
	expect(wb.SheetNames).toEqual([
		'Read this first',
		'Summary',
		'Catchment',
		'Outflow gauge',
		'=Upper farm',
		'Lower farm',
		'Curtailment',
		'EWR grid',
		'Reserve compliance',
		'Annual volumes',
		'Data checks',
		'Inputs',
		...(wb.SheetNames.includes('Warnings') ? ['Warnings'] : [])
	]);

	// Daily sheets: row for row, cell for cell, the daily CSV.
	const base = `/projects/${id}/runs/${runId}/export`;
	expect(sheetText(wb.Sheets['Catchment']!)).toEqual(await dailyCsv(page.request, `${base}/daily.csv`));
	for (const n of nodes) {
		const sheet = sheetText(wb.Sheets[n.name]!);
		expect(sheet.length).toBe(121);
		expect(sheet).toEqual(await dailyCsv(page.request, `${base}/daily.csv?nodeId=${n.id}`));
	}
	// Numbers are numbers, with a display format, not text.
	const upper = wb.Sheets['=Upper farm']!;
	expect(upper['A2']).toMatchObject({ t: 'n', w: '2021-10-01' });
	const supplied = sheetText(upper)[0]!.indexOf('Irrigation supplied [G] (m³/day)');
	expect(upper[XLSX.utils.encode_cell({ r: 1, c: supplied })]).toMatchObject({ t: 'n', z: '#,##0.00' });

	// The summary sheets hold the summary CSV's rows, each once; Annual volumes adds the calibration's table after them.
	const summaryCsv = trimmed(await csv(page.request, `${base}/summary.csv`));
	const annual = trimmed(sheetText(wb.Sheets['Annual volumes']!));
	const fromCsv = annual.slice(0, annual.findIndex((r) => r[0] === 'Calibration: observed and simulated volume per water year'));
	const sheets = ['Summary', 'Curtailment', 'Reserve compliance', 'Data checks', 'Warnings'].filter((n) => wb.Sheets[n]).flatMap((n) => trimmed(sheetText(wb.Sheets[n]!)));
	const key = (rows: string[][]) => rows.map((r) => JSON.stringify(r)).sort();
	expect(key([...sheets, ...fromCsv])).toEqual(key(summaryCsv));

	// The farm name is defused in every cell, exactly as the CSV does it, and nothing is a formula.
	const summaryRows = sheetText(wb.Sheets['Summary']!);
	expect(summaryRows.some((r) => r[0] === "'=Upper farm")).toBe(true);
	// The Runs tab's FDC Q10–Q95 table is on the Summary sheet (issue #45).
	expect(summaryRows.some((r) => r[0]?.startsWith('Flow-duration percentiles'))).toBe(true);
	expect(summaryRows.filter((r) => r[0] === 'Whole run' && ['Natural', 'Simulated outflow'].includes(r[1] ?? ''))).toHaveLength(2);
	for (const name of wb.SheetNames) {
		for (const [ref, cell] of Object.entries(wb.Sheets[name]!)) if (!ref.startsWith('!')) expect((cell as XLSX.CellObject).f).toBeUndefined();
	}
	expect(sheetText(wb.Sheets['Inputs']!).some((r) => r[0] === "'=Upper farm")).toBe(true);
	// The disclaimer sheet carries the Terms URL in full, on the site's own address.
	expect(sheetText(wb.Sheets['Read this first']!).some((r) => r[0]?.endsWith(`Terms of use: ${new URL(page.url()).origin}/terms.`))).toBe(true);
});

test("a farm's audit workbook recomputes it with live formulas beside the model's numbers (issue #68)", async ({ page, owner }) => {
	void owner;
	const { id, runId } = await seeded(page.request);
	const { status } = await openRunDownloads(page, id, runId);
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: /^Audit workbook — Lower farm \(\.xlsx\)/ }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe('baseline_lower_farm_audit.xlsx');
	await expect(status).toHaveText('Downloaded baseline_lower_farm_audit.xlsx');

	const wb = XLSX.read(await readFile((await file.path())!), { type: 'buffer' });
	expect(wb.SheetNames).toEqual(['Read this first', 'About', 'Parameters', 'Audit', 'Model']);
	const cell = (sheet: string, ref: string) => wb.Sheets[sheet]![ref] as XLSX.CellObject;
	const header = sheetText(wb.Sheets['Audit']!)[0]!;
	expect(header.length).toBeGreaterThan(30);
	const col = (h: string) => {
		expect(header).toContain(h);
		return XLSX.utils.encode_col(header.indexOf(h));
	};
	const storage = col('Dam storage [Q] (m³)');
	const area = col('Dam surface area (m²)');
	const supplied = col('Irrigation supplied [G] (m³/day)');
	// Day one starts from the storage parameter; every later day from the row above.
	expect(cell('Audit', `${storage}2`).f).toMatch(/^MIN\(/);
	expect(cell('Audit', `${area}2`).f).toContain('Parameters!$B$');
	expect(cell('Audit', `${area}3`).f).toContain(`${storage}2`);
	// Inputs are values; each formula's value equals the model's to float noise, over the whole run.
	expect(cell('Audit', `${col('From the run: Inflow from upstream [H] (m³/day)')}2`).f).toBeUndefined();
	for (let r = 2; r <= 121; r++) expect(Math.abs(Number(cell('Audit', `${supplied}${r}`).v) - Number(cell('Model', `${supplied}${r}`).v))).toBeLessThan(1e-6);
	expect(cell('About', 'B6').f).toMatch(/^MAX\(Audit!/);
	expect(Number(cell('About', 'B6').v)).toBeLessThan(1e-6);
});

test('the workbook shows progress per node and Cancel stops it', async ({ page, owner }) => {
	void owner;
	const { id, runId } = await seeded(page.request);
	// Hold every bulk request (the worker's) until the test lets it go.
	const held: (() => Promise<void>)[] = [];
	const hold = (url: URL) => isBulk(url);
	await page.route(hold, (route) => {
		held.push(() => route.continue());
	});
	const { item, status } = await openRunDownloads(page, id, runId);
	await item.click();
	await expect(status).toHaveText('Fetching Catchment (1 of 4)…');
	await expect(page.getByRole('progressbar', { name: 'Workbook download progress' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(status).toHaveText('Workbook download cancelled');
	await expect(page.getByRole('progressbar')).toHaveCount(0);
	await page.unroute(hold);
	await Promise.all(held.map((go) => go().catch(() => {})));
});

test('a failed fetch shows the error, on a phone too', async ({ page, owner }) => {
	void owner;
	await page.setViewportSize({ width: 390, height: 844 });
	const { id, runId, nodes } = await seeded(page.request);
	const lower = nodes.find((n) => n.name === 'Lower farm')!;
	await page.route(
		(url) => isBulk(url, lower.id),
		(route) => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'export larger than 5 MB — narrow it' }) })
	);
	const { item, status } = await openRunDownloads(page, id, runId);
	await expect(item).toBeInViewport();
	await item.click();
	await expect(status).toHaveText('Workbook failed: export larger than 5 MB — narrow it');
	await expect(page.getByRole('progressbar')).toHaveCount(0);
});
