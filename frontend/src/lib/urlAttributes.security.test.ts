// Script URLs in the page (docs/security.md § Input handling). Svelte escapes
// an attribute's text but not its meaning: `href={x}` with x =
// "javascript:alert(1)" runs script when clicked, and so do `src`, `action`,
// `formaction` and `srcdoc`. This walks every component under src/ and checks
// each URL-bearing attribute:
//
//   - a value whose head is literal text ("/…", "?tab=…", "#…", "{base}/farm")
//     fixes the scheme itself, and the scheme must be http(s), mailto or tel
//     (never javascript:, data:, vbscript:, and never a protocol-relative
//     "//host");
//   - a value whose head is an expression (`href={runHref(id)}`, `{href}`)
//     can be anything at run time, so its expression must be one of the
//     REVIEWED heads below, each with the reason it can't carry a script URL.
//     A new one fails here until someone looks at where its value comes from.
//
// The app's URL builders are then called with hostile ids (a node, run or
// project id is data) and must still land on the app's own origin. Around
// that: no `srcdoc`, no frame/object/embed element, no script-URL assignment
// from TypeScript, and every `target="_blank"` link carries rel="noopener".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareTabHref } from './components/compare/picker';
import { farmDrawerHref } from './components/crops/farmDrawer';
import { farmHref } from './components/farm/load';
import { noteHref } from './components/notes/notes';
import { runHref } from './components/overview/attention';
import { curtailmentHref } from './components/portfolio/portfolio';
import { riverHref } from './components/river/links';
import { supplyHref } from './components/supply/links';
import { withoutParam, withParam } from './workspace/overlays';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Attributes whose value the browser loads or navigates to. */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'ping', 'xlink:href', 'background', 'cite', 'data']);
/** Schemes a literal URL may name. Everything else (javascript:, data:, vbscript:, file:, …) is refused. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Expressions allowed at the head of a URL attribute, by their leading name
 * (`runHref(meta.id)` → `runHref`, `api.farm.exportUrl(…)` →
 * `api.farm.exportUrl`). The builders marked BUILDER are called with hostile
 * ids in the last test.
 */
const REVIEWED: Record<string, string> = {
	// App URL builders: each returns "?tab=…", "#…" or "{base}/…" with its ids encoded (BUILDER).
	withParam: 'BUILDER: "?" + URLSearchParams of the current page',
	runHref: 'BUILDER: "?tab=runs&run=" + encoded id',
	riverHref: 'BUILDER: "?tab=river…"',
	supplyHref: 'BUILDER: "?" + URLSearchParams',
	farmHref: 'BUILDER: "{base}/farm/" + encoded project id',
	farmDrawerHref: 'BUILDER: "?…farm=" overlay link',
	compareTabHref: 'BUILDER: "?" + URLSearchParams',
	curtailmentHref: 'BUILDER: "{base}/projects/…" (portfolio.ts; the team page wraps it under the same name)',
	// Local builders and constants in the component itself: a literal "?", "#" or "{base}/" head.
	tabHref: 'routes/projects/[id]: "?tab=<TabId>" or the current pathname',
	addDataHref: 'ProjectTable: `${base}/projects/${id}?add=data`',
	projectHref: 'portfolio page: `${base}/projects/${id}`',
	loginHref: 'register page: `${base}/login?next=` + encoded next',
	forgotHref: 'login page: `${base}/forgot-password…`',
	settingsHref: 'team page: withParam(page.url, …)',
	panelHref: 'PublishedBaseline: runHref(…) + "#res-publication" or "?tab=runs"',
	compareHref: 'PublishedBaseline / ScenarioCompare: compareTabHref(…) or "?…"',
	reserveHref: 'RunSummaryView: riverHref(…)',
	previewHref: 'NodeDetail: farmHref(…)',
	main: 'farm why/dam pages: farmHref(…)',
	href: 'the farm page’s href(sub) = farmHref(…), RecentNotes’ noteHref(…), and DamCard/LookingBack’s `href` prop, whose callers are checked here too',
	DAMS_HREF: 'latestRun.ts constant "?tab=dams"',
	ARC4_URL: 'crops/library.ts constant https:// link to the SABI manual',
	pictureSrc: 'help pictures: "/help/<static file name>" from the SHOTS table',
	pictureSrcset: 'help pictures: two pictureSrc paths with widths (help/pictures.ts)',
	// Objects built in code from the builders above.
	'back.href': 'FarmShell prop: callers pass `${base}/farm` or farmHref(…)',
	'preview.href': 'FarmShell prop: FarmPage builds `${base}/projects/<encoded id>?tab=network`',
	'more.href': 'SupplyByFarm / FlowVsReserve prop: OverviewTab passes riverHref / supplyHref',
	'h.href': 'LatestRun: latestRun.ts rows with DAMS_HREF and the builders',
	'it.href': 'NeedsAttention: attention.ts items built from runHref / supplyHref / farmDrawerHref or "?tab=…" literals',
	'it.also.href': 'NeedsAttention: attention.ts, farmDrawerHref',
	'c.href': 'RunSummaryView: credibility.ts "#res-…" anchors',
	// Values that come from outside the component, each checked where it enters.
	'current.url': 'the report PDF link from the API: serverPdf.ts reportsApi.get drops anything but http(s) (serverPdf.test.ts)',
	'api.farm.exportUrl': 'api client: PUBLIC_API_URL (build config) + an encoded path',
	'api.allocations.exportUrl': 'api client: PUBLIC_API_URL (build config) + an encoded path',
	// data: URLs built in code, a synthetic CSV example with a `download` attribute (never user text, never HTML).
	exampleHref: 'EWR editors: `data:text/csv;charset=utf-8,` + encodeURIComponent(synthetic CSV)',
	templateHref: 'AllocationImport: `data:text/csv;charset=utf-8,` + encodeURIComponent(the template CSV)'
};

/** TypeScript that points the page, or an element, at a URL. Only a blob download link is allowed. */
const TS_URL_SINKS =
	/\.(href|src|action|formAction|srcdoc)\s*=(?!=)|\.setAttribute\(\s*['"`](href|src|action|formaction|srcdoc|xlink:href)['"`]|\blocation\s*=(?!=)|\blocation\.(assign|replace)\s*\(|\bwindow\.open\s*\(|['"`]\s*(javascript|vbscript)\s*:/gi;
const TS_URL_SINKS_ALLOWED: Record<string, string> = {
	'lib/export/download.ts': 'saveBlob: a.href = URL.createObjectURL(blob), a blob: URL for a download'
};

function sourceFiles(dir: string, ext: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name), ext);
		if (e.name.endsWith('.test.ts')) return [];
		return ext.test(e.name) ? [join(dir, e.name)] : [];
	});
}

// ---------------------------------------------------------------------------
// A small Svelte markup scanner: tags and their attributes, braces balanced.
// ---------------------------------------------------------------------------

interface Attr {
	/** Lower-cased name; `{name}` shorthand gives its name, a spread gives "...". */
	name: string;
	/** The raw value: `{expr}`, `"text {expr}"`, bare text; null for a bare attribute. */
	value: string | null;
	/** True for `{name}` shorthand. */
	shorthand?: boolean;
}
interface Tag {
	name: string;
	attrs: Attr[];
	text: string;
}

/** The markup of a component: script, style and comments removed. */
function markup(svelte: string): string {
	return svelte
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

/** Index just past the `}` matching the `{` at `i`. */
function skipBraces(s: string, i: number): number {
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '{') depth++;
		else if (s[i] === '}' && --depth === 0) return i + 1;
	}
	return s.length;
}

function tags(html: string): Tag[] {
	const out: Tag[] = [];
	let i = 0;
	while (i < html.length) {
		const ch = html[i]!;
		if (ch === '{') {
			i = skipBraces(html, i);
			continue;
		}
		if (ch !== '<' || !/[A-Za-z]/.test(html[i + 1] ?? '')) {
			i++;
			continue;
		}
		const start = i;
		const name = /^<([A-Za-z][\w:.-]*)/.exec(html.slice(i))![1]!;
		i += name.length + 1;
		const attrs: Attr[] = [];
		while (i < html.length && html[i] !== '>') {
			const c = html[i]!;
			if (/\s|\//.test(c)) {
				i++;
				continue;
			}
			if (c === '{') {
				const end = skipBraces(html, i);
				const inner = html.slice(i + 1, end - 1).trim();
				attrs.push(inner.startsWith('...') ? { name: '...', value: inner } : { name: inner.toLowerCase(), value: `{${inner}}`, shorthand: true });
				i = end;
				continue;
			}
			const an = /^[^\s=>/{]+/.exec(html.slice(i))?.[0] ?? html[i]!;
			i += an.length;
			if (html[i] !== '=') {
				attrs.push({ name: an.toLowerCase(), value: null });
				continue;
			}
			i++;
			let v = '';
			if (html[i] === '{') {
				const end = skipBraces(html, i);
				v = html.slice(i, end);
				i = end;
			} else if (html[i] === '"' || html[i] === "'") {
				const q = html[i]!;
				let j = i + 1;
				while (j < html.length && html[j] !== q) j = html[j] === '{' ? skipBraces(html, j) : j + 1;
				v = html.slice(i + 1, j);
				i = j + 1;
			} else {
				const m = /^[^\s>]+/.exec(html.slice(i))?.[0] ?? '';
				v = m;
				i += m.length;
			}
			attrs.push({ name: an.toLowerCase(), value: v });
		}
		out.push({ name: name.toLowerCase(), attrs, text: html.slice(start, i + 1) });
		i++;
	}
	return out;
}

/** Split an attribute value into literal text and `{expr}` parts. */
function parts(value: string): { lit?: string; expr?: string }[] {
	const out: { lit?: string; expr?: string }[] = [];
	let i = 0;
	while (i < value.length) {
		if (value[i] === '{') {
			const end = skipBraces(value, i);
			out.push({ expr: value.slice(i + 1, end - 1).trim() });
			i = end;
		} else {
			const j = value.indexOf('{', i);
			out.push({ lit: value.slice(i, j < 0 ? value.length : j) });
			i = j < 0 ? value.length : j;
		}
	}
	return out;
}

/** `runHref(meta.id)` → `runHref`, `api.farm.exportUrl(p)` → `api.farm.exportUrl`, `data!` → `data`. */
const headName = (expr: string) => /^[\w$.]+/.exec(expr.replace(/^\(|!$/g, ''))?.[0] ?? expr;

type Verdict = { ok: true } | { ok: false; why: string } | { dynamic: string };

/** How a URL attribute's value decides its scheme. */
function classify(value: string): Verdict {
	let ps = parts(value);
	// `{base}` is the app's base path ("" or "/x", from svelte.config.js): what follows it is the head.
	if (ps[0]?.expr === 'base') ps = ps.slice(1);
	const first = ps[0];
	if (!first) return { ok: true };
	if (first.expr !== undefined) return { dynamic: headName(first.expr) };
	// What the browser reads: it drops ASCII whitespace and control characters, so "java\tscript:" is javascript:.
	const lit = first.lit!.replace(/[\u0000- ]/g, '');
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(lit)?.[1]?.toLowerCase();
	if (scheme && !SAFE_SCHEMES.has(scheme)) return { ok: false, why: `${scheme}: URL` };
	if (/^[/\\]{2}/.test(lit)) return { ok: false, why: 'protocol-relative URL (another host)' };
	// "/{x}": x decides whether it is "//host", so it is the head.
	if (/^[/\\]$/.test(lit) && ps[1]?.expr !== undefined) return { dynamic: headName(ps[1].expr) };
	return { ok: true };
}

interface Found {
	file: string;
	tag: Tag;
	attr: Attr;
}

function scan(): { files: string[]; found: Found[] } {
	const files = sourceFiles(SRC, /\.svelte$/);
	const found = files.flatMap((f) =>
		tags(markup(readFileSync(f, 'utf8'))).flatMap((tag) => tag.attrs.map((attr) => ({ file: f.slice(SRC.length), tag, attr })))
	);
	return { files, found };
}

// `data` is a URL only on <object>, which is banned outright below; elsewhere it is a component prop.
const isUrlAttr = (t: Tag, a: Attr) => URL_ATTRS.has(a.name) && (a.name !== 'data' || t.name === 'object');

describe('URL attributes', () => {
	it('the scanner reads tags, attributes and shorthand, and classifies literal, base-relative and dynamic values', () => {
		const t = tags(markup('<script>const a = "<a href=javascript:x>";</script><a class="x" href="{base}/p/{id}?q={f({ a: 1 })}" {href} {...rest}>x</a>{#if a<b}<img src={s} alt="">{/if}'));
		expect(t.map((x) => x.name)).toEqual(['a', 'img']);
		expect(t[0]!.attrs.map((a) => [a.name, a.value])).toEqual([
			['class', 'x'],
			['href', '{base}/p/{id}?q={f({ a: 1 })}'],
			['href', '{href}'],
			['...', '...rest']
		]);
		expect(classify('{base}/p/{id}')).toEqual({ ok: true });
		expect(classify('?tab=runs&run={id}')).toEqual({ ok: true });
		expect(classify('#{b.id}')).toEqual({ ok: true });
		expect(classify('https://example.org/x')).toEqual({ ok: true });
		expect(classify('mailto:{email}')).toEqual({ ok: true });
		expect(classify('{runHref(meta.id)}')).toEqual({ dynamic: 'runHref' });
		expect(classify('{api.farm.exportUrl(p, n)}')).toEqual({ dynamic: 'api.farm.exportUrl' });
		expect(classify('{base}{pictureSrc(shot)}')).toEqual({ dynamic: 'pictureSrc' });
		expect(classify('{base}/{x}')).toEqual({ dynamic: 'x' });
		expect(classify('/{x}')).toEqual({ dynamic: 'x' });
		// The script URLs, however they are spelled.
		for (const bad of ['javascript:alert(1)', 'JavaScript:{x}', ' java\tscript:x', 'vbscript:x', 'data:text/html,<b>', '//evil.example', '/\\evil.example', '{base}//evil.example']) {
			expect(classify(bad), bad).toMatchObject({ ok: false });
		}
	});

	it('every URL attribute in every component has a literal safe scheme or a reviewed expression', () => {
		const { files, found } = scan();
		// Positive control: the walk reaches the components and sees their links.
		expect(files.length).toBeGreaterThan(100);
		const urls = found.filter((x) => isUrlAttr(x.tag, x.attr) && x.attr.value !== null);
		expect(urls.length).toBeGreaterThan(150);
		expect(urls.some((x) => x.file.endsWith('report/ServerPdf.svelte') && x.attr.value === '{current.url}')).toBe(true);
		const used = new Set<string>();
		const offenders = urls.flatMap(({ file, attr }) => {
			const v = classify(attr.value!);
			if ('dynamic' in v) {
				used.add(v.dynamic);
				return v.dynamic in REVIEWED ? [] : [`${file}: ${attr.name}=${attr.value} (unreviewed expression "${v.dynamic}": add it to REVIEWED with where its value comes from)`];
			}
			return v.ok ? [] : [`${file}: ${attr.name}="${attr.value}" (${v.why})`];
		});
		expect(offenders).toEqual([]);
		// No stale entries: every reviewed head is still in use.
		expect(Object.keys(REVIEWED).filter((k) => !used.has(k))).toEqual([]);
	});

	it('no srcdoc, and no frame, object or embed element', () => {
		const all = sourceFiles(SRC, /\.svelte$/).flatMap((f) => tags(markup(readFileSync(f, 'utf8'))).map((tag) => ({ file: f.slice(SRC.length), tag })));
		// Positive control: the walk sees plain elements.
		expect(all.some(({ tag }) => tag.name === 'a')).toBe(true);
		const offenders = all.flatMap(({ file, tag }) => [
			...(tag.attrs.some((a) => a.name === 'srcdoc') ? [`${file}: srcdoc on <${tag.name}>`] : []),
			...(/^(iframe|frame|frameset|object|embed|portal)$/.test(tag.name) ? [`${file}: <${tag.name}>`] : [])
		]);
		expect(offenders).toEqual([]);
		// The check itself.
		expect(tags('<iframe srcdoc="<b>x</b>"></iframe>').map((t) => [t.name, t.attrs[0]?.name])).toEqual([['iframe', 'srcdoc']]);
	});

	it('every link that opens a new tab carries rel="noopener" (or noreferrer)', () => {
		const { found } = scan();
		const blanks = found.filter(({ tag, attr }) => /^(a|area|form)$/.test(tag.name) && attr.name === 'target' && attr.value !== '_self');
		// Positive control: the one external link (the SABI manual) is seen.
		expect(blanks.some((b) => b.file.endsWith('crops/LoadCropFactorsDialog.svelte'))).toBe(true);
		const offenders = blanks
			.filter(({ tag }) => {
				const rel = tag.attrs.find((a) => a.name === 'rel')?.value ?? '';
				return !/\bno(opener|referrer)\b/.test(rel);
			})
			.map(({ file, tag }) => `${file}: ${tag.text}`);
		expect(offenders).toEqual([]);
		// The check itself: a bare target=_blank fails it, rel="noopener" passes.
		const [bad, good] = tags('<a href="https://x.example" target="_blank">x</a><a href="https://x.example" target="_blank" rel="noopener">x</a>');
		expect(bad!.attrs.some((a) => a.name === 'rel')).toBe(false);
		expect(good!.attrs.find((a) => a.name === 'rel')?.value).toBe('noopener');
	});

	it('no TypeScript points the page or an element at a URL, except the blob download link', () => {
		expect('a.href = x'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('el.setAttribute("src", x)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('window.location = next'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('location.assign(next)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect('window.open(u)'.match(TS_URL_SINKS)).toHaveLength(1);
		expect(`const u = 'javascript:void 0'`.match(TS_URL_SINKS)).toHaveLength(1);
		expect('if (a.href === b) {}'.match(TS_URL_SINKS)).toBeNull();
		expect('const href = runHref(id)'.match(TS_URL_SINKS)).toBeNull();
		const files = sourceFiles(SRC, /\.(svelte|ts|js)$/);
		const hits = files.flatMap((f) => {
			const rel = f.slice(SRC.length);
			const text = f.endsWith('.svelte') ? [...readFileSync(f, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n') : readFileSync(f, 'utf8');
			return (text.match(TS_URL_SINKS) ?? []).map((m) => ({ rel, m }));
		});
		// Positive control: the download helper's blob link is found (and allowed).
		expect(hits.some((h) => h.rel === 'lib/export/download.ts')).toBe(true);
		expect(hits.filter((h) => !(h.rel in TS_URL_SINKS_ALLOWED)).map((h) => `${h.rel}: ${h.m}`)).toEqual([]);
	});

	it('the URL builders keep a hostile id on the app’s own origin', () => {
		const origin = 'https://app.example';
		const page = new URL(`${origin}/projects/p1?tab=network&view=map#top`);
		const lands = (href: string) => new URL(href, page).origin;
		const hostile = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example', '/\\evil.example', '\t//evil.example', 'https://evil.example/', '"><img src=x onerror=alert(1)>'];
		for (const id of hostile) {
			const hrefs = [
				withParam(page, 'dam', id),
				withoutParam(page, id),
				runHref(id),
				riverHref(id, 'res-flow'),
				supplyHref(id, { unit: id, window: id }),
				farmHref('', id, id, true, 'dam'),
				farmHref('/app', id, id, true),
				farmDrawerHref(null, id),
				compareTabHref({ projectId: id, runId: id }, { projectId: id, runId: id }),
				curtailmentHref({ id, sourceRunId: id }),
				noteHref({ target: 'node', nodeId: id, runId: null, settingKey: null }) ?? '',
				noteHref({ target: 'run', nodeId: null, runId: id, settingKey: null }) ?? ''
			];
			for (const h of hrefs) expect(lands(h), `${JSON.stringify(id)} → ${h}`).toBe(origin);
		}
		// Positive control: the check tells an off-site link from an app one.
		expect(lands('//evil.example/x')).not.toBe(origin);
		expect(lands('?tab=runs')).toBe(origin);
	});
});
