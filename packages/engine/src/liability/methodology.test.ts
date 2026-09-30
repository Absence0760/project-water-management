// The methodology statement's versions and hashes are generated from
// docs/methodology (WP-3.13): recomputed here from the files, so a stale
// module or an edit to a published version fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMethodologyVersions } from '../../scripts/methodologyFiles';
import { renderMethodologyModule, renderMethodologyTextModule } from './generate';
import { methodologyVersionOf, sortMethodologyVersions } from './methodology';
import { METHODOLOGY_TEXT, METHODOLOGY_VERSION } from './methodology-text.generated';
import { METHODOLOGY, METHODOLOGY_VERSIONS } from './methodology.generated';

const DIR = fileURLToPath(new URL('../../../../docs/methodology', import.meta.url));
const GENERATED = fileURLToPath(new URL('./methodology.generated.ts', import.meta.url));
const TEXT = fileURLToPath(new URL('./methodology-text.generated.ts', import.meta.url));

/**
 * The hash of every version ever cited. A published version is never edited
 * (docs/methodology/README.md): add a line here when you add a version, and
 * never change one. A failure on an existing line means a published
 * statement was edited; restore it and write the change as a new version.
 */
const PUBLISHED: Record<string, string> = {
	'methodology-1': '8f26d0e2f723b302a0a499f6072db8c3c6ad35f4d12dc90f1501a2357cfcad88'
};

describe('methodology statement (generated from docs/methodology)', () => {
	const { versions, currentText } = readMethodologyVersions(DIR);

	it('is current: regenerate with `pnpm gen:liability` after adding a version', () => {
		expect(METHODOLOGY_VERSIONS).toEqual(versions);
		expect(readFileSync(GENERATED, 'utf8')).toBe(renderMethodologyModule(versions));
		expect(readFileSync(TEXT, 'utf8')).toBe(renderMethodologyTextModule(versions[versions.length - 1]!, currentText));
	});

	it('never changes a published version', () => {
		for (const v of versions) expect(v.sha256, `${v.version} was edited; publish the change as a new version`).toBe(PUBLISHED[v.version]);
		expect(Object.keys(PUBLISHED).sort()).toEqual(versions.map((v) => v.version).sort());
	});

	it('cites the highest version as current, with its own text', () => {
		expect(METHODOLOGY).toEqual(versions[versions.length - 1]);
		expect(METHODOLOGY_VERSION).toBe(METHODOLOGY.version);
		expect(METHODOLOGY_TEXT).toContain(`Methodology statement \`${METHODOLOGY.version}\``);
	});

	it('names versions from their files, and orders them by number', () => {
		expect(methodologyVersionOf('v1.md')).toBe('methodology-1');
		expect(methodologyVersionOf('v12.md')).toBe('methodology-12');
		for (const f of ['README.md', 'v0.md', 'v01.md', 'v1.txt', 'draft.md']) expect(methodologyVersionOf(f), f).toBeNull();
		expect(sortMethodologyVersions([{ version: 'methodology-10' }, { version: 'methodology-2' }, { version: 'methodology-1' }]).map((v) => v.version)).toEqual([
			'methodology-1',
			'methodology-2',
			'methodology-10'
		]);
	});
});
