#!/usr/bin/env node
// Writes the landing page's generated module (issue #57) from the art
// pipeline's outputs: bin/gen-landing-art.sh runs it last.
//
//   node scripts/landing-art/modules.mjs <workdir> <vectordir> <out.ts>
//
// <workdir> holds diorama.py's overlay.json, the hero's size (hero.json) and
// its blurred placeholders (placeholder-{day,dusk}.webp), and screens.json
// (each framed screen's size). <vectordir> holds the icons and the river
// divider as plain SVG (Inkscape's --export-plain-svg with every object
// turned into a path). The page draws the icons from their path data, so they
// can draw themselves on (stroke-dashoffset) and follow the theme's colours.
// It also records the contour texture's size (contours.py's viewBox, read from
// frontend/static/landing/contours.svg), which the page's <svg> needs to draw it.
// Dependency-free: the SVGs are Inkscape's plain output, read with a few
// regular expressions rather than a parser. It also refuses a hero whose edges
// hold anything (assertUnclipped): the block ran off the camera's frame.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [work, vector, out] = process.argv.slice(2);
if (!work || !vector || !out) {
	console.error('usage: node modules.mjs <workdir> <vectordir> <out.ts>');
	process.exit(2);
}

const json = (name) => JSON.parse(readFileSync(join(work, name), 'utf8'));
const dataUri = (name) => `data:image/webp;base64,${readFileSync(join(work, name)).toString('base64')}`;

/** One attribute of a tag, from the attribute or from its style="". */
function attr(tag, name) {
	const direct = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	if (direct) return direct[1];
	const style = /\sstyle="([^"]*)"/.exec(tag)?.[1] ?? '';
	return new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style)?.[1]?.trim();
}

const num = (tag, name) => Number(attr(tag, name) ?? 0);

/** A circle or rounded rect as path data, for a source that hasn't been through Inkscape's object-to-path. */
function shapePath(tag) {
	if (tag.startsWith('<circle')) {
		const [cx, cy, r] = [num(tag, 'cx'), num(tag, 'cy'), num(tag, 'r')];
		return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
	}
	const [x, y, w, h, rx] = [num(tag, 'x'), num(tag, 'y'), num(tag, 'width'), num(tag, 'height'), num(tag, 'rx')];
	const r = Math.min(rx, w / 2, h / 2);
	return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

/** Every drawn element of an icon: its path data, whether it's the accent, and its dash. */
function paths(file) {
	const svg = readFileSync(join(vector, file), 'utf8');
	const accentColour = '#1e9bb8';
	return [...svg.matchAll(/<(path|circle|rect)\b[^>]*>/g)].map(([tag]) => {
		const d = tag.startsWith('<path') ? attr(tag, 'd') : shapePath(tag);
		const stroke = (attr(tag, 'stroke') ?? '').toLowerCase();
		const cls = attr(tag, 'class') ?? '';
		const dash = attr(tag, 'stroke-dasharray');
		const p = { d: d.replace(/\s+/g, ' ').trim(), accent: cls.split(/\s+/).includes('accent') || stroke === accentColour };
		if (dash && dash !== 'none') p.dash = dash.replace(/,/g, ' ');
		return p;
	});
}

/**
 * The hero is trimmed to the block with a margin, on a transparent ground, so
 * its outermost rows and columns must be empty. Anything there means the
 * block ran off the camera's frame and was cut (diorama.py's HERO camera: at
 * 42 mm the front corner was). The bytes are ImageMagick's to read, as the
 * rest of the pipeline's are.
 */
function assertUnclipped(png) {
	const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', png], { encoding: 'utf8' }).trim().split(' ').map(Number);
	const edges = { top: `${w}x1+0+0`, bottom: `${w}x1+0+${h - 1}`, left: `1x${h}+0+0`, right: `1x${h}+${w - 1}+0` };
	const cut = Object.entries(edges).filter(([, geometry]) => {
		const max = execFileSync('magick', [png, '-alpha', 'extract', '-crop', geometry, '+repage', '-format', '%[fx:maxima*255]', 'info:'], { encoding: 'utf8' });
		return Math.round(Number(max)) > 0;
	});
	if (cut.length) {
		console.error(`modules: ${png} has picture on its ${cut.map(([e]) => e).join(', ')} edge: the diorama runs off the hero camera's frame (widen HERO in diorama.py)`);
		process.exit(1);
	}
}
for (const mode of ['day', 'dusk']) assertUnclipped(join(work, `hero-${mode}.png`));

/** The contour texture's viewBox size: the page draws it through <use>, in an <svg> of the same shape. */
function contoursSize() {
	const svg = readFileSync(new URL('../../frontend/static/landing/contours.svg', import.meta.url), 'utf8');
	const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
	return { width, height };
}

const ICONS = ['hydrologist', 'association', 'licensing', 'farmer'];
const hero = json('hero.json');
const art = {
	hero: {
		...hero,
		placeholder: { day: dataUri('placeholder-day.webp'), dusk: dataUri('placeholder-dusk.webp') }
	},
	overlay: json('overlay.json'),
	screens: existsSync(join(work, 'screens.json')) ? json('screens.json') : {},
	icons: Object.fromEntries(ICONS.map((name) => [name, paths(`icon-${name}.svg`)])),
	river: paths('river-divider.svg')[0].d,
	contours: contoursSize()
};

writeFileSync(
	out,
	`// Generated by \`pnpm gen:landing-art\` (bin/gen-landing-art.sh, scripts/landing-art/modules.mjs).
// Don't edit by hand: change the sources in scripts/landing-art/ and rerun it.
// The hero render's size and blurred placeholders, where the scene's rivers,
// dams, clouds and gauge fall in it (% of the picture), each framed app
// screen's size, the icons' and river divider's path data, and the contour
// texture's size.
/* eslint-disable */
export const ART = ${JSON.stringify(art, null, '\t')};
`
);
console.log(`modules: ${out}`);
