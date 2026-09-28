// The known limitations are generated from docs/engine-audit.md (WP-3.13):
// the committed list must be exactly what the doc says today, and it must
// follow an item's status when the doc changes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderLimitationsModule } from './generate';
import { isOpenDecision, parseAuditLimitations, plainMarkdown } from './limitations';
import { KNOWN_LIMITATIONS } from './limitations.generated';

const AUDIT = fileURLToPath(new URL('../../../../docs/engine-audit.md', import.meta.url));
const GENERATED = fileURLToPath(new URL('./limitations.generated.ts', import.meta.url));
const doc = readFileSync(AUDIT, 'utf8');

describe('KNOWN_LIMITATIONS (generated from docs/engine-audit.md)', () => {
	it('is current: regenerate with `pnpm gen:limitations` after changing an audit item', () => {
		const parsed = parseAuditLimitations(doc);
		expect(KNOWN_LIMITATIONS).toEqual(parsed);
		// The file itself, byte for byte, so a hand edit fails too.
		expect(readFileSync(GENERATED, 'utf8')).toBe(renderLimitationsModule(parsed));
	});

	it('lists every open item of both tables, and no closed one', () => {
		const ids = KNOWN_LIMITATIONS.map((l) => l.id);
		// Open today: a decided-but-pending finding, a warned one, a pending quirk.
		for (const id of ['N1', 'B3', 'Q17']) expect(ids).toContain(id);
		// Fixed or removed: never a limitation (H1: the legacy runoff model, removed in engine 1.0.0).
		for (const id of ['H1', 'E1', 'E2', 'R1', 'G1', 'P1', 'T1', 'Q1', 'Q7', 'Q14']) expect(ids).not.toContain(id);
		for (const l of KNOWN_LIMITATIONS) {
			expect(l.title.length, l.id).toBeGreaterThan(5);
			expect(l.status.length, l.id).toBeGreaterThan(5);
			expect(l.title + l.status, l.id).not.toMatch(/\*\*|`|\]\(/);
		}
	});

	it('drops an item whose decision becomes Fixed, and adds one that becomes pending', () => {
		const n1Row = doc.split('\n').find((l) => l.startsWith('| **N1** |'))!;
		const cells = n1Row.split(' | ');
		cells[cells.length - 1] = '**Fixed.** Confirmed by the hydrologist. |';
		const fixedN1 = doc.replace(n1Row, cells.join(' | '));
		expect(parseAuditLimitations(fixedN1).map((l) => l.id)).not.toContain('N1');

		const e2Row = doc.split('\n').find((l) => l.startsWith('| **E2** |'))!;
		const e2 = e2Row.split(' | ');
		e2[e2.length - 1] = '**Reopened (2026-10-01; Needs hydrologist).** The clamp hides a steep table head. |';
		const reopened = parseAuditLimitations(doc.replace(e2Row, e2.join(' | ')));
		expect(reopened.find((l) => l.id === 'E2')).toEqual({
			id: 'E2',
			source: 'finding',
			severity: 'Low',
			title: 'A pulse index below 1 (ShiftPeakIndexLo = 0.9) extrapolates below the first factor',
			status: 'Reopened (2026-10-01; Needs hydrologist)'
		});
	});

	it('refuses a doc whose tables it can no longer find, rather than returning an empty list', () => {
		expect(() => parseAuditLimitations(doc.replace('## Findings', '## Results'))).toThrow(/Findings/);
	});
});

describe('isOpenDecision', () => {
	it.each([
		['**Fixed.** The factor is clamped at 0.', false],
		['**Removed (operator decision, 2026-09-24).**', false],
		['**Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0.**', true],
		['**Warned, engine 0.18.0 (CR-20).**', true],
		['**Built (engine 0.23.0), off by default; pending the hydrologist.**', true],
		['Needs hydrologist: recommendation below.', true],
		['Sound (the shares are normalised).', false]
	])('%s → %s', (d, open) => expect(isOpenDecision(d)).toBe(open));
});

describe('plainMarkdown', () => {
	it('drops emphasis, code ticks, link targets and citations', () => {
		expect(plainMarkdown('**Bold** *it* `code` [text](./x.md) runoff ([Beven 2012]) and [WR2012]')).toBe('Bold it code text runoff and WR2012');
	});
});

describe('plainMarkdown on a run of brackets', () => {
	// Link text could contain "[", so each "[" of a long run rescanned the rest (CodeQL js/polynomial-redos).
	it('returns it unchanged, and still unwraps a link after it', () => {
		const run = '['.repeat(200_000);
		expect(plainMarkdown(run)).toBe(run);
		expect(plainMarkdown(`[[[ [text](./x.md)`)).toBe('[[[ text');
		expect(plainMarkdown(`a${' '.repeat(200_000)}b`)).toBe('a b');
		expect(plainMarkdown('runoff \n\t ([Beven 2012]) and [[WR2012]]')).toBe('runoff and [WR2012]');
	});

	// A link target could contain "(", so each "[(](" rescanned the rest of the cell: ~15 s for this
	// string before; the timeout is a hang guard, not a budget (linear time takes a millisecond).
	it('handles a long run of "[(](" with no ")" (a link target excludes "(")', () => {
		const links = `[Z](${'[(]('.repeat(100_000)}`;
		expect(plainMarkdown(links)).toBe(`Z(${'(('.repeat(100_000)}`);
	}, 5_000);
});
