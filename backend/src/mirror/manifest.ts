// A mirror product's manifest, `<product>/manifest.json` beside its array
// (issue #604, "Manifest spec"): what the copy holds, which upstream file
// each part came from, and each revision's changes.
//
//   { product, revision, region {w,s,e,n}, grid {origin {lat,lon}, step},
//     years {first,last}, finalThrough, prelimThrough,
//     files [{ url, etag, lastModified, size, valuesSha256, revision, fetchedAt }],
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
import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { isIsoDate } from '@water-management/engine/calendar';
import { FeedFormatError } from '../feeds/errors.js';
import { PRODUCT_RE, type MirrorProduct } from './arrays.js';
import { gridOf, MIRROR_STEP } from './grid.js';
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

const Grid = z.object({ origin: z.object({ lat: z.number().finite(), lon: z.number().finite() }).strict(), step: z.number().refine((s): boolean => s === MIRROR_STEP, `the grid step ${MIRROR_STEP}°`) }).strict();

const ManifestFile = z
	.object({
		url: z.string().min(1).max(2048),
		etag: z.string().max(256).nullable(),
		lastModified: z.string().max(64).nullable(),
		size: z.number().int().nonnegative().nullable(),
		valuesSha256: z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256'),
		revision: Revision,
		fetchedAt: IsoInstant
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
		years: z.object({ first: Year, last: Year }).strict().refine((y) => y.first <= y.last, 'years first ≤ last'),
		finalThrough: IsoDay.nullable(),
		prelimThrough: IsoDay.nullable(),
		files: z.array(ManifestFile),
		changes: z.array(Change)
	})
	.strict()
	.superRefine((m, ctx) => {
		const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
		const g = gridOf(m.region, m.grid.step);
		if (m.grid.origin.lat !== g.origin.lat || m.grid.origin.lon !== g.origin.lon) bad('grid origin is not the centre of the region’s south-west cell');
		if (m.files.some((f) => f.revision > m.revision)) bad('a file from a later revision than the manifest’s');
		if (m.changes.some((c) => c.revision > m.revision)) bad('a change from a later revision than the manifest’s');
		if (m.changes.some((c, i) => i > 0 && c.revision < m.changes[i - 1]!.revision)) bad('changes in revision order');
		if (new Set(m.files.map((f) => f.url)).size !== m.files.length) bad('a file is listed twice');
		const finals = m.product === 'rnl' || m.product === 'sat';
		if (m.product === 'rnl' && m.prelimThrough !== null) bad('rnl has no preliminary days');
		for (const [k, d] of [['finalThrough', m.finalThrough], ['prelimThrough', m.prelimThrough]] as const) {
			if (d !== null && (Number(d.slice(0, 4)) < m.years.first || Number(d.slice(0, 4)) > m.years.last)) bad(`${k} is outside years`);
		}
		if (!finals && m.finalThrough !== null) bad(`${m.product} holds no final days`);
		if (finals) {
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
