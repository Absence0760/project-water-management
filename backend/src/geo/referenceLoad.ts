// Production loads of the map's reference datasets (docs/deployment.md §
// Reference datasets; docs/maps.md § Sources). Locally the operator runs
// `pnpm import:<kind>` against the dev database as the schema owner; the
// production database sits in a private VPC, so there the same parsers and the
// same replace-a-dataset writes run inside the migrate Lambda
// (lambda-migrate.ts), which already holds the owner's credentials. The
// operator uploads one prepared file to the private reference bucket
// (infra/map_data.tf) and runs .github/workflows/load-reference.yml (the
// `production` environment, OIDC), which invokes the Lambda with
// `{ load: { kind, key, sha256, dataset, source?, minOrder? } }`.
//
// Only kinds whose licence docs/maps.md § Sources marks allowed load
// (decision D-B in #326); the rest are refused here, by name, with the
// decision that would unblock them. referenceLoad.test.ts checks this table
// against the Sources table, so the two can't drift.
//
// What a load trusts: the object must hash to the SHA-256 the operator gave
// (the file they prepared, not whatever sits under that key), stay under a
// size cap, and parse as its kind's file. Nothing here prints the file's
// contents: the caller gets counts, and a failure's code; the skipped
// features' reasons go to CloudWatch only (the deploy log is public).
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { croplandFromJson, jsonDatasetMeta, replaceCroplandDataset } from './croplandGrid.js';
import { replaceRivers, riverRecords } from './loadRivers.js';

/** One kind of reference dataset, and whether production may load it. */
export type ReferenceKind = {
	/** The docs/maps.md § Sources rows that decide it (their Dataset cell starts with one of these). */
	sourcesRows: readonly string[];
} & ({ status: 'allowed'; file: RegExp; what: string } | { status: 'blocked'; why: string });

export const REFERENCE_KINDS = {
	'land-cover': {
		status: 'allowed',
		sourcesRows: ['ESA WorldCover'],
		file: /\.json(\.gz)?$/,
		what: 'the pre-summarised grid `pnpm import:land-cover … --out <file>` writes'
	},
	rivers: {
		status: 'allowed',
		sourcesRows: ['HydroRIVERS'],
		file: /\.(geo)?json(\.gz)?$/,
		what: 'a GeoJSON FeatureCollection of reaches (bin/tiles-dev.sh rivers writes one)'
	},
	quaternaries: {
		status: 'blocked',
		sourcesRows: ['Quaternary catchment outlines', 'WR2012 reference values'],
		why: "WR2012's and the DWS quaternary outlines' licence terms are unconfirmed (followups.md, Decision: WR2012's licence terms)"
	},
	'dam-register': {
		status: 'blocked',
		sourcesRows: ['List of Registered Dams', 'Google Earth Overlay'],
		why: "the DWS register of dams' licence is unconfirmed (followups.md, Decision: the DWS register of dams' licence)"
	},
	'gauge-stations': {
		status: 'blocked',
		sourcesRows: ['Hydrological station catalogue'],
		why: "the DWS station catalogue's licence is unconfirmed (followups.md, Decision: the DWS station catalogue's licence)"
	}
} as const satisfies Record<string, ReferenceKind>;

export type ReferenceKindName = keyof typeof REFERENCE_KINDS;
type AllowedKind = { [K in ReferenceKindName]: (typeof REFERENCE_KINDS)[K]['status'] extends 'allowed' ? K : never }[ReferenceKindName];

/**
 * The largest object a load downloads (what the operator uploaded, compressed
 * or not), and the largest text it parses after gunzip. Sized to the migrate
 * Lambda's memory (migrate_memory_mb, at least 3008 MB, with a 2.5 GB heap):
 * parsing 200 MB of text peaked at 1.8 GB resident for either kind (measured
 * 2026-10-02 on synthetic files: 475 000 river reaches, 6.9 million cells),
 * and a country's real files are well under it (deployment.md § Reference
 * datasets). A bigger file is refused here, with a reason, rather than killed
 * by the runtime out of memory with none.
 */
export const MAX_OBJECT_BYTES = 200 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024 * 1024;

export interface LoadRequest {
	kind: AllowedKind;
	/** The object's key in the reference bucket: reference/<kind>/<file>. */
	key: string;
	/** SHA-256 (hex) of the object as uploaded; the load refuses any other bytes. */
	sha256: string;
	/** The dataset label it loads as (a load replaces that dataset). */
	dataset: string;
	/** Rivers: the source and attribution stored on every reach that has none of its own (HydroRIVERS has none). Land cover: overrides the file’s own. */
	source: string | null;
	/** Rivers: leave out reaches below this Strahler order. */
	minOrder: number;
}

export type LoadErrorCode = 'refused' | 'not_found' | 'too_large' | 'checksum_mismatch' | 'unreadable' | 'empty' | 'load_failed';

/** A failed load. `message` may name the file's problems and goes to CloudWatch; `publicReason` is fixed text, safe for the public log. */
export class LoadError extends Error {
	constructor(
		message: string,
		readonly code: LoadErrorCode,
		readonly publicReason: string | null = null
	) {
		super(message);
		this.name = 'LoadError';
	}
}

const refused = (reason: string) => new LoadError(reason, 'refused', reason);

/** The `load` part of the migrate Lambda's event, checked. Refusals are LoadErrors with fixed text (never the input). */
export function parseLoadRequest(raw: unknown): LoadRequest {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refused('the load is not an object');
	const r = raw as Record<string, unknown>;
	const kind = r.kind;
	if (typeof kind !== 'string' || !Object.hasOwn(REFERENCE_KINDS, kind)) {
		throw refused(`kind must be one of ${Object.keys(REFERENCE_KINDS).join(', ')}`);
	}
	const spec: ReferenceKind = REFERENCE_KINDS[kind as ReferenceKindName];
	if (spec.status === 'blocked') throw refused(`${kind} is blocked in production: ${spec.why}; docs/maps.md § Sources`);
	const key = r.key;
	const keyShape = new RegExp(`^reference/${kind}/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`);
	if (typeof key !== 'string' || !keyShape.test(key) || key.includes('..') || !spec.file.test(key)) {
		throw refused(`key must be reference/${kind}/<file> naming ${spec.what}`);
	}
	const sha256 = r.sha256;
	if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw refused('sha256 must be the file’s SHA-256, 64 lowercase hex digits');
	const dataset = r.dataset;
	if (typeof dataset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(dataset)) {
		throw refused('dataset must be a label of 1–50 letters, digits, spaces, dots, dashes or underscores');
	}
	if (dataset === 'synthetic') throw refused('"synthetic" is the committed fixtures’ label; pick another');
	const source = r.source === undefined || r.source === null || r.source === '' ? null : r.source;
	if (source !== null && (typeof source !== 'string' || source.length > 500 || /[\u0000-\u001f]/.test(source))) {
		throw refused('source is at most 500 characters on one line');
	}
	if (kind === 'rivers' && source === null) throw refused('rivers need a source: the attribution stored on every reach');
	const minOrder = r.minOrder === undefined || r.minOrder === null ? 1 : r.minOrder;
	if (!Number.isInteger(minOrder) || (minOrder as number) < 1 || (minOrder as number) > 15) throw refused('minOrder is a Strahler order, 1 to 15');
	return { kind: kind as AllowedKind, key, sha256, dataset, source, minOrder: minOrder as number };
}

/** Reads one object from the reference bucket: its size first, its bytes only when asked. */
export type ReadObject = (key: string) => Promise<{ contentLength: number; bytes: () => Promise<Uint8Array> } | null>;

/** The object's text: present, under the caps, the bytes the operator hashed, gunzipped when it is .gz. */
export async function readReferenceText(req: LoadRequest, read: ReadObject, limits = { object: MAX_OBJECT_BYTES, text: MAX_TEXT_BYTES }): Promise<string> {
	const mib = (n: number) => `${Math.round(n / 1024 / 1024)} MiB`;
	const tooBig = (what: string, n: number) => new LoadError(`${req.key}: ${what} is ${n} bytes`, 'too_large', `the file is over ${mib(what === 'text' ? limits.text : limits.object)}${what === 'text' ? ' unzipped' : ''}`);
	const obj = await read(req.key);
	if (!obj) throw new LoadError(`no object at ${req.key}`, 'not_found', 'no object at that key in the reference bucket');
	if (obj.contentLength > limits.object) throw tooBig('object', obj.contentLength);
	const bytes = await obj.bytes();
	if (bytes.byteLength > limits.object) throw tooBig('object', bytes.byteLength);
	const hash = createHash('sha256').update(bytes).digest('hex');
	if (hash !== req.sha256) throw new LoadError(`${req.key} hashes to ${hash}, not ${req.sha256}`, 'checksum_mismatch', 'the file’s SHA-256 is not the one given');
	let text: Buffer;
	if (req.key.endsWith('.gz')) {
		try {
			text = gunzipSync(bytes, { maxOutputLength: limits.text });
		} catch (e) {
			if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig('text', limits.text + 1);
			throw new LoadError(`${req.key}: ${(e as Error).message}`, 'unreadable', 'the file is not gzip');
		}
	} else text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (text.byteLength > limits.text) throw tooBig('text', text.byteLength);
	return text.toString('utf8');
}

export interface LoadResult {
	kind: AllowedKind;
	dataset: string;
	/** Rows written (reaches, or cells with cropland). */
	written: number;
	/** Features or cells the file had that the load couldn't take (their reasons are in CloudWatch). */
	skipped: number;
	/** Rivers: reaches below minOrder, left out on purpose. */
	belowOrder: number;
}

/**
 * Parse `text` as `req.kind`'s file and replace `req.dataset` with it, as the
 * schema owner on `client` (each replace is one transaction). `log` gets the
 * skipped features' reasons (CloudWatch).
 */
export async function loadReferenceText(client: pg.ClientBase, req: LoadRequest, text: string, log: (line: string) => void = () => {}): Promise<LoadResult> {
	const name = req.key.split('/').pop()!;
	let doc: unknown;
	if (req.kind === 'land-cover') {
		try {
			doc = JSON.parse(text);
		} catch {
			throw new LoadError(`${req.key} is not JSON`, 'unreadable', 'the file is not JSON');
		}
		const got = croplandFromJson(doc);
		if (typeof got === 'string') throw new LoadError(`${req.key}: ${got}`, 'unreadable', 'the file is not a land-cover grid (cellDeg and cells)');
		for (const p of got.problems.slice(0, 50)) log(`skipped: ${p}`);
		if (!got.cells.length) throw new LoadError(`${req.key}: no cells`, 'empty', 'the file has no cell with cropland');
		const meta = jsonDatasetMeta(req.dataset, got, { source: req.source });
		try {
			const written = await replaceCroplandDataset(client, meta, [got.cells]);
			return { kind: req.kind, dataset: req.dataset, written, skipped: got.problems.length, belowOrder: 0 };
		} catch (e) {
			throw new LoadError(`loading ${req.dataset}: ${(e as Error).message}`, 'load_failed');
		}
	}
	const { records, problems, belowOrder } = riverRecords([{ name, text }], req.source ?? '', req.minOrder);
	for (const p of problems.slice(0, 50)) log(`skipped: ${p}`);
	if (problems.length > 50) log(`… and ${problems.length - 50} more skipped`);
	if (!records.length) throw new LoadError(`${req.key}: no reach to load`, 'empty', 'the file has no reach the load can take');
	try {
		const written = await replaceRivers(client, req.dataset, records);
		return { kind: req.kind, dataset: req.dataset, written, skipped: problems.length, belowOrder };
	} catch (e) {
		throw new LoadError(`loading ${req.dataset}: ${(e as Error).message}`, 'load_failed');
	}
}
