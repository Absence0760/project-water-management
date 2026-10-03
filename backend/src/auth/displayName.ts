// A person's display name (app_user.display_name): what every member list,
// invitation email, farm's "who can see my farm" and share-link comment
// shows for them. Read as text, never markup, but a name that renders as
// nothing (only zero-width or other invisible characters), or one that
// reorders the words around it (Unicode bidi embedding, override and isolate
// controls: "Ann‮nimda" shows as "Annadmin"), would put a blank or a
// spoofed name in front of everyone they work with. So:
//   - every run of whitespace, line breaks included, is one space;
//   - control characters and the bidi embedding/override/isolate controls
//     (U+202A–202E, U+2066–2069) are dropped (the plain marks LRM and RLM, and
//     the joiners some scripts need, are kept);
//   - what is left, trimmed, must hold a letter, digit, symbol or punctuation
//     mark, and be 1–100 characters (001_init's check).
import { z } from 'zod';

const INVISIBLE = /[\p{Cc}‪-‮⁦-⁩]/gu;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/** The name as stored: whitespace runs as one space, controls dropped, trimmed. */
export const cleanDisplayName = (raw: string): string => raw.replace(/\s+/g, ' ').replace(INVISIBLE, '').trim();

export const displayName = z
	.string()
	.transform(cleanDisplayName)
	.pipe(z.string().min(1).max(100).regex(VISIBLE, 'a display name needs at least one visible character'));
