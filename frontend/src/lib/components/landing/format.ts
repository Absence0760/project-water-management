// Numbers on the landing page (issue #57), in the chosen language's decimal
// mark, digits grouped with the app's thousands separator (a narrow no-break
// space, D10): the farm pages' rule (farm/numbers.ts), without that module's
// engine import, so the landing chunk stays small (engine/format imports
// nothing).
import { groupDigits } from '@water-management/engine/format';
import { i18n, language } from '$lib/i18n/state.svelte';

/** `n` to `digits` decimals, grouped in threes: 5479 → "5 479", 41.6 → "41,6" in Afrikaans. */
export function fmt(n: number, digits = 0): string {
	const [i, d] = Math.abs(n).toFixed(digits).split('.');
	const out = groupDigits(i!) + (d ? `${language(i18n.locale).decimalMark}${d}` : '');
	return n < 0 ? `−${out}` : out;
}

/** A signed change: +4, −2, 0. */
export const signed = (n: number, digits = 0) => (n > 0 ? `+${fmt(n, digits)}` : fmt(n, digits));
