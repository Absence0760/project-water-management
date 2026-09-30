// Every chart says what it shows (docs/design/ui-playbook.md § 3, "Label
// every chart"). The Crops list's factor sparklines shipped with no title,
// axis, units or months; these guards stop the next unlabelled one:
//
// 1. Every <svg> in the app is either hidden from assistive tech (it, or an
//    element around it, is aria-hidden="true": an icon, or a drawing whose
//    words sit beside it) or an image with a name (role="img" and an
//    aria-label or aria-labelledby). A drawing with neither is a picture a
//    screen reader meets as nothing.
// 2. Every chart component (a file named …Chart, …Charts, …Bars, …Sparkline,
//    …Strip or …Plot, or one that imports uPlot) is listed in CHARTS with how
//    it is named, and that holds: a required prop (not optional, so a caller
//    can't leave it out), its own heading or caption in the markup, or a
//    fixed accessible name on its drawing. A new chart component fails here
//    until it is listed, which is the prompt to give it a title, units, its
//    time axis and a text equivalent.
// 3. A chart drawn inline in a bigger component (a named <svg role="img">
//    outside those files) is listed in INLINE with what labels it on
//    screen. The old crop sparkline was one: named for a screen reader, with
//    nothing on screen to say what it was.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return e.name === '__fixtures__' ? [] : svelteFiles(join(dir, e.name));
		return e.name.endsWith('.svelte') ? [join(dir, e.name)] : [];
	});
}

type Node = { type: string; name?: string; attributes?: Attr[]; start: number; [k: string]: unknown };
type Attr = { type: string; name?: string; value?: unknown };

/** An attribute's static text ("true" for aria-hidden="true" or aria-hidden={true}); '' for a dynamic value; null when absent. */
function attr(node: Node, name: string): string | null {
	const a = node.attributes?.find((x) => x.type === 'Attribute' && x.name === name);
	if (!a) return null;
	const v = a.value;
	if (v === true) return 'true';
	const parts = Array.isArray(v) ? v : [v];
	return parts
		.map((p) => {
			const q = p as { type: string; data?: string; expression?: { type: string; value?: unknown } };
			if (q.type === 'Text') return q.data ?? '';
			if (q.type === 'ExpressionTag' && q.expression?.type === 'Literal') return String(q.expression.value);
			return '';
		})
		.join('');
}

/** Each <svg> that is neither hidden nor a named image (`unlabelled`, as "file:line"), and each named image (`images`). */
function svgsOf(file: string, source: string): { unlabelled: string[]; images: string[] } {
	const ast = parse(source, { modern: true }) as unknown as { fragment: Node };
	const bad: string[] = [];
	const images: string[] = [];
	const line = (n: Node) => source.slice(0, n.start).split('\n').length;
	const visit = (value: unknown, hidden: boolean): void => {
		if (Array.isArray(value)) return value.forEach((v) => visit(v, hidden));
		if (!value || typeof value !== 'object') return;
		const node = value as Node;
		if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
			const here = hidden || attr(node, 'aria-hidden') === 'true';
			if (node.name === 'svg' && !here) {
				const named = attr(node, 'role') === 'img' && (attr(node, 'aria-label') !== null || attr(node, 'aria-labelledby') !== null);
				(named ? images : bad).push(`${relative(SRC, file)}:${line(node)}`);
			}
			return visit(node.fragment, here);
		}
		// Blocks ({#if}, {#each}, {#snippet} …) and components: walk what they render; skip expressions and attributes.
		for (const [k, v] of Object.entries(node)) {
			if (k === 'attributes' || k === 'expression' || k === 'metadata') continue;
			if (v && typeof v === 'object') visit(v, hidden);
		}
	};
	visit(ast.fragment, false);
	return { unlabelled: bad, images };
}
const unlabelledSvgs = (file: string, source: string) => svgsOf(file, source).unlabelled;

/**
 * How each chart component is named (relative to src/lib/components):
 * `prop`: a required prop naming what it shows; `heading`: its own heading
 * or figcaption; `svgName`: a fixed accessible name on its drawing (a regex
 * its source must contain); `delegates`: draws nothing itself, only through
 * listed charts (which name themselves).
 */
const CHARTS: Record<string, { prop: string } | { heading: true } | { svgName: RegExp } | { delegates: true }> = {
	'charts/LineChart.svelte': { prop: 'title' },
	'charts/Sparkline.svelte': { prop: 'caption' },
	// The evidence report's figures (issue #71): the SVG <title> is the `title` prop; each also has a caption and the numbers in a table.
	'report/evidence/FdcPlot.svelte': { prop: 'title' },
	'report/evidence/IntervalPlot.svelte': { prop: 'title' },
	'allocations/UsePlot.svelte': { prop: 'title' },
	'settings/MonthlyBars.svelte': { prop: 'label' },
	'series/CoverageStrip.svelte': { prop: 'label' },
	'landing/MiniChart.svelte': { prop: 'label' },
	'farm/DamChart.svelte': { heading: true },
	'farm/MonthlyChart.svelte': { heading: true },
	'share/FlowChart.svelte': { heading: true },
	'overview/ReserveStrip.svelte': { heading: true },
	'uncertainty/BandFdcChart.svelte': { svgName: /<title id="\{uid\}-t">/ },
	'uncertainty/TornadoChart.svelte': { prop: 'title' },
	'compare/ReserveYearsChart.svelte': { svgName: /aria-label="Days below the reserve per water year\./ },
	'runs/RunChart.svelte': { delegates: true },
	'runs/RunCharts.svelte': { delegates: true }
};

/**
 * Charts drawn inline in a bigger component rather than as a chart component
 * of their own (a named <svg role="img"> outside CHARTS), each with how it
 * says what it shows. The Crops list's factor sparkline was one of these,
 * named for screen readers yet with nothing on screen to say what it was;
 * a new one fails here until it is listed with its labels, or moved into
 * a chart component (a sparkline: charts/Sparkline.svelte).
 */
const INLINE: Record<string, string> = {
	'network/DamStorageFields.svelte': 'the survey curve: axis titles "Volume (m³)" and "Area (m²)", end ticks, "dashed = capacity"; the table beside it',
	'runs/EwrFdcOverlay.svelte': 'a month\'s flow-duration curves against the EWR: axis titles "% of <month>s the flow is at least this" and "Flow (<unit>, log scale)", ticks on both axes, a key of the lines, the SVG title; the values table under it',
	'runs/EwrAssurancePanel.svelte': 'months met by month of the year: "% of months met", a month under each bar and its % on it; the table under it'
};
/** Help's explanatory diagrams: pictures of an idea, each named with a full text description (help/Diagram.svelte), not charts of data. */
const DIAGRAMS = 'help/diagrams/';

const COMPONENTS = join(SRC, 'lib/components');
const isChart = (file: string, source: string) => /(Chart|Charts|Bars|Sparkline|Strip|Plot)\.svelte$/.test(file) || /from ['"]uplot['"]/.test(source);

/** A `name: …` member of the $props() type with no `?`. */
const requiredProp = (source: string, name: string) => new RegExp(`\\b${name}\\s*:\\s*[A-Za-z{(\\[]`).test(source) && !new RegExp(`\\b${name}\\?\\s*:`).test(source);

describe('chart labels (ui-playbook § 3, "Label every chart")', () => {
	const files = svelteFiles(SRC);
	// Each file parsed once, for both svg checks.
	const memo = new Map<string, ReturnType<typeof svgsOf>>();
	const svgs = (f: string) => memo.get(f) ?? memo.set(f, svgsOf(f, readFileSync(f, 'utf8'))).get(f)!;

	it('the svg check finds an unnamed drawing, and passes a hidden one, one inside a hidden element and a named image', () => {
		const src = [
			'<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>',
			'<svg aria-hidden="true"><path d="M0 0" /></svg>',
			'<span aria-hidden="true">{#if x}<svg><path d="M0 0" /></svg>{/if}</span>',
			'<svg role="img" aria-label={name}><path d="M0 0" /></svg>',
			'{#each xs as x}<svg role="img"><path d="M0 0" /></svg>{/each}'
		].join('\n');
		expect(unlabelledSvgs(join(SRC, 'x.svelte'), src)).toEqual(['x.svelte:1', 'x.svelte:5']);
		// The named image is what the inline-chart check lists (the old crop sparkline was one, in CropsTab.svelte).
		expect(svgsOf(join(SRC, 'x.svelte'), src).images).toEqual(['x.svelte:4']);
	});

	it('every svg is hidden from assistive tech or a named image', () => {
		expect(files.flatMap((f) => svgs(f).unlabelled)).toEqual([]);
	});

	it('every chart drawn inline in a component is listed with its labels', () => {
		const inline = [
			...new Set(
				files
					.filter((f) => !(relative(COMPONENTS, f) in CHARTS))
					.flatMap((f) => svgs(f).images.map(() => relative(COMPONENTS, f)))
			)
		];
		expect(inline.filter((f) => !(f in INLINE) && !f.startsWith(DIAGRAMS)), 'list it in INLINE with how it is labelled, or use a chart component').toEqual([]);
		expect(Object.keys(INLINE).filter((f) => !inline.includes(f)), 'a listed inline chart that is gone').toEqual([]);
	});

	it('every chart component is listed with how it says what it shows', () => {
		const charts = files.filter((f) => f.startsWith(COMPONENTS) && isChart(f, readFileSync(f, 'utf8'))).map((f) => relative(COMPONENTS, f));
		expect(charts.filter((f) => !(f in CHARTS)), 'add it to CHARTS with its naming prop, heading or accessible name').toEqual([]);
		expect(Object.keys(CHARTS).filter((f) => !charts.includes(f)), 'a listed chart that is gone or renamed').toEqual([]);
	});

	it('and each is named that way: a required prop, its own heading, a fixed accessible name, or only listed charts inside', () => {
		for (const [file, how] of Object.entries(CHARTS)) {
			const source = readFileSync(join(COMPONENTS, file), 'utf8');
			if ('prop' in how) expect(requiredProp(source, how.prop), `${file}: a required \`${how.prop}\` prop`).toBe(true);
			if ('heading' in how) expect(/<(h[1-6]|figcaption)\b/.test(source), `${file}: its own heading`).toBe(true);
			if ('svgName' in how) expect(how.svgName.test(source), `${file}: its drawing's name`).toBe(true);
			if ('delegates' in how) {
				expect(/<svg\b/.test(source) || /from ['"]uplot['"]/.test(source), `${file}: draws nothing itself`).toBe(false);
				expect(/<LineChart\b|<RunChart\b/.test(source), `${file}: draws through LineChart`).toBe(true);
			}
		}
	});

	it('the required-prop check tells a required prop from an optional one', () => {
		expect(requiredProp('let { title }: { title: string; unit?: string } = $props();', 'title')).toBe(true);
		expect(requiredProp('let { title }: { title?: string } = $props();', 'title')).toBe(false);
		expect(requiredProp('let { unit }: { unit: string } = $props();', 'title')).toBe(false);
	});
});
