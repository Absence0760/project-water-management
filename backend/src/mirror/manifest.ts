// A mirror product's manifest, `<product>/manifest.json` beside its array
// (issue #604, "Manifest spec"): what the copy holds, which upstream file
// each part came from, and each revision's changes.
//
//   { product, revision, region {w,s,e,n}, grid {origin {lat,lon}, step},
//     years {first,last} (both null while nothing is held), finalThrough, prelimThrough,
//     files [{ url, etag, lastModified, size, valuesSha256, revision, fetchedAt, version? }],
//     changes [{ revision, days [from,to], cellsChanged, maxAbsDiff }] }
//
// `revision` counts from 1 and moves only on a real change of values (D8).
// `valuesSha256` hashes the region subset of one file's values: float32
// little-endian in (day, lat, lon) C order, NaN as 0x7FC00000 (manifestHash).
// The Python ingest (ingest/manifest.py) writes the same shape; both sides
// validate it on read.
//
// For the finals products (`rnl`, `sat`) each file is one of CHC's byMonth
// files, its URL naming its month, and `finalThrough` may not run past the
// contiguous run of months from the first one copied (finalsCoverage): a
// month missing in between (a partial backfill plus the newest month) is not
// held, and reading its days as final would cache NaN as final no-data for
// good. The ingest writes `finalThrough` as that run's end; a manifest that
// claims more is refused here.
//
// Per product (grid.ts PRODUCT_GRIDS): `grid.step` is the product's (0.05 for
// CHIRPS, 0.1 for `era5l` and `imerg_late`), and the days it may hold:
//   rnl, era5l   finalThrough only;  sat  finalThrough and prelimThrough;
//   prelim, gefs/<issue>, imerg_late  no finalThrough. IMERG Late is never
//                final: its days run through prelimThrough (a new version
//                of a day, or a reprocessing, is a revision with a change).
// `imerg_late`'s files are one a day, each URL naming its day as GPM's daily
// granule names do (`3IMERG.YYYYMMDD-S000000-E235959.`), each optionally
// with the IMERG collection `version` it came from (`V07`, later `V08`; the
// minor letter stays in the URL), the per-day version the bias correction is
// fitted by (D16). `prelimThrough` may not run past the contiguous run of
// days from the first file (imergCoverage), as finalThrough may not for the
// CHIRPS finals. No other product's file carries a version. `era5l`'s files
// are its CDS month requests (ingest/era5land.py), each URL exactly
// `cds://reanalysis-era5-land/total_precipitation/YYYY-MM` with no ETag or
// Last-Modified (the CDS gives none). Month M's request holds the 00 UTC
// steps of M's days, the totals of the last day of M−1 through the
// second-last day of M (era5lWrittenDays; the 1950-01 request starts at the
// record, 1950-01-01), and `finalThrough` may not run past the contiguous run
// of those days from the earliest month (era5lCoverage).
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { fromEpochDay, isIsoDate, toEpochDay } from '@water-management/engine/calendar';
import { FeedFormatError } from '../feeds/errors.js';
import { PRODUCT_RE, type MirrorProduct } from './arrays.js';
import { gridOf, productGrid } from './grid.js';
import type { MirrorStore } from './store.js';

const IsoDay = z.string().refine(isIsoDate, 'an ISO date (YYYY-MM-DD)');
const IsoInstant = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, 'an ISO UTC time')
	.refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO UTC time');
const Revision = z.number().int().min(1);
const Year = z.number().int().min(1900).max(2200);

const Region = z
	.object({ w: z.number().finite(), s: z.number().finite(), e: z.number().finite(), n: z.number().finite() })
	.strict()
	.refine((r) => r.w < r.e && r.s < r.n && r.w >= -180 && r.e <= 180 && r.s >= -90 && r.n <= 90, 'a region with w < e and s < n');

// The step is checked against the product's in the manifest's superRefine.
const Grid = z.object({ origin: z.object({ lat: z.number().finite(), lon: z.number().finite() }).strict(), step: z.number().finite().positive() }).strict();

/** An IMERG collection version: `V07`, `V08`, … (the granule's minor letter stays in its URL). */
export const IMERG_VERSION = /^V\d{2}$/;

const ManifestFile = z
	.object({
		url: z.string().min(1).max(2048),
		etag: z.string().max(256).nullable(),
		lastModified: z.string().max(64).nullable(),
		size: z.number().int().nonnegative().nullable(),
		valuesSha256: z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256'),
		revision: Revision,
		fetchedAt: IsoInstant,
		/** imerg_late only: the IMERG version of the file's day. */
		version: z.string().regex(IMERG_VERSION, 'an IMERG version (V07, V08, …)').optional()
	})
	.strict();

const Change = z
	.object({
		revision: Revision,
		days: z.tuple([IsoDay, IsoDay]).refine(([from, to]) => from <= to, 'days from ≤ to'),
		cellsChanged: z.number().int().nonnegative(),
		maxAbsDiff: z.number().finite().nonnegative()
	})
	.strict();

/** A CHC byMonth file's URL ends `.YYYY.MM.days_p05.nc`. */
const FILE_MONTH = /\.(\d{4})\.(0[1-9]|1[0-2])\.days_p05\.nc$/;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An IMERG daily file's URL names its day: `…3IMERG.YYYYMMDD-S000000-E235959.…`. */
const FILE_DAY = /3IMERG\.(\d{4})(\d{2})(\d{2})-S000000-E235959\./;

/** An era5l file's URL: the CDS month request it came from. */
const ERA5L_URL = /^cds:\/\/reanalysis-era5-land\/total_precipitation\/(\d{4})-(0[1-9]|1[0-2])$/;
/** ERA5-Land's record starts here: the 1950-01 request's first step is the record's start. */
const ERA5L_FIRST_DAY = '1950-01-01';

/** The month (`year * 12 + month - 1`) an era5l file's URL names, or null. */
const era5lFileMonth = (url: string): number | null => {
	const m = ERA5L_URL.exec(url);
	return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
};

/**
 * The days era5l's request for a month (`year * 12 + month - 1`) holds: the
 * last day of the month before through the second-last day of the month
 * (each 00 UTC step totals the day before it), never before 1950-01-01.
 */
export function era5lWrittenDays(month: number): { from: string; through: string } {
	const first = toEpochDay(`${Math.floor(month / 12)}-${pad2((month % 12) + 1)}-01`);
	const next = toEpochDay(`${Math.floor((month + 1) / 12)}-${pad2(((month + 1) % 12) + 1)}-01`);
	const from = fromEpochDay(first - 1);
	return { from: from < ERA5L_FIRST_DAY ? ERA5L_FIRST_DAY : from, through: fromEpochDay(next - 2) };
}

/**
 * The days era5l's files hold: from the earliest month's first day through
 * the end of the contiguous run of months from it (null when no file names
 * one). A later month after a gap doesn't extend it.
 */
export function era5lCoverage(files: readonly { url: string }[]): { from: string; through: string } | null {
	const months = new Set<number>();
	for (const f of files) {
		const m = era5lFileMonth(f.url);
		if (m !== null) months.add(m);
	}
	if (months.size === 0) return null;
	const first = Math.min(...months);
	let last = first;
	while (months.has(last + 1)) last++;
	return { from: era5lWrittenDays(first).from, through: era5lWrittenDays(last).through };
}

/** The day an IMERG daily file's URL names (ISO), or null. */
export function imergFileDay(url: string): string | null {
	const m = FILE_DAY.exec(url);
	if (!m) return null;
	const day = `${m[1]}-${m[2]}-${m[3]}`;
	return isIsoDate(day) ? day : null;
}

/**
 * The days an IMERG product's files hold: the earliest day a file names
 * through the end of the contiguous run of days from it (null when no file
 * names one). A later day after a gap doesn't extend it.
 */
export function imergCoverage(files: readonly { url: string }[]): { from: string; through: string } | null {
	const days = new Set<number>();
	for (const f of files) {
		const d = imergFileDay(f.url);
		if (d) days.add(toEpochDay(d));
	}
	if (days.size === 0) return null;
	const first = Math.min(...days);
	let last = first;
	while (days.has(last + 1)) last++;
	return { from: fromEpochDay(first), through: fromEpochDay(last) };
}

/** imerg_late: each held day's IMERG version, by ISO day, from its file. */
export function imergVersions(m: Pick<Manifest, 'files'>): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of m.files) {
		const d = imergFileDay(f.url);
		if (d && f.version) out.set(d, f.version);
	}
	return out;
}

/**
 * The days a finals product's files hold: the first day of the earliest month
 * through the last day of the contiguous run of months from it (null when no
 * file names a month). A later month after a gap doesn't extend it.
 */
export function finalsCoverage(files: readonly { url: string }[]): { from: string; through: string } | null {
	const months = new Set<number>();
	for (const f of files) {
		const m = FILE_MONTH.exec(f.url);
		if (m) months.add(Number(m[1]) * 12 + Number(m[2]) - 1);
	}
	if (months.size === 0) return null;
	const first = Math.min(...months);
	let last = first;
	while (months.has(last + 1)) last++;
	const [ly, lm] = [Math.floor(last / 12), (last % 12) + 1];
	const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
	return { from: `${Math.floor(first / 12)}-${pad2((first % 12) + 1)}-01`, through: `${ly}-${pad2(lm)}-${pad2(lastDay)}` };
}

export const Manifest = z
	.object({
		product: z.string().regex(PRODUCT_RE),
		revision: Revision,
		region: Region,
		grid: Grid,
		// Both null before any day is copied (or after every day is dropped: imerg_late keeps 30), as ingest/manifest.py's new() writes.
		years: z
			.object({ first: Year.nullable(), last: Year.nullable() })
			.strict()
			.refine((y) => (y.first === null) === (y.last === null) && (y.first === null || y.first <= y.last!), 'years both null, or first ≤ last'),
		finalThrough: IsoDay.nullable(),
		prelimThrough: IsoDay.nullable(),
		files: z.array(ManifestFile),
		changes: z.array(Change)
	})
	.strict()
	.superRefine((m, ctx) => {
		const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
		const pg = productGrid(m.product);
		if (pg && m.grid.step !== pg.step) ctx.addIssue({ code: 'custom', path: ['grid', 'step'], message: `must be ${pg.step}° for ${m.product}` });
		const g = gridOf(m.region, m.grid.step);
		if (m.grid.origin.lat !== g.origin.lat || m.grid.origin.lon !== g.origin.lon) bad('grid origin is not the centre of the region’s south-west cell');
		if (m.files.some((f) => f.revision > m.revision)) bad('a file from a later revision than the manifest’s');
		if (m.changes.some((c) => c.revision > m.revision)) bad('a change from a later revision than the manifest’s');
		if (m.changes.some((c, i) => i > 0 && c.revision < m.changes[i - 1]!.revision)) bad('changes in revision order');
		if (new Set(m.files.map((f) => f.url)).size !== m.files.length) bad('a file is listed twice');
		const chcFinals = m.product === 'rnl' || m.product === 'sat';
		const imerg = m.product === 'imerg_late';
		const finals = chcFinals || m.product === 'era5l';
		if ((m.product === 'rnl' || m.product === 'era5l') && m.prelimThrough !== null) bad(`${m.product} has no preliminary days`);
		for (const [k, d] of [['finalThrough', m.finalThrough], ['prelimThrough', m.prelimThrough]] as const) {
			if (d !== null && (m.years.first === null || Number(d.slice(0, 4)) < m.years.first || Number(d.slice(0, 4)) > m.years.last!)) bad(`${k} is outside years`);
		}
		if (!finals && m.finalThrough !== null) bad(`${m.product} holds no final days`);
		if (imerg) {
			if (m.files.some((f) => imergFileDay(f.url) === null)) bad('an imerg_late file whose url names no day (…3IMERG.YYYYMMDD-S000000-E235959.…)');
			const held = imergCoverage(m.files);
			if (m.prelimThrough !== null && (held === null || m.prelimThrough > held.through)) bad(`prelimThrough runs past the days the files hold contiguously (through ${held?.through ?? 'none'})`);
		} else if (m.files.some((f) => f.version !== undefined)) bad(`${m.product}'s files carry no version`);
		if (m.product === 'era5l') {
			if (m.files.some((f) => era5lFileMonth(f.url) === null)) bad('an era5l file whose url is not a month request (cds://reanalysis-era5-land/total_precipitation/YYYY-MM)');
			if (m.files.some((f) => f.etag !== null || f.lastModified !== null)) bad('an era5l file with an etag or lastModified: the CDS gives neither');
			const held = era5lCoverage(m.files);
			if (m.finalThrough !== null && (held === null || m.finalThrough > held.through)) bad(`finalThrough runs past the days the files hold contiguously (through ${held?.through ?? 'none'})`);
		}
		if (chcFinals) {
			if (m.files.some((f) => !FILE_MONTH.test(f.url))) bad('a finals file whose url names no month (….YYYY.MM.days_p05.nc)');
			const held = finalsCoverage(m.files);
			if (m.finalThrough !== null && (held === null || m.finalThrough > held.through)) bad(`finalThrough runs past the months the files hold contiguously (through ${held?.through ?? 'none'})`);
		}
	});
export type Manifest = z.output<typeof Manifest>;

/** The manifest is missing a field, has one wrong, or isn't JSON. */
export class MirrorManifestError extends FeedFormatError {}

const key = (product: string) => `/${product}/manifest.json` as AbsolutePath;

/** Check a manifest, with a message naming the first problem. */
export function parseManifest(raw: unknown, product?: string): Manifest {
	const r = Manifest.safeParse(raw);
	if (!r.success) {
		const issue = r.error.issues[0]!;
		throw new MirrorManifestError(`the rain data copy's manifest${product ? ` for ${product}` : ''} is invalid: ${issue.path.join('.') || '(root)'} ${issue.message}`);
	}
	if (product !== undefined && r.data.product !== product) throw new MirrorManifestError(`the rain data copy's manifest at ${product} names product ${r.data.product}`);
	return r.data;
}

/** `product`'s manifest, or null when the copy doesn't hold it yet. */
export async function readManifest(store: MirrorStore, product: MirrorProduct): Promise<Manifest | null> {
	const bytes = await store.get(key(product));
	if (bytes === undefined) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new MirrorManifestError(`the rain data copy's manifest for ${product} is not valid JSON`);
	}
	return parseManifest(raw, product);
}

/** Validate and write `m` as its product's manifest (2-space JSON, trailing newline). */
export async function writeManifest(store: MirrorStore, m: Manifest): Promise<void> {
	const ok = parseManifest(m);
	await store.set(key(ok.product), new TextEncoder().encode(`${JSON.stringify(ok, null, 2)}\n`));
}

/**
 * A manifest file's `valuesSha256`: SHA-256 over the region subset's values,
 * float32 little-endian in (day, lat, lon) C order (`days` slices, each rows ×
 * cols with row 0 the southernmost), every NaN canonicalised to 0x7FC00000.
 */
export function manifestHash(days: Iterable<Float32Array>): string {
	const h = createHash('sha256');
	for (const day of days) {
		// Little-endian bytes: a copy of the float32 bits (byte-swapped on a big-endian host), each NaN made canonical.
		const out = new Uint32Array(day.length);
		out.set(new Uint32Array(day.buffer, day.byteOffset, day.length));
		for (let i = 0; i < out.length; i++) {
			const u = out[i]!;
			if ((u & 0x7f800000) === 0x7f800000 && (u & 0x007fffff) !== 0) out[i] = 0x7fc00000;
		}
		if (BIG_ENDIAN) for (let i = 0; i < out.length; i++) out[i] = swap32(out[i]!);
		h.update(new Uint8Array(out.buffer));
	}
	return h.digest('hex');
}

const BIG_ENDIAN = endianness() === 'BE';
const swap32 = (u: number) => (((u & 0xff) << 24) | ((u & 0xff00) << 8) | ((u >>> 8) & 0xff00) | (u >>> 24)) >>> 0;
