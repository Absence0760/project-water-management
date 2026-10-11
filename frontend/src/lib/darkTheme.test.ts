// The dark theme's static guards (issue #521, round 4's dark-mode audit; ui-playbook.md § 3):
// - No copy names a thing by a colour the theme changes ("Darker cells are months of higher demand" read
//   backwards on the dark page, where a higher demand is a brighter teal; "the red lines" are orange-red).
// - No dark block keyed on [data-theme='dark']: nothing sets it (the OS preference is the only switch; the
//   print theme sets data-theme='light'), so such a block is dead code that suggests a toggle.
// - Overlays take their shadow from the tokens (--overlay-shadow, --popover-shadow), which deepen in dark,
//   not a literal 20 % black that vanishes on a near-black page; the save bar's upward shadow is --bar-shadow.
//   No workspace component writes a black shadow literal at all (round 6 found two popovers and the save bar
//   the old pattern missed), the help pictures' markers aside: they sit on the picture, in fixed colours.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMENTS = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(^|[^:'"`])\/\/.*$/gm;

function files(dir: string, ext: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return e.name === '__fixtures__' ? [] : files(join(dir, e.name), ext);
		return ext.test(e.name) && !e.name.includes('.test.') ? [join(dir, e.name)] : [];
	});
}
const read = (ext: RegExp) => files(ROOT, ext).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8').replace(COMMENTS, '$1') }));
const svelte = read(/\.svelte$/);
const copy = read(/\.(svelte|ts)$/);

/** A colour word naming something on screen: "the red lines", "darker cells", "green = better". */
const COLOUR_NAMED = /\b(?:the (?:red|green|blue|orange|grey|gray|purple) (?:lines?|bars?|cells?|dots?|areas?)|(?:darker|lighter) (?:cells?|bars?|lines?|shades?)|(?:green|red|grey|gray) = (?:better|worse|no))/i;

describe('the dark theme (issue #521)', () => {
	it('the colour-word pattern finds the old lines and passes their replacements', () => {
		expect(COLOUR_NAMED.test('Darker cells are months of higher demand.')).toBe(true);
		expect(COLOUR_NAMED.test('the nearest terrain channel (the red lines), within 150 m')).toBe(true);
		expect(COLOUR_NAMED.test('▲ up, ▼ down; green = better, red = worse')).toBe(true);
		expect(COLOUR_NAMED.test("The stronger a cell's shade, the higher that month's demand.")).toBe(false);
		expect(COLOUR_NAMED.test("terrain channels in the map's key")).toBe(false);
	});

	it('no copy names a thing by its colour', () => {
		expect(copy.filter((f) => COLOUR_NAMED.test(f.text)).map((f) => f.path)).toEqual([]);
	});

	it('no dark block is keyed on data-theme="dark"', () => {
		expect(svelte.filter((f) => /data-theme\s*=\s*['"]?dark/.test(f.text)).map((f) => f.path)).toEqual([]);
	});

	it('popovers and dialogs take their shadow from the overlay tokens', () => {
		const literal = /box-shadow:[^;]*rgba?\(\s*0[\s,]+0[\s,]+0\b/;
		expect(literal.test('box-shadow: 0 -2px 8px rgb(0 0 0 / 0.08);')).toBe(true);
		expect(literal.test('box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);')).toBe(true);
		expect(literal.test('box-shadow: var(--popover-shadow);')).toBe(false);
		expect(literal.test('box-shadow: inset 0 -2px 0 var(--accent);')).toBe(false);
		// The landing page is its own design (a fixed dusk or daylight hero), not the workspace's overlays. The help
		// pictures' markers and rings sit on the picture, not the page: in those two files a rule drawn in fixed
		// colours (a hex value) may keep its dark halo; their popovers, in the theme's tokens, can't.
		const PICTURES = ['lib/components/help/PictureTour.svelte', 'lib/components/help/HelpTip.svelte'];
		const text = (f: { path: string; text: string }) => (PICTURES.includes(f.path) ? f.text.replace(/\{[^{}]*#[0-9a-f]{3,6}\b[^{}]*\}/gi, '{}') : f.text);
		expect(svelte.filter((f) => !f.path.startsWith('lib/components/landing/') && literal.test(text(f))).map((f) => f.path)).toEqual([]);
		const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
		for (const token of ['--overlay-backdrop', '--overlay-border', '--overlay-shadow', '--popover-shadow', '--bar-shadow']) expect(css.split(token).length - 1, token).toBe(2);
	});
});
