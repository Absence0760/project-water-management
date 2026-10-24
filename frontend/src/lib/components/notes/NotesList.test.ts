// The in-app objection warning (166_public_participation; issue #523 G9 (c)):
// a public-participation comment box says, beside it, that a comment is not a
// written objection and who receives it, with the register opt-in; no other
// box does. Rendered to HTML with Svelte's server renderer, so the form is
// the one a caller first sees (its natural audience); choosing another
// audience in the browser is pinned by e2e/tests/scenario-share.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import NotesList from './NotesList.svelte';
import { OBJECTION_WARNING, PUBLIC_COMMENT_RECIPIENTS, REGISTER_CONSENT_LABEL, packAudiences, scenarioAudiences, type NoteTarget } from './notes';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
// NotesList imports the app's API instance (nothing is fetched: the server renderer runs no onMount).
vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

const html = (target: NoteTarget, canWrite = true) => render(NotesList, { props: { projectId: 'p1', target, canWrite } }).body;
const scenario = (who: { assessor: boolean; party: boolean }): Extract<NoteTarget, { kind: 'scenario' }> => ({ kind: 'scenario', scenarioId: 's1', name: 'Raise the weir dam', audiences: scenarioAudiences(who) });
/** Svelte escapes text: compare against the same escaping. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

describe('the in-app objection warning', () => {
	it('stands beside a public comment box: not a written objection, who receives it, and the register opt-in', () => {
		// Anyone who is neither an assessor nor a party comments for public participation only.
		const out = html(scenario({ assessor: false, party: false }));
		expect(out).toContain('data-testid="note-objection-warning"');
		expect(out).toContain(esc(OBJECTION_WARNING));
		expect(out).toContain(esc(PUBLIC_COMMENT_RECIPIENTS));
		expect(out).toContain('data-testid="note-register-consent"');
		expect(out).toContain(esc(REGISTER_CONSENT_LABEL));
	});

	it('is not beside a box that writes to the assessors, the parties or the team (control above)', () => {
		for (const target of [
			scenario({ assessor: true, party: false }),
			scenario({ assessor: false, party: true }),
			{ kind: 'pack' as const, packId: 'k1', name: 'Pack v1', audiences: packAudiences(true) },
			{ kind: 'pack' as const, packId: 'k1', name: 'Pack v1', audiences: packAudiences(false) }
		] satisfies NoteTarget[]) {
			const out = html(target);
			const what = `${target.kind}: ${target.audiences.join(', ')}`;
			expect(out, what).toContain('<form');
			expect(out, what).not.toContain('note-objection-warning');
			expect(out, what).not.toContain('note-register-consent');
		}
	});

	it('goes with the box: a reader who can’t write sees neither', () => {
		const out = html(scenario({ assessor: false, party: false }), false);
		expect(out).not.toContain('<form');
		expect(out).not.toContain('note-objection-warning');
	});
});
