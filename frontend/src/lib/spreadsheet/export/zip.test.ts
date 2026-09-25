import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { crc32, deflateRaw, zip } from './zip';

describe('zip', () => {
	it('computes the standard CRC-32', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
		// Continued over chunks, it is the CRC of the whole.
		const bytes = new TextEncoder().encode('123456789');
		expect(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4)))).toBe(0xcbf43926);
	});

	it('deflates for real: a repetitive part shrinks a lot', async () => {
		const data = new TextEncoder().encode('<c r="A1"><v>0</v></c>'.repeat(10_000));
		expect((await deflateRaw(data)).length).toBeLessThan(data.length / 50);
	});

	it('writes a container another reader opens, byte for byte', async () => {
		const a = new TextEncoder().encode('hello '.repeat(1000));
		const b = new Uint8Array([0, 1, 2, 255]);
		const bytes = await zip([
			{ name: 'a.txt', data: a },
			{ name: 'dir/b.bin', data: b }
		]);
		const cfb = XLSX.CFB.read(bytes, { type: 'array' });
		expect(Array.from(XLSX.CFB.find(cfb, '/a.txt').content as Uint8Array)).toEqual(Array.from(a));
		expect(Array.from(XLSX.CFB.find(cfb, '/dir/b.bin').content as Uint8Array)).toEqual(Array.from(b));
		// Same input, same bytes (a fixed date stamp).
		expect(await zip([{ name: 'a.txt', data: a }])).toEqual(await zip([{ name: 'a.txt', data: a }]));
	});

	it('refuses names it cannot write as plain ASCII', async () => {
		await expect(zip([{ name: '/abs', data: new Uint8Array(1) }])).rejects.toThrow(/unsupported entry name/);
		await expect(zip([{ name: 'm³.xml', data: new Uint8Array(1) }])).rejects.toThrow(/unsupported entry name/);
	});
});
