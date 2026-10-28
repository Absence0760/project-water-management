// The assistant's help index (backend/src/assistant/helpIndex.json, issue #610)
// is the frontend's help text copied for the backend: this fails until
// `pnpm gen:assistant:help` (scripts/gen-assistant-help.mjs) is rerun after a
// guide or glossary entry changes, so search_help never answers from old text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildIndex, INDEX_PATH, plain, serialize } from '../gen-assistant-help.mjs';

describe('plain', () => {
	const terms = new Map([['ewr', 'EWR (Environmental Water Requirement)']]);
	it('turns links into their label or term, and drops bold', () => {
		assert.equal(plain('See [[guide:add-data|Upload data]] and the [[ewr]], **now**.', terms), 'See Upload data and the EWR (Environmental Water Requirement), now.');
		assert.equal(plain('An [[unknown-term]]\n\nhere', terms), 'An unknown term here');
	});
});

describe('helpIndex.json', () => {
	it('is current with the help guides and the glossary (else run pnpm gen:assistant:help)', async () => {
		const index = await buildIndex();
		assert.ok(index.entries.some((e) => e.kind === 'guide'));
		assert.ok(index.entries.some((e) => e.kind === 'glossary'));
		assert.equal(readFileSync(INDEX_PATH, 'utf8'), serialize(index), 'backend/src/assistant/helpIndex.json is stale: run pnpm gen:assistant:help');
	});

	it('holds plain text: no link or bold markup left', async () => {
		for (const e of (await buildIndex()).entries) assert.doesNotMatch(`${e.title} ${e.summary ?? ''} ${e.text}`, /\[\[|\*\*/, e.id);
	});
});
