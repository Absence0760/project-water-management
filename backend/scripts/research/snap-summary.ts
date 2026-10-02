// Summarise a snap-methods.ts run as Markdown tables (docs/research/delineation-snapping.md):
//   tsx scripts/research/snap-summary.ts <results.json>
// A pick is scored against the reach's HydroRIVERS upstream area: ok within ½–2×, a gully under 0.1×, short 0.1–½×,
// a jump over 2×; a catchment cut at the window with under ½× is inconclusive (its area is only a lower bound).
// On main stems (no reference fits the window) a pick is ok when it is on the trunk (≥ ½ the biggest accumulation within 1 km).
import { readFileSync } from 'node:fs';
import pg from 'pg';

interface PickR {
	method: string;
	km2: number | null;
	ratio: number | null;
	edge?: boolean;
	distM: number | null;
	flagged: boolean;
	onTrunk?: boolean | null;
	at?: [number, number];
}
interface R {
	reach: string;
	stratum: string;
	refKm2: number;
	channelM: number | null;
	wbmPixels: number;
	wbmNearestM: number | null;
	picks: PickR[];
}

const file = process.argv[2];
if (!file) throw new Error('usage: snap-summary.ts <results.json>');
const data = JSON.parse(readFileSync(file, 'utf8')) as { results: (R & { skipped?: string })[]; seed: string; window: number; zoom: number; dataset: string };
const rs = data.results.filter((r) => !r.skipped);
// Each picked cell's distance from the clicked reach's own line (HydroRIVERS, densified): over 1 km it is likely another river.
const lineOf = new Map<string, [number, number][]>();
if (process.env.MIGRATION_DATABASE_URL) {
	const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
	await db.connect();
	const { rows } = await db.query(`SELECT reach_id::text AS id, geometry->'coordinates' AS c FROM river_reference WHERE dataset = 'HydroRIVERS-v10' AND reach_id = ANY($1::bigint[])`, [rs.map((r) => r.reach)]);
	for (const r of rows) lineOf.set(r.id, r.c);
	await db.end();
}
function lineDistM(reach: string, at: [number, number] | undefined): number | null {
	const line = lineOf.get(reach);
	if (!line || !at) return null;
	const kx = 111320 * Math.cos((at[1] * Math.PI) / 180);
	const ky = 110950;
	let best = Infinity;
	for (let i = 0; i + 1 < line.length; i++) {
		const [ax, ay] = [(line[i]![0] - at[0]) * kx, (line[i]![1] - at[1]) * ky];
		const [bx, by] = [(line[i + 1]![0] - at[0]) * kx, (line[i + 1]![1] - at[1]) * ky];
		const dx = bx - ax;
		const dy = by - ay;
		const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
		best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
	}
	return best;
}
type Cat = 'ok' | 'gully' | 'short' | 'jump' | 'none' | 'inconclusive';
function cat(r: R, p: PickR): Cat {
	if (p.km2 === null || p.ratio === null) return 'none';
	if (r.stratum === 'main') return p.onTrunk ? 'ok' : p.ratio < 0.1 || (p.km2 ?? 0) < 1 ? 'gully' : 'short';
	if (p.ratio >= 0.5 && p.ratio <= 2) return 'ok';
	if (p.ratio > 2) return 'jump';
	if (p.edge) return 'inconclusive';
	return p.ratio < 0.1 ? 'gully' : 'short';
}
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} %` : '–');
const q = (xs: number[], f: number) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
};
const m = (v: number | null) => (v === null ? '–' : `${Math.round(v)} m`);

console.log(`Run: seed \`${data.seed}\`, ${rs.length} reaches, window ${data.window} cells at zoom ${data.zoom}, ${data.dataset}.\n`);
const strata = ['small', 'medium', 'large', 'main'];
const methods = rs[0]!.picks.map((p) => p.method);
for (const st of strata) {
	const g = rs.filter((r) => r.stratum === st);
	if (!g.length) continue;
	const ch = g.map((r) => r.channelM).filter((x): x is number => x !== null);
	const mask = g.filter((r) => r.wbmPixels > 0);
	console.log(`### ${st} (${g.length} reaches${st === 'main' ? ', Strahler ≥ 7 / ≥ 20 000 km²' : `, ${Math.round(Math.min(...g.map((r) => r.refKm2)))}–${Math.round(Math.max(...g.map((r) => r.refKm2)))} km²`})\n`);
	if (st !== 'main') {
		console.log(
			`The DEM's matching channel (nearest cell within 50 % of the reference area, ≤ 2.5 km): found for ${ch.length} of ${g.length}; distance from the clicked line median ${m(q(ch, 0.5))}, 75th percentile ${m(q(ch, 0.75))}, 90th ${m(q(ch, 0.9))}; beyond 150 m for ${pct(ch.filter((d) => d > 150).length, ch.length)}.`
		);
	}
	console.log(`Water Body Mask pixels within 1.2 km: ${mask.length} of ${g.length}${mask.length ? `; nearest median ${m(q(mask.map((r) => r.wbmNearestM!).filter((x) => x !== null), 0.5))}` : ''}.\n`);
	console.log('| Method | ok | gully (< 0.1×) | short | jump (> 2×) | none / flagged | inconclusive | median move | ok but > 1 km off the reach |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const meth of methods) {
		const cs = g.map((r) => {
			const p = r.picks.find((x) => x.method === meth)!;
			return { c: cat(r, p), p };
		});
		const n = (c: Cat) => cs.filter((x) => x.c === c).length;
		const flagged = cs.filter((x) => x.p.flagged).length;
		const moves = cs.map((x) => x.p.distM).filter((x): x is number => x !== null);
		const off = cs.filter((x, i) => x.c === 'ok' && (lineDistM(g[i]!.reach, x.p.at) ?? 0) > 1000).length;
		console.log(
			`| ${meth} | ${pct(n('ok'), g.length)} | ${pct(n('gully'), g.length)} | ${pct(n('short'), g.length)} | ${pct(n('jump'), g.length)} | ${pct(Math.max(n('none'), flagged), g.length)} | ${pct(n('inconclusive'), g.length)} | ${m(q(moves, 0.5))} | ${lineOf.size ? pct(off, g.length) : '–'} |`
		);
	}
	// The guard: of today's wrong snaps, how many it flags; of today's right ones, how many it flags for nothing.
	const today = g.map((r) => ({ c: cat(r, r.picks[0]!), f: r.picks.find((p) => p.method.startsWith('M4'))!.flagged }));
	const wrong = today.filter((x) => x.c === 'gully' || x.c === 'short');
	const right = today.filter((x) => x.c === 'ok');
	console.log(`\nM4's guard: flags ${wrong.filter((x) => x.f).length} of today's ${wrong.length} short or gully snaps (${pct(wrong.filter((x) => x.f).length, wrong.length)}), and ${right.filter((x) => x.f).length} of its ${right.length} right ones (false alarms ${pct(right.filter((x) => x.f).length, right.length)}).\n`);
}
