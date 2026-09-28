// Every CSV download neutralises user-controlled text (docs/security.md §
// CSV exports defuse spreadsheet formulas). The inventory is the live route
// table (every GET whose path ends in .csv), so a new CSV route fails here
// until it is added to the sweep. One project is seeded with formula-looking
// text in every field a CSV can carry: the project, farm, run label, run
// notes, the notes' author, a series name and unit, and an allocation's
// registration number, holder and reference. Each file is then parsed as
// RFC 4180 and every text cell checked: nothing starts with = + - @ tab or
// CR unless it is a plain number, and quoting holds (no bare quote in an
// unquoted field, no unterminated field). Positive controls: the hostile
// strings do reach the files (apostrophe-prefixed), and an ordinary name with
// a comma and quotes round-trips unchanged.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

/** Text a spreadsheet runs as a formula, in the fields the exports carry (synthetic). */
const EVIL = {
	project: '=HYPERLINK("http://example.invalid","project")',
	farm: '=cmd|\' /C calc\'!A0',
	farm2: '+SUM(1,2)',
	gauge: '@SUM(A1)',
	runLabel: '-2+3+cmd|\' /C calc\'!A0',
	notes: '=1+1, "quoted"\nsecond line',
	author: '@Mallory',
	seriesName: '=series',
	registrationNo: '=REG-1',
	holder: '+Holder',
	reference: '@ref, "x"'
} as const;
/** An ordinary name with a comma and quotes: must come back exactly (the positive control). */
const PLAIN = 'Plain farm, "north"';

/** A formula trigger at the start of a cell (OWASP CSV injection). */
const TRIGGER = /^[=+\-@\t\r]/;
/** A number exactly as the exports write one (String(n)): -12.5 is data, not a formula. */
const isNumber = (s: string) => s !== '' && Number.isFinite(Number(s)) && String(Number(s)) === s;

/** RFC 4180 parse that fails on broken quoting instead of guessing. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let i = 0;
	while (i < text.length) {
		let cell = '';
		if (text[i] === '"') {
			i++;
			for (;;) {
				const q = text.indexOf('"', i);
				if (q < 0) throw new Error('unterminated quoted field');
				cell += text.slice(i, q);
				if (text[q + 1] === '"') {
					cell += '"';
					i = q + 2;
				} else {
					i = q + 1;
					break;
				}
			}
			if (i < text.length && text[i] !== ',' && text[i] !== '\r') throw new Error(`text after a closing quote: ${JSON.stringify(text.slice(i, i + 20))}`);
		} else {
			let j = i;
			while (j < text.length && text[j] !== ',' && text[j] !== '\r' && text[j] !== '\n') j++;
			cell = text.slice(i, j);
			if (cell.includes('"')) throw new Error(`bare quote in an unquoted field: ${JSON.stringify(cell)}`);
			i = j;
		}
		row.push(cell);
		if (text[i] === ',') {
			i++;
			continue;
		}
		if (text[i] === '\r') {
			if (text[i + 1] !== '\n') throw new Error('bare CR ends a record');
			i += 2;
		} else if (text[i] === '\n') throw new Error('bare LF ends a record (the exports use CRLF)');
		rows.push(row);
		row = [];
	}
	return rows;
}

/** Cells that would run as a formula when the file is opened. */
const live = (cells: string[]) => cells.filter((c) => TRIGGER.test(c) && !isNumber(c));

let owner: User;
let projectId: string;
let runId: string;
let seriesId: string;
const gauge = node(EVIL.gauge, null);
const farm = node(EVIL.farm, gauge.id, { damCapacityM3: 200_000 });
const farm2 = node(EVIL.farm2, farm.id, { damCapacityM3: 50_000 });
const plain = node(PLAIN, gauge.id, { damCapacityM3: 50_000 });

beforeAll(async () => {
	owner = await signUp('Owner');
	expect((await owner.call('PATCH', '/auth/me', { displayName: EVIL.author })).status).toBe(200);
	const { body } = await owner.call('POST', '/projects', { name: EVIL.project });
	projectId = body.project.id;
	await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(500) } });
	const crop = { id: crypto.randomUUID(), name: '=crop', cropFactor: monthly(0.7) };
	const model = {
		nodes: [gauge, farm, farm2, plain],
		crops: [crop],
		cropAreas: [farm, farm2, plain].map((n) => ({ nodeId: n.id, cropId: crop.id, areaM2: 20_000 })),
		transfers: []
	};
	const m = await owner.call('PUT', `/projects/${projectId}/model`, model);
	expect(m.status, JSON.stringify(m.body)).toBe(200);
	const rain = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: rain })).status).toBeLessThan(300);
	const put = await owner.call('PUT', `/projects/${projectId}/series`, {
		kind: 'flow_observed_m3s',
		name: EVIL.seriesName,
		unit: 'm3/s',
		startDate: '2024-01-01',
		values: rain.map((r) => 0.01 + r / 1000)
	});
	expect(put.status).toBeLessThan(300);
	seriesId = put.body.id;
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: EVIL.runLabel });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('PATCH', `/projects/${projectId}/runs/${runId}`, { notes: EVIL.notes })).status).toBe(200);
	const alloc = await owner.call('POST', `/projects/${projectId}/allocations`, {
		nodeId: farm.id,
		registrationNo: EVIL.registrationNo,
		holder: EVIL.holder,
		authorisation: 'licence',
		waterSource: 'surface',
		volumeM3PerYear: 1,
		reference: EVIL.reference
	});
	expect(alloc.status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
});

/** The URLs that exercise each CSV route, every node for the per-node ones. */
const SWEEP: Record<string, () => string[]> = {
	'/projects/:id/runs/:runId/export/daily.csv': () => [
		`/projects/${projectId}/runs/${runId}/export/daily.csv`,
		...[gauge, farm, farm2, plain].map((n) => `/projects/${projectId}/runs/${runId}/export/daily.csv?nodeId=${n.id}`)
	],
	'/projects/:id/runs/:runId/export/farms.csv': () => [`/projects/${projectId}/runs/${runId}/export/farms.csv?key=runoff`],
	'/projects/:id/runs/:runId/export/summary.csv': () => [`/projects/${projectId}/runs/${runId}/export/summary.csv`],
	'/projects/:id/series/:seriesId/export.csv': () => [`/projects/${projectId}/series/${seriesId}/export.csv`],
	'/projects/:id/allocations/export.csv': () => [`/projects/${projectId}/allocations/export.csv`],
	'/projects/:id/farm/:nodeId/export.csv': () => [farm, plain].map((n) => `/projects/${projectId}/farm/${n.id}/export.csv`)
};

async function download(path: string): Promise<string> {
	const res = await app.request(path, { headers: { cookie: owner.cookie, origin: ORIGIN } });
	expect(res.status, path).toBe(200);
	expect(res.headers.get('content-type'), path).toBe('text/csv; charset=utf-8');
	expect(res.headers.get('content-disposition'), path).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()).replace(/^﻿/, '');
}

describe('CSV exports neutralise user text (formula injection, RFC 4180 quoting)', () => {
	it('sweeps every CSV route in the live route table', () => {
		const csvRoutes = [...new Set(app.routes.filter((r) => r.method === 'GET' && r.path.endsWith('.csv')).map((r) => r.path))].sort();
		// Positive control: the inventory finds the known routes.
		expect(csvRoutes).toContain('/projects/:id/runs/:runId/export/summary.csv');
		expect(csvRoutes).toEqual(Object.keys(SWEEP).sort());
	});

	it('the checks catch a live formula and broken quoting (the checks work)', () => {
		expect(live(['=1+1', '-12.5', "'=1+1", 'Dam = full', '\tx', '-dam'])).toEqual(['=1+1', '\tx', '-dam']);
		expect(() => parseCsv('a,b"c\r\n')).toThrow(/bare quote/);
		expect(() => parseCsv('"a\r\n')).toThrow(/unterminated/);
		expect(() => parseCsv('"a"b\r\n')).toThrow(/after a closing quote/);
		expect(parseCsv('"a, ""b"""\r\nx,\r\n')).toEqual([['a, "b"'], ['x', '']]);
	});

	it('writes no live formula in any cell, quotes cleanly, and still carries the text', async () => {
		const seen = new Set<string>();
		for (const [route, urls] of Object.entries(SWEEP)) {
			for (const url of urls()) {
				const rows = parseCsv(await download(url));
				expect(rows.length, url).toBeGreaterThan(1);
				const cells = rows.flat();
				expect(live(cells), `${route}: ${url}`).toEqual([]);
				for (const c of cells) seen.add(c);
			}
		}
		const all = [...seen];
		// Positive controls: each hostile string reached some file, defused
		// where it leads a cell (a cell of its own, or a farm's column
		// header), and the ordinary name came back exactly as typed.
		for (const [field, text] of Object.entries(EVIL)) {
			if (field === 'project') continue; // only in file names, which are slugged
			if (field === 'seriesName') {
				// Never leads: the header is "<kind> – <name> (<unit>)".
				expect(all.some((c) => c.startsWith('flow_observed_m3s – ') && c.includes(text)), field).toBe(true);
				continue;
			}
			expect(all.some((c) => c === `'${text}` || c.startsWith(`'${text} `)), field).toBe(true);
		}
		expect(all.some((c) => c === PLAIN || c.startsWith(`${PLAIN} [`)), 'plain name round-trips').toBe(true);
	});
});
