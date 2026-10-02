// The shared pieces of the map-proposal panels (ProposalPanel.svelte's
// siblings): the no-dataset notice naming the operator's loader, the
// synthetic-data warning and the collapsed citation. The panels' e2e specs
// load the synthetic datasets, so the no-dataset wording is pinned here.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ProposalNoDataset from './ProposalNoDataset.svelte';
import ProposalSource from './ProposalSource.svelte';
import ProposalSynthetic from './ProposalSynthetic.svelte';

// Comments stripped until none are left (CodeQL js/incomplete-multi-character-sanitization).
const text = (html: string) => {
	let s = html;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

describe('the map-proposal panels’ shared pieces', () => {
	it('no dataset: says what is missing, what follows, and the operator’s command', () => {
		const html = render(ProposalNoDataset, { props: { testid: 'x-no-dataset', what: 'evaporation grid', consequence: 'nothing is proposed', command: 'pnpm import:evaporation' } }).body;
		expect(html).toContain('data-testid="x-no-dataset"');
		expect(html).toContain('<code>pnpm import:evaporation</code>');
		expect(text(html)).toBe('No evaporation grid is loaded, so nothing is proposed. The operator loads one with pnpm import:evaporation (docs/maps.md).');
	});

	it('synthetic data: a warning naming the real dataset it is not', () => {
		const html = render(ProposalSynthetic, { props: { testid: 'x-synthetic', subject: 'The register', notWhat: 'the DWS list', forWhat: 'dam' } }).body;
		expect(html).toMatch(/class="alert alert-warning[^"]*"/);
		expect(text(html)).toBe('Synthetic test data. The register loaded here is invented for development and tests, not the DWS list. Never use it for a real dam.');
	});

	it('source and method: collapsed, the citation under its test id', () => {
		const html = render(ProposalSource, { props: { testid: 'x-source', citation: 'dPET (v3). CC BY 4.0', method: 'Summed by month.' } }).body;
		expect(html).toMatch(/<details[^>]*>\s*<summary>Source and method<\/summary>/);
		expect(html).not.toMatch(/<details[^>]*\bopen\b/);
		expect(html).toMatch(/data-testid="x-source"[^>]*>dPET \(v3\)\. CC BY 4\.0</);
		expect(text(html)).toContain('Summed by month.');
	});
});
