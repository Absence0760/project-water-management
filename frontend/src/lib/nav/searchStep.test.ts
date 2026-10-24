import { describe, expect, it } from 'vitest';
import { SearchStep } from './searchStep';

/** A fake history: each go() lands (the address becomes its href) unless `drop` says it was overtaken. */
function browser() {
	let here = 'https://app.test/';
	const calls: { href: string; replace: boolean }[] = [];
	const step = new SearchStep(() => here);
	const write = (href: string, { drop = false } = {}) =>
		step.write(href, async (replace) => {
			calls.push({ href, replace });
			if (!drop) here = new URL(href, here).href;
		});
	return { step, calls, write };
}

describe('SearchStep', () => {
	it('adds an entry on the first write after the focus, and replaces it for the rest of that search', async () => {
		const { step, calls, write } = browser();
		await write('/?q=a');
		await write('/?q=al');
		await write('/?q=alp');
		expect(calls.map((c) => c.replace)).toEqual([false, true, true]);
		// Back in the box: a new search is a new step.
		step.focus();
		await write('/?q=b');
		await write('/?q=be');
		expect(calls.slice(3).map((c) => c.replace)).toEqual([false, true]);
	});

	it('a push another navigation overtook never landed: the next write pushes, not replaces the entry the search came from', async () => {
		const { calls, write } = browser();
		await write('/?q=a', { drop: true });
		await write('/?q=al');
		await write('/?q=alp');
		expect(calls.map((c) => c.replace)).toEqual([false, false, true]);
	});

	it('a push that lands after the box was left and focused again counts for no search', async () => {
		const here = { href: 'https://app.test/' };
		const step = new SearchStep(() => here.href);
		let land: () => void = () => {};
		const pending = step.write('/?q=a', () => new Promise<void>((r) => (land = () => ((here.href = 'https://app.test/?q=a'), r()))));
		step.focus();
		land();
		await pending;
		const seen: boolean[] = [];
		await step.write('/?q=b', async (replace) => void seen.push(replace));
		expect(seen).toEqual([false]);
	});

	it('keeps each box’s steps apart', async () => {
		const a = browser();
		const b = browser();
		await a.write('/?q=x');
		await b.write('/?q=y');
		await a.write('/?q=xy');
		expect(a.calls.map((c) => c.replace)).toEqual([false, true]);
		expect(b.calls.map((c) => c.replace)).toEqual([false]);
	});

	it('works as a detached focus handler', async () => {
		const { step, calls, write } = browser();
		await write('/?q=a');
		const onfocus = step.focus;
		onfocus();
		await write('/?q=b');
		expect(calls.map((c) => c.replace)).toEqual([false, false]);
	});
});
