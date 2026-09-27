// `pnpm seed:demo` can run again without making copies (import:project
// --skip-existing, seed-examples.ts): both ask findOwnedProject whether the
// user already owns a project of that name. It must find only the user's own,
// by exact name, and never see across accounts. Synthetic example only.
import { describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';
import { findOwnedProject, importProjectData } from '../../scripts/import-project.js';
import { signUp } from '../__tests__/helpers.js';

const example = buildExamples({ fit: false })[1]!;

describe('findOwnedProject', () => {
	it('finds the project a user owns under that exact name, and nothing else', async () => {
		const owner = await signUp('Seedowner');
		const viewer = await signUp('Seedviewer');
		const name = `Seed catchment ${crypto.randomUUID()}`;
		expect(await findOwnedProject(owner.email, name)).toBeNull();

		const pid = await importProjectData(example, owner.email, { name });
		// Positive control: the owner's own project, found by its name (and its address in any case).
		expect(await findOwnedProject(owner.email, name)).toBe(pid);
		expect(await findOwnedProject(owner.email.toUpperCase(), name)).toBe(pid);

		// Exact name only.
		expect(await findOwnedProject(owner.email, name.toUpperCase())).toBeNull();
		expect(await findOwnedProject(owner.email, `${name} (copy)`)).toBeNull();
		// A member who isn't the owner, another user, and an unknown address find nothing.
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect(await findOwnedProject(viewer.email, name)).toBeNull();
		expect(await findOwnedProject(`nobody-${crypto.randomUUID()}@example.com`, name)).toBeNull();
	});

	it('names the oldest of several same-named projects', async () => {
		const owner = await signUp('Seedtwice');
		const name = `Twice ${crypto.randomUUID()}`;
		const first = await importProjectData(example, owner.email, { name });
		await importProjectData(example, owner.email, { name });
		expect(await findOwnedProject(owner.email, name)).toBe(first);
	});
});
