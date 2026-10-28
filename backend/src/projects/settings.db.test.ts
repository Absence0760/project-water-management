// The retired flow-share settings (engine 1.105.0, issue #616): settings.flowShareMethod
// and settings.hiLoSplit. Every unit's share is its natural MAR share, so an older web
// build's patch that still carries them saves, stored without them; a row an older
// backend stored with them reads without them, and the next save drops them
// (migration 266 strips the stored rows; projects/settings.ts mergeSettings).
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, signUp } from '../__tests__/helpers.js';

const RETIRED = ['flowShareMethod', 'hiLoSplit'];
const stored = async (projectId: string) => ((await asOwner('SELECT settings FROM project WHERE id = $1', [projectId]))[0] as { settings: Record<string, unknown> }).settings;

describe('the retired flow-share settings (issue #616)', () => {
	it('an older client’s patch with them is accepted and stored without them, the rest of the patch kept', async () => {
		const u = await signUp('Oldpatch');
		const projectId = (await u.call('POST', '/projects', { name: 'Old patch' })).body.project.id as string;
		const res = await u.call('PATCH', `/projects/${projectId}`, { settings: { flowShareMethod: 'hiLo', hiLoSplit: { hi: 0.7, lo: 0.3 }, lakeEvapFactor: 0.66, apanMm: monthly(150) } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const read = (await u.call('GET', `/projects/${projectId}`)).body.project.settings as Record<string, unknown>;
		expect(RETIRED.filter((k) => k in read)).toEqual([]);
		const row = await stored(projectId);
		expect(RETIRED.filter((k) => k in row)).toEqual([]);
		// The positive control: the rest of the patch went in.
		expect(read.lakeEvapFactor).toBe(0.66);
		expect(row.lakeEvapFactor).toBe(0.66);
	});

	it('a row an older backend stored with them reads without them, and the next save drops them', async () => {
		const u = await signUp('Oldrow');
		const projectId = (await u.call('POST', '/projects', { name: 'Old row' })).body.project.id as string;
		await asOwner(`UPDATE project SET settings = settings || '{"flowShareMethod": "manual", "hiLoSplit": {"hi": 0.6, "lo": 0.4}}' WHERE id = $1`, [projectId]);
		const before = await stored(projectId);
		expect(RETIRED.filter((k) => k in before)).toEqual(RETIRED);
		const read = (await u.call('GET', `/projects/${projectId}`)).body.project.settings as Record<string, unknown>;
		expect(RETIRED.filter((k) => k in read)).toEqual([]);
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactor: 0.7 } })).status).toBe(200);
		const after = await stored(projectId);
		expect(RETIRED.filter((k) => k in after)).toEqual([]);
		expect(after.lakeEvapFactor).toBe(0.7);
	});
});
