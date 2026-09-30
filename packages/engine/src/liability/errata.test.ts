// The errata are generated from docs/engine-errata.md (WP-3.13): the
// committed list must be exactly what the doc says, and errataFor must pick
// the ones whose version range holds a run's engine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../version';
import { compareEngineVersions, errataFor, parseErrata, type Erratum } from './errata';
import { ENGINE_ERRATA } from './errata.generated';
import { renderErrataModule } from './generate';

const DOC = fileURLToPath(new URL('../../../../docs/engine-errata.md', import.meta.url));
const GENERATED = fileURLToPath(new URL('./errata.generated.ts', import.meta.url));
const doc = readFileSync(DOC, 'utf8');

const e = (id: string, firstAffected: string, fixedIn: string | null): Erratum => ({
	id,
	firstAffected,
	fixedIn,
	severity: 'High',
	appliesWhen: 'always',
	summary: 'wrong',
	source: 'test'
});

describe('ENGINE_ERRATA (generated from docs/engine-errata.md)', () => {
	it('is current: regenerate with `pnpm gen:liability` after changing the errata table', () => {
		const parsed = parseErrata(doc);
		expect(ENGINE_ERRATA).toEqual(parsed);
		expect(readFileSync(GENERATED, 'utf8')).toBe(renderErrataModule(parsed));
	});

	it('holds plain text, and every source names where it is documented', () => {
		expect(ENGINE_ERRATA.length).toBeGreaterThan(0);
		for (const x of ENGINE_ERRATA) {
			expect(x.appliesWhen + x.summary + x.source, x.id).not.toMatch(/\*\*|`|\]\(/);
			expect(x.source, x.id).toMatch(/engine-audit\.md|model\.md/);
		}
	});

	it('refuses a malformed table rather than dropping a row', () => {
		const row = doc.split('\n').find((l) => l.startsWith('| ER-3 |'))!;
		expect(() => parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| soon |')))).toThrow(/ER-3: fixed in "soon"/);
		expect(() => parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| 0.10.0 |')))).toThrow(/ER-3: fixed in 0.10.0, not after 0.15.0/);
		expect(() => parseErrata(doc.replace(row, row.replace('| ER-3 |', '| ER-2 |')))).toThrow(/ER-2 is listed twice/);
		expect(() => parseErrata(doc.replace(row, row.replace('| Medium |', '| |')))).toThrow(/"severity" is empty/);
		expect(() => parseErrata(doc.replace('## Errata', '## Bugs'))).toThrow(/Errata/);
		// Control: "open" is a fix version.
		expect(parseErrata(doc.replace(row, row.replace('| 0.20.0 |', '| open |'))).find((x) => x.id === 'ER-3')?.fixedIn).toBeNull();
	});
});

describe('errataFor', () => {
	const list = [e('ER-1', '0.15.0', '0.20.0'), e('ER-2', '1.2.0', null), e('ER-3', '0.0.0', '0.7.0')];

	it('takes the first affected version and stops at the fix', () => {
		expect(errataFor('0.14.9', list)).toEqual([]);
		expect(errataFor('0.6.9', list).map((x) => x.id)).toEqual(['ER-3']);
		expect(errataFor('0.7.0', list)).toEqual([]);
		expect(errataFor('0.15.0', list).map((x) => x.id)).toEqual(['ER-1']);
		expect(errataFor('0.19.3', list).map((x) => x.id)).toEqual(['ER-1']);
		expect(errataFor('0.20.0', list)).toEqual([]);
	});

	it('keeps an open erratum for every later version', () => {
		expect(errataFor('1.2.0', list).map((x) => x.id)).toEqual(['ER-2']);
		expect(errataFor('9.0.0', list).map((x) => x.id)).toEqual(['ER-2']);
		expect(errataFor('1.1.99', list)).toEqual([]);
	});

	it('compares numerically, not as text', () => {
		expect(compareEngineVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
		expect(compareEngineVersions('0.9.0', '0.10.0')).toBeLessThan(0);
		expect(compareEngineVersions('1.2.3', '1.2.3')).toBe(0);
		expect(() => compareEngineVersions('1.2', '1.2.0')).toThrow(/not an engine version/);
	});

	it('gives nothing for a version that is not x.y.z (a legacy or hand-made run)', () => {
		expect(errataFor('legacy', list)).toEqual([]);
	});

	it('the committed errata all describe older engines than this one, or are still open', () => {
		for (const x of ENGINE_ERRATA) {
			if (x.fixedIn) expect(compareEngineVersions(x.fixedIn, ENGINE_VERSION), x.id).toBeLessThanOrEqual(0);
		}
	});
});
