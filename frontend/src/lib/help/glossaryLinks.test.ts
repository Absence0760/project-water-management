import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORY_TITLES, HELP } from './content';
import {
	TOPIC_SLUGS,
	glossaryPath,
	topicForSlug,
	topicPath,
} from './glossaryLinks';
import type { HelpCategory } from './types';

describe('glossary links: one page per topic (issue #162)', () => {
	const categories = Object.keys(CATEGORY_TITLES) as HelpCategory[];

	it('gives every topic its own URL-safe slug, and finds the topic by it', () => {
		expect(Object.keys(TOPIC_SLUGS).sort()).toEqual([...categories].sort());
		const slugs = categories.map((c) => TOPIC_SLUGS[c]);
		expect(new Set(slugs).size).toBe(slugs.length);
		for (const c of categories) {
			expect(TOPIC_SLUGS[c]).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(topicForSlug(TOPIC_SLUGS[c])).toBe(c);
			expect(topicPath(c)).toBe(`/help/glossary/${TOPIC_SLUGS[c]}`);
		}
		expect(topicForSlug('nope')).toBeUndefined();
		expect(topicForSlug('')).toBeUndefined();
	});

	it('links each entry to its topic page and its anchor', () => {
		const dam = HELP.find((e) => e.id === 'dam-capacity')!;
		expect(glossaryPath(dam)).toBe(
			'/help/glossary/units-and-dams#dam-capacity',
		);
		for (const e of HELP)
			expect(glossaryPath(e)).toBe(`${topicPath(e.category)}#${e.id}`);
	});

	// The one-page glossary's links (/help/glossary#<id>) still work, via a
	// redirect, but cost a second navigation: nothing in the app writes one.
	it('leaves no link in the app pointing at the old one-page glossary', () => {
		const root = fileURLToPath(new URL('../..', import.meta.url)); // frontend/src
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const d of readdirSync(dir, { withFileTypes: true })) {
				const name = d.name;
				const p = join(dir, name);
				if (d.isDirectory()) walk(p);
				else if (/\.(svelte|ts)$/.test(name) && !name.endsWith('.test.ts')) {
					const src = readFileSync(p, 'utf8');
					if (
						/help\/glossary#\{|help\/glossary#\$\{|href='[^']*help\/glossary#/.test(
							src,
						)
					)
						offenders.push(p.slice(root.length));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
