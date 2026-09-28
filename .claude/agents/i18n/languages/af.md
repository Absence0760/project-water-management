# Afrikaans (af)

South African Afrikaans for irrigation farmers — the readers are mostly on
a phone, many of them first-language Afrikaans speakers who know water,
dams, pumps and their WUA well but aren't hydrologists.

## Register

Address the farmer as **jy / jou** (the app speaks to a farmer the way a
neighbour would), never **u**. Plain, friendly, direct; short sentences.
Buttons are imperatives ("Probeer weer", "Stoor", "Teken in"); a status
line like "Saving…" keeps the ellipsis ("Stoor tans…").

## Spelling authority

Standard Afrikaans spelling and grammar: **AWS** (Afrikaanse Woordelys en
Spelreëls) / **HAT** (Handwoordeboek van die Afrikaanse Taal). Watch verb
placement, the double negative "nie … nie" where needed, the apostrophe in
**'n**, and diaeresis / circumflex ("reën", "skêr", "wêreld").

## South African usage

"e-pos", "wagwoord", "teken in" / "teken uit", "rekening", "boer", "plaas",
"dam", "rivier", "reën", "stroomaf", "stroomop", "opvanggebied" for
catchment, "WGV" for WUA. "m³" and "ML" stay unchanged (never translated).

## Terminology (docs/design/farmer-view.md §5.1)

One Afrikaans term per English word, the same everywhere it appears:
"gelyke deel" (even share), "die rivier se reserwe" (the river's reserve),
"pomp minder" (pump less), "deur die model bereken" (calculated by the
model), "die WGV" (the WUA), "hidrologiese eenheid" / "hidrologiese
eenhede" (hydrological unit, the app's name for a farm node since issue #90
Q6; "jou hidrologiese eenheid", "die bladsy oor jou hidrologiese eenheid"
for "your hydrological unit page"; never "plaas" for the node, though
"boer" stays for the farmer and "plaasdam" for a farm dam). §5.1 has the
fuller table, and the words to avoid.

## Ordinal forms

1ste, 2de, 3de, 4de … 8ste, 9de … 20ste; follow the English row's pattern
with `{n}`.

## Provenance

Every farmer-facing string was first translated 2026-09-26 (issue #49): 505
site messages, 70 email strings and the 8 farmer glossary entries. The
strings that named a farm node were re-translated 2026-09-28 for "hydrological
unit" (issue #90 Q6): 64 site messages, 4 email strings and the 8 glossary
entries. No
native speaker has reviewed it yet (docs/followups.md § Afrikaans) — flag
anything you're unsure of rather than guessing.
