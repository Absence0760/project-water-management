import { describe, expect, it } from 'vitest';
import { latestFileText } from './latest';

/** A promise the test settles when it says. */
function held<T>() {
	let settle!: { resolve: (v: T) => void; reject: (e: Error) => void };
	const promise = new Promise<T>((resolve, reject) => (settle = { resolve, reject }));
	return { promise, ...settle };
}

describe('latestFileText', () => {
	const slowFile = () => {
		const h = held<string>();
		return { file: { text: () => h.promise }, ...h };
	};

	it('drops a read that a later pick overtook, however late it lands', async () => {
		const read = latestFileText();
		const big = slowFile();
		const first = read(big.file);
		const second = read({ text: async () => 'small.csv' });
		expect(await second).toBe('small.csv');
		big.resolve('big.csv');
		expect(await first).toBeNull();
	});

	it('drops the first read even when the second is slow too and lands first', async () => {
		const read = latestFileText();
		const a = slowFile();
		const b = slowFile();
		const first = read(a.file);
		const second = read(b.file);
		b.resolve('b.csv');
		a.resolve('a.csv');
		expect(await Promise.all([first, second])).toEqual([null, 'b.csv']);
	});

	it('drops a read when the file is cleared, and a superseded read’s failure', async () => {
		const read = latestFileText();
		const a = slowFile();
		const first = read(a.file);
		expect(await read(null)).toBeNull();
		a.reject(new Error('NotReadableError'));
		expect(await first).toBeNull();
	});

	it('reads the latest pick, and lets its own failure through', async () => {
		const read = latestFileText();
		expect(await read({ text: async () => 'only.csv' })).toBe('only.csv');
		await expect(read({ text: () => Promise.reject(new Error('NotReadableError')) })).rejects.toThrow('NotReadableError');
	});

	it('keeps each reader’s picks apart (one per box)', async () => {
		const one = latestFileText();
		const two = latestFileText();
		const a = slowFile();
		const first = one(a.file);
		expect(await two({ text: async () => 'other box' })).toBe('other box');
		a.resolve('a.csv');
		expect(await first).toBe('a.csv');
	});
});
