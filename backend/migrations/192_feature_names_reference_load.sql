-- 192_feature_names_reference_load — map feature names are one line, and a
-- reference load records the file it came from.
--
-- 1. Map feature names (issue #385's follow-up; docs/followups.md § One-line
--    names). The Map draws a feature's name as its label, and a line break,
--    tab or other control character there renders broken, as in a model
--    name (189_one_line_names). The feature routes now refuse them
--    (geo/routes.ts `Name`, the delineation accept), and the bulk readers
--    clean them (geo/geojson.ts featureNameOf: a GeoJSON file's names, the
--    river loader's). This cleans what is stored the same way, as the
--    engine's cleanName does: every run of whitespace and control characters
--    one space, trimmed, then cut to the column's 100 characters. A feature
--    name may be empty and needn't be unique, so there is no fallback and no
--    renumbering. Then a CHECK holds the column to it. The river network's
--    reach names (river_reference, 171) are copied into features when a
--    reach is added, so they are cleaned and held the same way.
--
-- 2. reference_load (round 4 infra audit, data finding 4; docs/deployment.md
--    § Reference datasets, Which file is loaded). A production load checks the
--    uploaded file's SHA-256 and then dropped it: once the Actions log
--    expired, nothing said which file a dataset came from or which bucket
--    version to restore. One row per (kind, dataset), written in the same
--    transaction as the dataset by the replace functions (geo/croplandGrid.ts,
--    geo/evaporationGrid.ts, geo/loadRivers.ts) when the load names a file,
--    and deleted by any other replace of that dataset (a local `pnpm
--    import:*`), so a row never outlives the data it describes. Rivers have
--    no dataset table of their own, so this is keyed by kind and label
--    rather than by a foreign key. Owner-only: the migrate Lambda and the
--    import scripts write it as the schema owner, and the app never reads it
--    (RLS on, no policy, no grant; like erasure_log).

-- The characters are the engine's NAME_CONTROL_CHARS (text can't hold NUL).
UPDATE map_feature
SET name = btrim(left(btrim(regexp_replace(name, '[[:space:]\u0001-\u001f\u007f-\u009f  ]+', ' ', 'g')), 100))
WHERE name ~ '[\u0001-\u001f\u007f-\u009f  ]';

UPDATE river_reference
SET name = btrim(left(btrim(regexp_replace(name, '[[:space:]\u0001-\u001f\u007f-\u009f  ]+', ' ', 'g')), 100))
WHERE name ~ '[\u0001-\u001f\u007f-\u009f  ]';

ALTER TABLE map_feature ADD CONSTRAINT map_feature_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f  ]');
ALTER TABLE river_reference ADD CONSTRAINT river_reference_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f  ]');

CREATE TABLE reference_load (
	-- geo/referenceLoad.ts REFERENCE_KINDS' allowed kinds.
	kind           text NOT NULL CHECK (kind IN ('land-cover', 'evaporation', 'rivers')),
	dataset        text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- The object's key in the reference bucket (reference/<kind>/<file>), as parseLoadRequest checked it.
	source_key     text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 300),
	-- SHA-256 (hex) of the object the load read and checked.
	source_sha256  text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
	loaded_at      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (kind, dataset)
);

COMMENT ON TABLE reference_load IS
	'Which file each production-loaded reference dataset came from: its key in the reference bucket and SHA-256 (192). Written with the dataset, cleared by any other replace of it. Owner-only.';

ALTER TABLE reference_load ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reference_load FROM PUBLIC, water_app;
