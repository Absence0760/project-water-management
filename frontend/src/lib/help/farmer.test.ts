// Every farmer word a card or page links to exists, in English and in
// Afrikaans, and the card still links to it: a renamed id or a dropped link
// would leave a farmer on /farm/words without the entry they came for.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FARMER_HELP } from './farmer';
import { HELP_AF } from './content.af';

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Each card or page, and the farmer word it links to with wordsHref. */
const LINKS: [string, string][] = [
	['../components/farm/OutlookCard.svelte', 'farm-season-outlook'],
	['../components/farm/ForecastCard.svelte', 'farm-forecast'],
	['../components/farm/RegisteredCard.svelte', 'farm-registered'],
	['../components/farm/SupplyCard.svelte', 'farm-pct-volume'],
	['../../routes/account/alerts/+page.svelte', 'farm-alerts'],
	['../components/account/TwoStepSignIn.svelte', 'farm-two-step'],
	['../../routes/account/invitations/+page.svelte', 'farm-invitation']
];

describe('the farmer words the cards link to', () => {
	it.each(LINKS)('%s links to %s, which exists in English and Afrikaans', (file, id) => {
		expect(src(file)).toContain(`wordsHref(basePath(), page.url, '${id}')`);
		const entry = FARMER_HELP.find((e) => e.id === id);
		expect(entry, id).toBeDefined();
		const af = HELP_AF[id];
		expect(af, `${id} has no Afrikaans`).toBeDefined();
		expect(af!.term).not.toBe(entry!.term);
		expect(af!.long.split('\n\n')).toHaveLength(entry!.long.split('\n\n').length);
	});

	it('tells the forecast apart from the season outlook, both ways', () => {
		const forecast = FARMER_HELP.find((e) => e.id === 'farm-forecast')!;
		expect(forecast.related).toContain('farm-season-outlook');
		expect(forecast.long).toContain('It is not the season outlook.');
		expect(FARMER_HELP.find((e) => e.id === 'farm-season-outlook')!.related).toContain('farm-forecast');
	});

	it('sends a farmer to farm-two-step, and anyone with the workspace to its guide', () => {
		const box = src('../components/account/TwoStepSignIn.svelte');
		expect(box).toMatch(/\{#if inFarmFrame\(\)\}<a href=\{wordsHref\(basePath\(\), page\.url, 'farm-two-step'\)\}>[^{]*\{t\('How two-step sign-in works'\)\}<\/a>\{:else\}<a href=\{resolve\('help\/guides\/two-step-sign-in'\)\}>/);
	});

	it('says on the signed-out reset pages what happens next, since the words need a sign-in', () => {
		const line = "t('Nothing else changes: your password and everything in your account stay as they are.')";
		expect(src('../../routes/mfa-reset/+page.svelte')).toContain(line);
		expect(src('../../routes/login/+page.svelte')).toContain(line);
		// The farmer word says the same.
		expect(FARMER_HELP.find((e) => e.id === 'farm-two-step')!.long).toContain('nothing else about your account changes');
	});
});
