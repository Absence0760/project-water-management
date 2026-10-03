// Summary of snap-junction-side.ts's results (docs/design/delineation-snapping.md § Beside a confluence):
// wrong-side placements by distance from the junction and by river, before and after, and how far each moved the click.
//
//   tsx scripts/research/snap-junction-side-summary.ts <results.json>
import { readFileSync } from 'node:fs';

type Placed = { side: string; km2: number | null; movedM: number | null; how?: string };
type Click = { arm: 'main' | 'trib' | 'below'; alongM: number; toJunctionM: number; asked: boolean; before: Placed; match: Placed; after: Placed };
const data = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { results: { found: boolean; demJunctionM?: number; clicks?: Click[] }[] };
const found = data.results.filter((r) => r.found);
const clicks = found.flatMap((r) => r.clicks ?? []);
console.log(`${data.results.length} junctions, the DEM's junction found at ${found.length}; ${clicks.length} clicks`);
const dj = found.map((r) => r.demJunctionM!).sort((a, b) => a - b);
const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : NaN);
console.log(`The DEM's junction from the mapped one: median ${q(dj, 0.5)} m, 75th ${q(dj, 0.75)} m, 90th ${q(dj, 0.9)} m, max ${dj.at(-1)} m\n`);
const wrong = (c: Click, w: 'before' | 'match' | 'after') => c[w].side !== c.arm;
const pct = (n: number, d: number) => (d ? `${n}/${d}` : '–');
const alongs = [...new Set(clicks.map((c) => c.alongM))].sort((a, b) => a - b);
console.log('| Along the river (m) | asked | main above: before → after | tributary: before → after | river below: before → after |');
console.log('| --- | --- | --- | --- | --- |');
for (const a of alongs) {
	const at = clicks.filter((c) => c.alongM === a);
	const cell = (arm: Click['arm']) => {
		const xs = at.filter((c) => c.arm === arm);
		return `${pct(xs.filter((c) => wrong(c, 'before')).length, xs.length)} → ${pct(xs.filter((c) => wrong(c, 'after')).length, xs.length)}`;
	};
	console.log(`| ${a} | ${at.filter((c) => c.asked).length}/${at.length} | ${cell('main')} | ${cell('trib')} | ${cell('below')} |`);
}
const tot = (w: 'before' | 'after', f: (c: Click) => boolean) => {
	const xs = clicks.filter(f);
	return pct(xs.filter((c) => wrong(c, w)).length, xs.length);
};
console.log(`\nNot asked (beyond CONFLUENCE_M): wrong side before ${tot('before', (c) => !c.asked)}, after ${tot('after', (c) => !c.asked)}`);
console.log(`Asked: before ${tot('before', (c) => c.asked)}, after ${tot('after', (c) => c.asked)}`);
const hows = new Map<string, number>();
for (const c of clicks) hows.set(c.after.how ?? '', (hows.get(c.after.how ?? '') ?? 0) + 1);
console.log(`After, how: ${[...hows].map(([h, n]) => `${h} ${n}`).join(', ')}`);
const wrongAfter = clicks.filter((c) => wrong(c, 'after'));
console.log(`After, wrong: ${wrongAfter.map((c) => `${c.arm}@${c.alongM}→${c.after.side} (${c.after.how})`).join('; ')}`);
// How far the click moved, by placement.
const moves = (w: 'before' | 'after', f: (c: Click) => boolean) => clicks.filter(f).map((c) => c[w].movedM).filter((m): m is number => m !== null).sort((a, b) => a - b);
for (const [label, f] of [
	['asked (0–200 m)', (c: Click) => c.asked],
	['not asked', (c: Click) => !c.asked]
] as const) {
	for (const w of ['before', 'after'] as const) {
		const m = moves(w, f);
		console.log(`Moved, ${label}, ${w}: median ${q(m, 0.5)} m, 90th ${q(m, 0.9)} m, max ${m.at(-1)} m; over 500 m ${m.filter((x) => x > 500).length}/${m.length}`);
	}
}
