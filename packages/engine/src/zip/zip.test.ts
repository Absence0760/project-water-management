// The engine's zip (issue #71: shared by the workbook export and import and
// the evidence pack's reproduction bundle): what zip() writes, ZipArchive
// reads back byte for byte; the same entries give the same bytes; and the
// reader's default errors refuse a damaged archive and an entry over its cap.
// The frontend's spreadsheet/export/zip.test.ts and import/zip.test.ts cover
// the same code through its re-exports, with the import's own errors.
import { describe, expect, it } from 'vitest';
import { crc32, storedZip, zip, ZipArchive, ZipFormatError, ZipTooLargeError, type ZipEntry } from './index';

const enc = new TextEncoder();
const entry = (name: string, text: string): ZipEntry => ({ name, data: enc.encode(text) });

const ENTRIES: ZipEntry[] = [
	entry('README.md', '# A bundle\n'),
	entry('runs/baseline/input.json', JSON.stringify({ settings: { apanMm: [150, 180] }, series: {} })),
	// Compressible, and larger than one deflate block.
	entry('series/abc.csv', 'date,value\n' + Array.from({ length: 5000 }, (_, i) => `2000-01-01,${i % 7}`).join('\n')),
	{ name: 'empty.txt', data: new Uint8Array(0) }
];

describe('zip + ZipArchive', () => {
	it('reads back every entry, in order, byte for byte', async () => {
		const bytes = await zip(ENTRIES);
		const archive = await ZipArchive.open(bytes);
		expect(archive.names).toEqual(ENTRIES.map((e) => e.name));
		for (const e of ENTRIES) {
			expect(await archive.read(e.name)).toEqual(e.data);
			expect(archive.info(e.name)!.crc).toBe(crc32(e.data));
		}
		// Deflated: the repetitive CSV is stored smaller than it is.
		expect(archive.info('series/abc.csv')!.compressedSize).toBeLessThan(ENTRIES[2]!.data.length / 4);
	});

	it('is deterministic: the same entries give the same bytes, and a changed byte changes them', async () => {
		const a = await zip(ENTRIES);
		expect(await zip(ENTRIES.map((e) => ({ name: e.name, data: e.data.slice() })))).toEqual(a);
		const changed = await zip([entry('README.md', '# A bundlf\n'), ...ENTRIES.slice(1)]);
		expect(changed).not.toEqual(a);
	});

	it('reads a stored (method 0) archive too', async () => {
		const archive = await ZipArchive.open(storedZip(ENTRIES.map((e) => ({ name: e.name, data: e.data, crc: crc32(e.data) }))));
		expect(await archive.read('runs/baseline/input.json')).toEqual(ENTRIES[1]!.data);
	});

	it('refuses what isn’t a zip, and a damaged entry, with ZipFormatError', async () => {
		await expect(ZipArchive.open(enc.encode('not a zip at all, just text'))).rejects.toBeInstanceOf(ZipFormatError);
		// A stored archive whose entry bytes no longer match their CRC.
		const data = enc.encode('hello, bundle');
		const bytes = storedZip([{ name: 'a.txt', data, crc: crc32(data) }]);
		const at = bytes.indexOf('h'.charCodeAt(0), 30);
		bytes[at] = 'j'.charCodeAt(0);
		const archive = await ZipArchive.open(bytes);
		await expect(archive.read('a.txt')).rejects.toBeInstanceOf(ZipFormatError);
		// Positive control: the undamaged archive reads.
		expect(await (await ZipArchive.open(storedZip([{ name: 'a.txt', data, crc: crc32(data) }]))).read('a.txt')).toEqual(data);
	});

	it('refuses an entry over maxEntryBytes and a read past maxTotalBytes with ZipTooLargeError', async () => {
		const bytes = await zip(ENTRIES);
		const big = ENTRIES[2]!.data.length;
		await expect((await ZipArchive.open(bytes, { maxEntryBytes: big - 1 })).read('series/abc.csv')).rejects.toBeInstanceOf(ZipTooLargeError);
		const capped = await ZipArchive.open(bytes, { maxTotalBytes: big + 5 });
		expect((await capped.read('series/abc.csv')).length).toBe(big);
		await expect(capped.read('runs/baseline/input.json')).rejects.toBeInstanceOf(ZipTooLargeError);
		// Positive control: within both caps, both read.
		const roomy = await ZipArchive.open(bytes, { maxEntryBytes: big, maxTotalBytes: big * 2 });
		expect((await roomy.read('series/abc.csv')).length).toBe(big);
		expect((await roomy.read('runs/baseline/input.json')).length).toBe(ENTRIES[1]!.data.length);
	});

	it('refuses more entries than maxEntries', async () => {
		await expect(ZipArchive.open(await zip(ENTRIES), { maxEntries: ENTRIES.length - 1 })).rejects.toThrow();
		expect((await ZipArchive.open(await zip(ENTRIES), { maxEntries: ENTRIES.length })).names).toHaveLength(ENTRIES.length);
	});
});
