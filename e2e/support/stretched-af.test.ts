// The stand-in Afrikaans catalogue the layout spec serves (support/stretched-af.ts).
// Run by `pnpm test` (node:test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stretch, stretchedCatalogue } from './stretched-af.ts';

test('every word of three letters or more is about a third longer', () => {
	assert.equal(stretch('Your dam'), 'Youryo damda');
	assert.equal(stretch('Water'), 'Waterwa');
	const english = 'Water you needed and received each month';
	assert.ok(stretch(english).length >= english.length * 1.3);
});

test('placeholders and bold marks are left as they are, so the app still fills them', () => {
	assert.equal(stretch('about **{pct}** of the water'), 'aboutab **{pct}** of theth waterwa');
	assert.equal(stretch('{n} days'), '{n} daysda');
});

test('the catalogue covers every message on the sheet, so the page switches to lang="af"', async () => {
	const { MESSAGE_COUNT } = await import('../../frontend/src/lib/i18n/messages/ids.generated.ts');
	const catalogue = await stretchedCatalogue();
	assert.equal(Object.keys(catalogue).length, MESSAGE_COUNT);
});
