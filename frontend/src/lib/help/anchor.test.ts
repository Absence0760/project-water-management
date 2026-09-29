import { describe, expect, it, vi } from 'vitest';
import { hashId, holdAnchor, READER_INPUT, type AnchorEnv } from './anchor';

describe('hashId', () => {
	it('decodes the id, and gives none for no hash or a malformed one', () => {
		expect(hashId('#dam-capacity')).toBe('dam-capacity');
		expect(hashId('#caf%C3%A9')).toBe('café');
		expect(hashId('')).toBe('');
		expect(hashId('#%E0')).toBe('');
	});
});

function setup() {
	const target = new EventTarget();
	let onLayout: (() => void) | undefined;
	const stop = vi.fn();
	let loadFonts!: () => void;
	const env: AnchorEnv = {
		target,
		fontsReady: new Promise<void>((resolve) => (loadFonts = resolve)),
		watchLayout(cb) {
			onLayout = cb;
			return stop;
		}
	};
	const el = { scrollIntoView: vi.fn() };
	return { target, env, el, stop, layout: () => onLayout?.(), loadFonts };
}

describe('holdAnchor', () => {
	it('scrolls the entry to the top at once, and again when the fonts land and the layout changes', async () => {
		const { env, el, layout, loadFonts } = setup();
		holdAnchor(el, env);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
		layout();
		expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
		loadFonts();
		await env.fontsReady;
		expect(el.scrollIntoView).toHaveBeenCalledTimes(3);
	});

	it.each(READER_INPUT)('lets go once the reader scrolls for themselves (%s)', async (type) => {
		const { target, env, el, stop, layout, loadFonts } = setup();
		holdAnchor(el, env);
		target.dispatchEvent(new Event(type));
		expect(stop).toHaveBeenCalledTimes(1);
		layout();
		loadFonts();
		await env.fontsReady;
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it('lets go when released (another hash, leaving the page), once', () => {
		const { target, env, el, stop, layout } = setup();
		const release = holdAnchor(el, env);
		release();
		release();
		target.dispatchEvent(new Event('keydown'));
		layout();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
	});
});
