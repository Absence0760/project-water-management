import { describe, expect, it } from 'vitest';
import { NOTE_MAX, type NoteCounts } from '$lib/api/types';
import {
	AUDIENCE_BADGE,
	AUDIENCE_LABEL,
	bodyProblem,
	countFor,
	createBody,
	hasAudiences,
	normaliseBody,
	noteAbout,
	packAudiences,
	noteHref,
	notesButtonLabel,
	scenarioAudiences,
	settingTarget,
	targetQuery,
	targetTitle,
	type NoteTarget
} from './notes';

const farm: NoteTarget = { kind: 'node', nodeId: 'n1', name: 'Farm A', isFarm: true };
const gauge: NoteTarget = { kind: 'node', nodeId: 'g1', name: 'Weir', isFarm: false };
const run: NoteTarget = { kind: 'run', runId: 'r1', label: 'Baseline' };

describe('targetQuery', () => {
	it('asks for exactly the notes on the target', () => {
		expect(targetQuery({ kind: 'project' })).toEqual({ target: 'project' });
		expect(targetQuery(farm)).toEqual({ nodeId: 'n1' });
		expect(targetQuery(run)).toEqual({ runId: 'r1' });
		expect(targetQuery(settingTarget('flow'))).toEqual({ settingKey: 'flow' });
	});
});

describe('createBody', () => {
	it('shares a note with the farm only on a farm, and trims it', () => {
		expect(createBody(farm, '  Dam raised\r\nin 2019 ', 'farm')).toEqual({ body: 'Dam raised\nin 2019', nodeId: 'n1', visibility: 'farm' });
		expect(createBody(gauge, 'x', 'farm')).toEqual({ body: 'x', nodeId: 'g1', visibility: 'team' });
		expect(createBody(run, 'x', 'farm')).toEqual({ body: 'x', runId: 'r1', visibility: 'team' });
		expect(createBody({ kind: 'project' }, 'x', 'farm')).toEqual({ body: 'x', visibility: 'team' });
		expect(createBody(settingTarget('ewr'), 'x', 'team')).toEqual({ body: 'x', settingKey: 'ewr', visibility: 'team' });
	});
});

describe('countFor', () => {
	const counts: NoteCounts = { project: 2, nodes: { n1: 3 }, runs: { r1: 1 }, settings: { flow: 1, 'flow.a': 2, flowshare: 5 }, scenarios: { s1: 4 } };
	it('reads each target, and adds up a settings group by whole path segment', () => {
		expect(countFor(counts, { kind: 'project' })).toBe(2);
		expect(countFor(counts, farm)).toBe(3);
		expect(countFor(counts, gauge)).toBe(0);
		expect(countFor(counts, run)).toBe(1);
		expect(countFor(counts, settingTarget('flow'))).toBe(3);
		expect(countFor(null, farm)).toBe(0);
	});
});

describe('labels', () => {
	it('names the target in the heading and the button', () => {
		expect(targetTitle(farm)).toBe('Notes on Farm A');
		expect(targetTitle({ kind: 'project' })).toBe('Project notes');
		expect(targetTitle(settingTarget('record'))).toBe('Notes on Calibration record');
		expect(notesButtonLabel(0, 'Farm A')).toBe('Add a note on Farm A');
		expect(notesButtonLabel(2, 'Farm A')).toBe('Notes on Farm A (2)');
	});

	it('says what a note in a mixed list is about, and links to it', () => {
		expect(noteAbout({ target: 'node', nodeName: 'Farm A', settingKey: null })).toBe('Farm A');
		expect(noteAbout({ target: 'setting', nodeName: null, settingKey: 'flow.a' })).toBe('Settings: Flow calibration');
		expect(noteAbout({ target: 'setting', nodeName: null, settingKey: 'other' })).toBe('Settings: other');
		expect(noteHref({ target: 'node', nodeId: 'n1', runId: null, settingKey: null })).toBe('?tab=network&node=n1');
		expect(noteHref({ target: 'run', nodeId: null, runId: 'r/1', settingKey: null })).toBe('?tab=runs&run=r%2F1#res-notes');
		expect(noteHref({ target: 'setting', nodeId: null, runId: null, settingKey: 'ewr' })).toBe('?tab=settings#set-ewr');
		expect(noteHref({ target: 'project', nodeId: null, runId: null, settingKey: null })).toBeNull();
	});
});

describe('bodyProblem', () => {
	it('refuses an empty or too long note, counting the text as saved', () => {
		expect(bodyProblem('   ')).toMatch(/Write something/);
		expect(bodyProblem('x'.repeat(NOTE_MAX))).toBeNull();
		expect(bodyProblem(` ${'x'.repeat(NOTE_MAX)} `)).toBeNull();
		expect(bodyProblem('x'.repeat(NOTE_MAX + 1))).toMatch(/Too long/);
		expect(normaliseBody('a\r\nb\rc')).toBe('a\nb\nc');
	});
});

describe('a scenario’s comments (WP-3.15)', () => {
	const scen = (audiences = scenarioAudiences({ assessor: false, party: true })): NoteTarget => ({ kind: 'scenario', scenarioId: 's1', name: 'Raise the dam', audiences });

	it('offers each caller the audiences the server lets them post to, their natural one first', () => {
		expect(scenarioAudiences({ assessor: true, party: false })).toEqual(['assessors', 'parties', 'public_participation', 'team']);
		expect(scenarioAudiences({ assessor: false, party: true })).toEqual(['parties', 'assessors', 'public_participation']);
		expect(scenarioAudiences({ assessor: false, party: false })).toEqual(['public_participation']);
	});

	it('asks for, counts, titles and links the scenario’s notes', () => {
		expect(targetQuery(scen())).toEqual({ scenarioId: 's1' });
		expect(countFor({ project: 0, nodes: {}, runs: {}, settings: {}, scenarios: { s1: 4 } }, scen())).toBe(4);
		expect(targetTitle(scen())).toBe('Comments on “Raise the dam”');
		expect(noteAbout({ target: 'scenario', nodeName: null, settingKey: null })).toBe('A scenario');
		expect(noteHref({ target: 'scenario', nodeId: null, runId: null, settingKey: null, scenarioId: 's1' })).toBe('?tab=scenarios&scenario=s1');
	});

	it('posts with the chosen audience only when the caller has it, else their first', () => {
		expect(createBody(scen(), ' x ', 'assessors')).toEqual({ body: 'x', scenarioId: 's1', visibility: 'assessors' });
		expect(createBody(scen(['public_participation']), 'x', 'assessors')).toEqual({ body: 'x', scenarioId: 's1', visibility: 'public_participation' });
		expect(createBody(scen(), 'x', 'farm')).toEqual({ body: 'x', scenarioId: 's1', visibility: 'parties' });
	});

	it('words every audience, for the picker and the badge', () => {
		for (const v of ['team', 'farm', 'assessors', 'parties', 'public_participation'] as const) {
			expect(AUDIENCE_LABEL[v]).toBeTruthy();
			expect(AUDIENCE_BADGE[v]).toBeTruthy();
		}
		expect(AUDIENCE_LABEL.public_participation).toMatch(/your name/);
	});
});

describe('an evidence pack’s notes and comments (128_pack_share_notes)', () => {
	const pack = (audiences = packAudiences(true)): NoteTarget => ({ kind: 'pack', packId: 'p1', name: 'evidence pack v2', audiences });

	it('offers the team first, and public participation only while the pack is issued', () => {
		expect(packAudiences(true)).toEqual(['team', 'public_participation']);
		expect(packAudiences(false)).toEqual(['team']);
		expect(hasAudiences(pack())).toBe(true);
		expect(hasAudiences({ kind: 'project' })).toBe(false);
	});

	it('asks for, counts, titles and describes the pack’s notes', () => {
		expect(targetQuery(pack())).toEqual({ packId: 'p1' });
		expect(countFor({ project: 0, nodes: {}, runs: {}, settings: {}, scenarios: {}, packs: { p1: 3 } }, pack())).toBe(3);
		// An API from before packs sends no `packs`.
		expect(countFor({ project: 0, nodes: {}, runs: {}, settings: {}, scenarios: {} }, pack())).toBe(0);
		expect(targetTitle(pack())).toBe('Notes and comments on evidence pack v2');
		expect(noteAbout({ target: 'pack', nodeName: null, settingKey: null })).toBe('An evidence pack');
		expect(noteHref({ target: 'pack', nodeId: null, runId: null, settingKey: null })).toBeNull();
	});

	it('posts with the audience asked for when it is offered, else the first', () => {
		expect(createBody(pack(), ' x ', 'public_participation')).toEqual({ body: 'x', packId: 'p1', visibility: 'public_participation' });
		expect(createBody(pack(packAudiences(false)), 'x', 'public_participation')).toEqual({ body: 'x', packId: 'p1', visibility: 'team' });
	});
});
