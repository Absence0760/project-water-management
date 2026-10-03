// The names people give each other to read: a person's display name
// (app_user.display_name), a team's name and a project's name. They show in
// every member list, invitation email, project list, share page, farm's "who
// can see my farm" and share-link comment. Read as text, never markup, but a
// name that renders as nothing (only zero-width or other invisible
// characters), or one that reorders the words around it (Unicode bidi
// embedding, override and isolate controls: "Ann‮nimda" shows as
// "Annadmin"), would put a blank or a spoofed name in front of everyone who
// reads it. So, for every such name:
//   - every run of whitespace, line breaks included, is one space;
//   - control characters and the bidi embedding/override/isolate controls
//     (U+202A–202E, U+2066–2069) are dropped (the plain marks LRM and RLM, and
//     the joiners some scripts need, are kept);
//   - what is left, trimmed, must hold a letter, digit, symbol or punctuation
//     mark, and fit the column's length (counted after cleaning).
// The frontend checks the same rule before it sends (lib/text/visibleName.ts).
import { z } from 'zod';

const INVISIBLE = /[\p{Cc}‪-‮⁦-⁩]/gu;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/** The name as stored: whitespace runs as one space, controls dropped, trimmed. */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').replace(INVISIBLE, '').trim();

/** A name schema: cleaned, then 1–`max` characters with at least one visible one. `what` starts the refusal ("a team name"). */
export const visibleName = (max: number, what: string) =>
	z
		.string()
		.transform(cleanName)
		.pipe(z.string().min(1).max(max).regex(VISIBLE, `${what} needs at least one visible character`));

/** A person's display name: 1–100 characters (001_init's check). */
export const displayName = visibleName(100, 'a display name');
/** A team's name: 1–200 characters. */
export const teamName = visibleName(200, 'a team name');
/** A project's name: 1–200 characters. */
export const projectName = visibleName(200, 'a project name');
