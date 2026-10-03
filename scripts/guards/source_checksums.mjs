#!/usr/bin/env node
// The downloaded map sources, checked by SHA-256 against a committed manifest
// (docs/maps.md § Sources, "Checksums").
//
// None of the whole-file sources the operator scripts download publishes a
// checksum (HydroRIVERS' zip, JRC GSW's occurrence tiles, dPET's yearly
// files; docs/maps.md records what each publisher offers), so the scripts pin
// one themselves: bin/source-checksums.sha256, in `sha256sum` format
// (`<hex>  <file name>`), keyed by the file's name. A file whose name is in
// the manifest must match it, or the script stops: the file is moved aside
// to `<file>.mismatch` (so a re-run doesn't use it) and the message says what
// was expected. A file not yet in the manifest is trusted on first use: its
// hash is appended, and the operator commits the manifest so every later
// fetch, on any machine, is held to it.
//
// Run:   node scripts/guards/source_checksums.mjs <file> [<name>]
//        (bin/tiles-dev.sh rivers | water, bin/evaporation-fetch.sh)
//        SOURCE_CHECKSUMS=<path> reads and writes another manifest (tests).
// Exit:  0 matched or recorded, 1 mismatch, 2 usage.
// Tests: node --test scripts/guards/source_checksums.test.mjs

import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LINE = /^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export const DEFAULT_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'source-checksums.sha256');

/** The manifest's text as a Map of name → hex; throws on a line it can't read or a name listed twice. */
export function parseManifest(text) {
	const out = new Map();
	text.split('\n').forEach((raw, i) => {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) return;
		const m = line.match(LINE);
		if (!m) throw new Error(`source-checksums line ${i + 1}: expected "<sha256 hex>  <file name>", got ${JSON.stringify(line)}`);
		if (out.has(m[2])) throw new Error(`source-checksums line ${i + 1}: ${m[2]} is listed twice`);
		out.set(m[2], m[1]);
	});
	return out;
}

/** The file's SHA-256, hex, read as a stream (the dPET years are 2.4 GB). */
export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('error', reject)
			.on('data', (chunk) => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Check `file` against the manifest entry for `name`: { status, expected,
 * actual }, status 'ok' (it matches), 'recorded' (first use: appended to the
 * manifest) or 'mismatch' (the file was moved to `<file>.mismatch`).
 */
export async function checkSource(file, name = basename(file), manifest = DEFAULT_MANIFEST) {
	if (!NAME.test(name)) throw new Error(`source name must be a plain file name, got ${JSON.stringify(name)}`);
	const entries = existsSync(manifest) ? parseManifest(readFileSync(manifest, 'utf8')) : new Map();
	const actual = await sha256File(file);
	const expected = entries.get(name);
	if (expected === undefined) {
		const text = existsSync(manifest) ? readFileSync(manifest, 'utf8') : '';
		appendFileSync(manifest, `${text === '' || text.endsWith('\n') ? '' : '\n'}${actual}  ${name}\n`);
		return { status: 'recorded', expected: undefined, actual };
	}
	if (expected === actual) return { status: 'ok', expected, actual };
	renameSync(file, `${file}.mismatch`);
	return { status: 'mismatch', expected, actual };
}

async function main() {
	const [file, name] = process.argv.slice(2);
	if (!file || process.argv.length > 4) {
		console.error('usage: node scripts/guards/source_checksums.mjs <file> [<name>]');
		process.exit(2);
	}
	const manifest = process.env.SOURCE_CHECKSUMS || DEFAULT_MANIFEST;
	const r = await checkSource(file, name ?? basename(file), manifest);
	const label = name ?? basename(file);
	if (r.status === 'ok') console.log(`${label}: SHA-256 matches ${basename(manifest)}`);
	else if (r.status === 'recorded') {
		console.log(`${label}: first fetch, SHA-256 ${r.actual} recorded in ${manifest} (trust on first use): commit it so later fetches are held to it.`);
	} else {
		console.error(
			`${label}: SHA-256 MISMATCH. ${basename(manifest)} expects ${r.expected}, the download is ${r.actual}. ` +
				`Moved it to ${file}.mismatch and stopped. The publisher may have re-issued the file, or the download was ` +
				`corrupted or tampered with: re-fetch it, and only if the publisher confirms a new release, replace that line ` +
				`in bin/source-checksums.sha256 (docs/maps.md § Sources).`
		);
		process.exit(1);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(2);
	});
}
