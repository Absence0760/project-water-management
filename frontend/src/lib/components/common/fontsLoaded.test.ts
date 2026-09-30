import { describe, expect, it } from 'vitest';
import { onFontsLoaded, type FontLoads } from './fontsLoaded';

function fakeFonts() {
	const target = new EventTarget();
	return { fonts: target as unknown as FontLoads, finish: () => target.dispatchEvent(new Event('loadingdone')) };
}

describe('onFontsLoaded', () => {
	it('calls back each time a batch of font loads finishes', () => {
		const { fonts, finish } = fakeFonts();
		let calls = 0;
		onFontsLoaded(() => calls++, fonts);
		expect(calls).toBe(0);
		finish();
		finish();
		expect(calls).toBe(2);
	});

	it('stops calling back once stopped', () => {
		const { fonts, finish } = fakeFonts();
		let calls = 0;
		const stop = onFontsLoaded(() => calls++, fonts);
		stop();
		finish();
		expect(calls).toBe(0);
	});

	it('does nothing without a FontFaceSet (no document: tests, the server)', () => {
		const stop = onFontsLoaded(() => {
			throw new Error('called');
		}, undefined);
		expect(stop).not.toThrow();
	});
});
