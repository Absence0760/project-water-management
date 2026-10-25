import { describe, expect, it, vi } from 'vitest';
import { hashId, holdAnchor, landOnAnchor, READER_INPUT, type AnchorEnv, type LandEnv } from './anchor';

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

/** A panel stand-in: `heading` is what its querySelector finds (null until a lazy chunk draws it). */
function panel(heading: HTMLElement | null = null, isHeading = false) {
	return { heading, matches: () => isHeading, querySelector: function () { return this.heading; } };
}

function landSetup() {
	const found = new Map<string, unknown>();
	let onChange = () => {};
	let onReader = () => {};
	const stopWatch = vi.fn();
	const release = vi.fn();
	const env: LandEnv = {
		find: (id) => (found.get(id) as Element) ?? null,
		watch(change, reader) {
			onChange = change;
			onReader = reader;
			return stopWatch;
		},
		hold: vi.fn(() => release),
		focus: vi.fn()
	};
	return { found, env, stopWatch, release, change: () => onChange(), reader: () => onReader() };
}

describe('landOnAnchor', () => {
	const h = { id: 'h' } as unknown as HTMLElement;

	it('lands at once on a panel already drawn: holds it and focuses its heading, without watching', () => {
		const { found, env, release } = landSetup();
		found.set('set-fit', panel(h));
		const stop = landOnAnchor('set-fit', {} as Node, env);
		expect(env.hold).toHaveBeenCalledTimes(1);
		expect(env.focus).toHaveBeenCalledWith(h);
		stop();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it('focuses the anchor itself when it is the heading', () => {
		const { found, env } = landSetup();
		const self = panel(null, true);
		found.set('licence-record', self);
		landOnAnchor('licence-record', {} as Node, env);
		expect(env.focus).toHaveBeenCalledWith(self);
	});

	it('waits for a lazy panel, then for its heading, holding from when the panel is drawn and focusing once', () => {
		const { found, env, stopWatch, change } = landSetup();
		landOnAnchor('set-api-keys', {} as Node, env);
		expect(env.hold).not.toHaveBeenCalled();
		change();
		expect(env.hold).not.toHaveBeenCalled();
		const p = panel();
		found.set('set-api-keys', p);
		change();
		expect(env.hold).toHaveBeenCalledTimes(1);
		expect(env.focus).not.toHaveBeenCalled();
		p.heading = h;
		change();
		expect(env.focus).toHaveBeenCalledWith(h);
		expect(stopWatch).toHaveBeenCalledTimes(1);
		change();
		expect(env.hold).toHaveBeenCalledTimes(1);
		expect(env.focus).toHaveBeenCalledTimes(1);
	});

	it('gives up when the reader takes over first: a late chunk neither moves the page nor takes the focus', () => {
		const { found, env, stopWatch, change, reader } = landSetup();
		landOnAnchor('set-feeds', {} as Node, env);
		reader();
		expect(stopWatch).toHaveBeenCalledTimes(1);
		found.set('set-feeds', panel(h));
		change();
		expect(env.hold).not.toHaveBeenCalled();
		expect(env.focus).not.toHaveBeenCalled();
	});

	it('stops waiting and lets go of the hold when the page goes', () => {
		const { found, env, stopWatch, release, change } = landSetup();
		found.set('res-forecast', panel());
		const stop = landOnAnchor('res-forecast', {} as Node, env);
		stop();
		expect(stopWatch).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		(found.get('res-forecast') as ReturnType<typeof panel>).heading = h;
		change();
		expect(env.focus).not.toHaveBeenCalled();
	});
});
