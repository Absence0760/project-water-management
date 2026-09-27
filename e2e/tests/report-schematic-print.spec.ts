// The report's Network schematic on paper (issue #17, docs/ui.md § Report):
// a catchment of 30 units used to print as one 4,500 px strip scaled to the
// A4 width, its names about 1.5 pt. The printed drawing is wrapped to at most
// five columns (NetworkSchematic's `paper`, wrappedSchematicLayout), so every
// unit's name prints at a readable size. Measured in the PDF itself with
// poppler's `pdftotext -bbox`: needs poppler-utils (CI installs it); locally
// the spec is skipped and says why when pdftotext is missing, never in CI.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createProject, createRun, node, putModel, putSeries, syntheticFlow, syntheticRain, updateSettings } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';

const hasPdftotext = (() => {
	try {
		execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

interface Word {
	text: string;
	xMin: number;
	yMin: number;
	yMax: number;
}

/** Each page's words, with their boxes in points. */
function pdfWords(path: string): Word[][] {
	const html = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
	return html
		.split('<page ')
		.slice(1)
		.map((page) =>
			[...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
				text: m[4]!,
				xMin: Number(m[1]),
				yMin: Number(m[2]),
				yMax: Number(m[3])
			}))
		);
}

test('a 30-unit catchment prints its network schematic with every name readable', async ({ page, owner }, testInfo) => {
	void owner;
	test.skip(!hasPdftotext && !process.env.CI, 'needs pdftotext (poppler-utils)');

	// An outflow gauge with 18 units draining straight into it and a gauge upstream taking 12 more.
	const outlet = node('Outflow gauge', 'gauge', null, 1, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const mid = node('Middle gauge', 'gauge', outlet.id, 2, { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 });
	const units = Array.from({ length: 30 }, (_, i) =>
		node(`Unit ${String(i + 1).padStart(2, '0')}`, 'farm', i < 18 ? outlet.id : mid.id, 3 + i, i % 3 === 0 ? { damCapacityM3: 50_000 } : {})
	);
	const project = await createProject(page.request, 'Thirty unit catchment');
	await putModel(page.request, project.id, { nodes: [outlet, mid, ...units], crops: [], cropAreas: [], transfers: [] });
	await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(60) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(60) });
	const runId = await createRun(page.request, project.id, 'Baseline');

	await page.goto(`/projects/${project.id}/report?run=${runId}`);
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	// The screen keeps the usual drawing, every unit side by side, scrolling in its box.
	const onScreen = page.locator('#rep-network svg.schematic:visible');
	await expect(onScreen).toHaveCount(1);
	expect(Number(await onScreen.getAttribute('width'))).toBeGreaterThan(4000);

	const pdfPath = testInfo.outputPath('report.pdf');
	writeFileSync(pdfPath, await page.pdf({ format: 'A4' }));
	const pages = pdfWords(pdfPath);

	// The Network section's pages: from the page its heading starts (every
	// section starts a page; the cover's contents list names them too) to the next section's.
	const heading = (p: Word[], n: string, title: string) => p[0]?.text === n && p[1]?.text === title;
	const first = pages.findIndex((p) => heading(p, '1.', 'Network'));
	const next = pages.findIndex((p) => heading(p, '2.', 'Inputs'));
	expect(first).toBeGreaterThan(0);
	expect(next).toBeGreaterThan(first);
	const labels = pages
		.slice(first, next)
		.flatMap((p) => p.flatMap((w, i) => (w.text === 'Unit' && /^\d\d$/.test(p[i + 1]?.text ?? '') ? [{ n: p[i + 1]!.text, h: w.yMax - w.yMin }] : [])));

	// Every unit is named in the drawing, each name tall enough to read. A
	// word's box is ~1.38 × its type size in this font, so 9.5 pt is ~7 pt
	// type; wrapped, the names print at their full 9.4 pt (13 pt boxes), where
	// the unwrapped strip scaled to the page printed them at ~1.4 pt.
	expect(new Set(labels.map((l) => l.n)).size).toBe(30);
	for (const l of labels) expect(l.h, `Unit ${l.n}`).toBeGreaterThanOrEqual(9.5);
	// Wrapped onto one page, not sliced across several.
	expect(next - first).toBe(1);
});
