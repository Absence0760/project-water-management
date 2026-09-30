// The report's Network schematic on paper (issue #17, docs/ui.md § Report):
// a catchment of 30 units used to print as one 4,500 px strip scaled to the
// A4 width, its names about 1.5 pt. The printed drawing is wrapped to at most
// five columns (NetworkSchematic's `paper`, wrappedSchematicLayout), so every
// unit's name prints at a readable size; and a network taller than a page is
// split into page-high bands at row boundaries (paperBands), each printed
// whole, so no page break cuts through a row of names. Measured in the PDF
// itself with poppler's `pdftotext -bbox`: needs poppler-utils (CI installs
// it); locally the spec is skipped and says why when pdftotext is missing,
// never in CI.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
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
	xMax: number;
	yMin: number;
	yMax: number;
}
interface PdfPage {
	height: number;
	words: Word[];
}

/** Each page's height and words, with their boxes in points. */
function pdfPages(path: string): PdfPage[] {
	const html = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); // every word with its box: a long report passes Node's 1 MB default
	return html
		.split('<page ')
		.slice(1)
		.map((page) => ({
			height: Number(/height="([\d.]+)"/.exec(page)![1]),
			words: [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
				text: m[5]!,
				xMin: Number(m[1]),
				xMax: Number(m[3]),
				yMin: Number(m[2]),
				yMax: Number(m[4])
			}))
		}));
}

type NodeRow = ReturnType<typeof node>;

/** The smallest printed name the report allows, in points of type. */
const MIN_PT = 7;

/** A project with this network and one run; returns the report's URL. */
async function reportOf(page: Page, name: string, nodes: NodeRow[]): Promise<string> {
	const project = await createProject(page.request, name);
	await putModel(page.request, project.id, { nodes, crops: [], cropAreas: [], transfers: [] });
	await updateSettings(page.request, project.id, { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110] });
	await putSeries(page.request, project.id, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: syntheticRain(60) });
	await putSeries(page.request, project.id, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2021-10-01', values: syntheticFlow(60) });
	const runId = await createRun(page.request, project.id, 'Baseline');
	return `/projects/${project.id}/report?run=${runId}`;
}

/**
 * Prints the report and returns the Network section's pages: from the page
 * its heading starts (every section starts a page; the cover's contents list
 * names them too) to the next section's.
 */
async function networkPages(page: Page, testInfo: TestInfo): Promise<PdfPage[]> {
	const pdfPath = testInfo.outputPath('report.pdf');
	writeFileSync(pdfPath, await page.pdf({ format: 'A4' }));
	const pages = pdfPages(pdfPath);
	const heading = (p: PdfPage, n: string, title: string) => p.words[0]?.text === n && p.words[1]?.text === title;
	const first = pages.findIndex((p) => heading(p, '1.', 'Network'));
	const next = pages.findIndex((p) => heading(p, '2.', 'Inputs'));
	expect(first).toBeGreaterThan(0);
	expect(next).toBeGreaterThan(first);
	return pages.slice(first, next);
}

/** A name as the paper drawing lays it out: its width in the SVG's own units (CSS px, unscaled) and its type size (px). */
type Drawn = Map<string, { length: number; sizePx: number }>;

/** The paper drawing's names, measured in the page under print media. */
async function paperNames(page: Page): Promise<Drawn> {
	await page.emulateMedia({ media: 'print' });
	const rows = await page.locator('#rep-network .sch-paper svg.schematic text.label').evaluateAll((ts) =>
		ts.map((t) => ({ text: t.textContent ?? '', length: (t as SVGTextContentElement).getComputedTextLength(), sizePx: parseFloat(getComputedStyle(t).fontSize) }))
	);
	return new Map(rows.map((r) => [r.text, { length: r.length, sizePx: r.sizePx }]));
}

/**
 * Every "<word> NN" name drawn on these pages (`word` matching `prefix`), with
 * its page, box and printed type size in points. The size is the drawing's
 * scale on paper (the name's printed width over its width in the SVG) times
 * its type size, so it reads the same in every font; a word box's height is
 * a font's own metric (~1.38 × the size in Noto Sans, ~1.16 in DejaVu Sans)
 * and poppler's differs between versions.
 */
function names(pages: PdfPage[], prefix: string, drawn: Drawn) {
	return pages.flatMap((p, page) =>
		p.words.flatMap((w, i) => {
			const nn = p.words[i + 1];
			if (!(w.text === prefix && nn && /^\d\d$/.test(nn.text))) return [];
			const name = `${prefix} ${nn.text}`;
			const svg = drawn.get(name);
			// px → pt at 96 dpi: 0.75; the scale is (printed pt) / (SVG px × 0.75), so the 0.75s cancel.
			const pt = svg ? (svg.sizePx * (nn.xMax - w.xMin)) / svg.length : 0;
			return [{ name, page, yMin: Math.min(w.yMin, nn.yMin), yMax: Math.max(w.yMax, nn.yMax), pt }];
		})
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
	await page.goto(await reportOf(page, 'Thirty unit catchment', [outlet, mid, ...units]));
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();
	// The screen keeps the usual drawing, every unit side by side, scrolling in its box.
	const onScreen = page.locator('#rep-network svg.schematic:visible');
	await expect(onScreen).toHaveCount(1);
	expect(Number(await onScreen.getAttribute('width'))).toBeGreaterThan(4000);
	// It fits a page, so paper draws it as one picture, not in bands.
	await expect(page.locator('#rep-network .sch-paper svg.schematic')).toHaveCount(1);

	const svgNames = await paperNames(page);
	const pages = await networkPages(page, testInfo);
	const labels = names(pages, 'Unit', svgNames);

	// Every unit is named in the drawing once, each name big enough to read:
	// wrapped, the names print at ~7.6 pt type (the five columns and the
	// widest second line scaled to the A4 width), where the unwrapped strip
	// scaled to the page printed them at ~1.4 pt.
	expect(labels.map((l) => l.name).sort()).toEqual(units.map((u) => u.name).sort());
	for (const l of labels) expect(l.pt, l.name).toBeGreaterThanOrEqual(MIN_PT);
	// Wrapped onto one page, not sliced across several.
	expect(pages).toHaveLength(1);
});

test('a network taller than a page prints in page-high bands, no name cut by a page break', async ({ page, owner }, testInfo) => {
	void owner;
	test.skip(!hasPdftotext && !process.env.CI, 'needs pdftotext (poppler-utils)');

	// A main stem of 25 gauges, each with a unit beside it and every third with a second.
	const two = (n: number) => String(n).padStart(2, '0');
	const flowOnly = { pctRunoffToDam: 0, damInitialPct: 0, damMinPct: 0 };
	const gauges: NodeRow[] = [];
	for (let i = 0; i < 25; i++) gauges.push(node(`Gauge ${two(i + 1)}`, 'gauge', i === 0 ? null : gauges[i - 1]!.id, 1 + i, flowOnly));
	const units: NodeRow[] = [];
	gauges.forEach((g, i) => {
		for (let k = 0; k < (i % 3 === 0 ? 2 : 1); k++) {
			units.push(node(`Unit ${two(units.length + 1)}`, 'farm', g.id, 100 + units.length, units.length % 4 === 0 ? { damCapacityM3: 40_000 } : {}));
		}
	});
	await page.goto(await reportOf(page, 'Long main stem', [...gauges, ...units]));
	await expect(page.locator('main[data-report-ready="true"]')).toBeVisible();

	// Paper splits it into bands, one SVG each; the screen keeps one drawing.
	const bands = page.locator('#rep-network .sch-paper svg.schematic');
	const bandCount = await bands.count();
	expect(bandCount).toBeGreaterThan(1);
	await expect(page.locator('#rep-network .sch-screen svg.schematic')).toHaveCount(1);

	const svgNames = await paperNames(page);
	const pages = await networkPages(page, testInfo);
	const drawn = [...names(pages, 'Gauge', svgNames), ...names(pages, 'Unit', svgNames)];

	// Every name whole on exactly one page: a drawing sliced by a page break
	// prints the names on the cut on both sides of it, clipped.
	expect(drawn.map((d) => d.name).sort()).toEqual([...gauges, ...units].map((n) => n.name).sort());
	// Inside the page's printable area (the report's @page margins are 14 mm,
	// ~39.7 pt), never across its edge, and at a readable size (as above).
	const margin = (14 / 25.4) * 72;
	for (const d of drawn) {
		expect(d.yMin, `${d.name} top`).toBeGreaterThanOrEqual(margin - 1);
		expect(d.yMax, `${d.name} foot`).toBeLessThanOrEqual(pages[d.page]!.height - margin + 1);
		expect(d.pt, d.name).toBeGreaterThanOrEqual(MIN_PT);
	}
	// A band a page, each saying where its rivers go on.
	expect(pages).toHaveLength(bandCount);
	const text = pages.map((p) => p.words.map((w) => w.text).join(' '));
	for (const t of text.slice(0, -1)) expect(t).toContain('Continues on the next page');
	for (const t of text.slice(1)) expect(t).toContain('Continued from the previous page');
});
