// Issue #58's proof on the API side: the notice takes every language of the
// table, so a stand-in third language added to the table (tests only, never
// shipped) is accepted with no other change, and a code the table doesn't
// list is still refused.
import { describe, expect, it, vi } from 'vitest';
import { NoticeTextBody, RestrictionBody } from './publish.js';

vi.mock('@water-management/engine/languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('@water-management/engine/languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});

describe('the notice with a stand-in language in the table', () => {
	it('accepts the new code, trimmed, and keeps refusing unknown ones', () => {
		expect(NoticeTextBody.parse({ xx: '  [xx] Irrigate at night ', en: 'Irrigate at night' })).toEqual({ en: 'Irrigate at night', xx: '[xx] Irrigate at night' });
		expect(RestrictionBody.parse({ level: 'advisory', notice: { xx: '[xx] Save water' } })).toEqual({ level: 'advisory', pct: null, notice: { xx: '[xx] Save water' } });
		const bad = NoticeTextBody.safeParse({ xx: 'ok', de: 'Nachts bewässern' });
		expect(bad.success).toBe(false);
		expect(bad.error?.issues[0]?.message).toBe('unknown language "de"; the notice takes en, af, xx');
	});
});
