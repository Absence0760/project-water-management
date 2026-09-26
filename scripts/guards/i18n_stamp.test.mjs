import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helpHash, missingHelp, report, staleHelp } from './i18n_sheet.mjs';
import { restamp } from './i18n_stamp.mjs';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const SOURCE = `export const HELP_AF: Record<string, HelpTranslation> = {
	'dam-level': {
		term: 'Damvlak',
		short: 'Kort {x}.',
		long: 'Lank.',
		sourceHash: '${OLD}'
	},
	supplied: {
		term: 'Gelewer',
		short: 'Kort.',
		long: 'Lank.',
		sourceHash: "${OLD}"
	}
};
`;

test('restamp changes only the named entry’s sourceHash, quoted or bare key', () => {
	assert.equal(restamp(SOURCE, 'dam-level', NEW), SOURCE.replace(`sourceHash: '${OLD}'`, `sourceHash: '${NEW}'`));
	assert.equal(restamp(SOURCE, 'supplied', NEW), SOURCE.replace(`sourceHash: "${OLD}"`, `sourceHash: "${NEW}"`));
});

test('restamp refuses an unknown id, an entry without a stamp, and a bad hash', () => {
	assert.throws(() => restamp(SOURCE, 'dam', NEW), /no entry "dam"/);
	const unstamped = `export const HELP_AF = {\n\tone: { term: 'a', short: 'b', long: 'c' },\n\ttwo: { term: 'a', short: 'b', long: 'c', sourceHash: '${OLD}' }\n};\n`;
	assert.throws(() => restamp(unstamped, 'one', NEW), /has no sourceHash/);
	assert.throws(() => restamp(SOURCE, 'supplied', 'nothex'), /not a SHA-256/);
});

test('check:i18n lists stale glossary translations and what to run', () => {
	const e = { id: 'x', term: 'T', short: 'S', long: 'L', category: 'farmer' };
	const f = { id: 'y', term: 'U', short: 'S', long: 'L', category: 'farmer' };
	const g = { id: 'z', term: 'V', short: 'S', long: 'L', category: 'basics' };
	const helpAf = { x: { term: 'a', short: 'b', long: 'c', sourceHash: 'old' } };
	assert.deepEqual(staleHelp([e, f, g], helpAf), ['x']);
	assert.deepEqual(missingHelp([e, f, g], helpAf), ['y']);
	const r = report({ site: [{ rows: [1, 2] }], mail: [{ rows: [1] }], help: [e, f, g], helpAf });
	assert.deepEqual(r.stale, ['x']);
	assert.match(r.text, /2 site strings, 1 email strings, 1 glossary entries/);
	assert.match(r.text, /Stale glossary translations .*: x\./);
	assert.match(r.text, /pnpm gen:i18n:stamp <id>/);
	const current = report({ site: [], mail: [], help: [e], helpAf: { x: { ...helpAf.x, sourceHash: helpHash(e) } } });
	assert.deepEqual(current.stale, []);
	assert.doesNotMatch(current.text, /Stale/);
});
