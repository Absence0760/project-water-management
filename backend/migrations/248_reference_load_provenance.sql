-- 248_reference_load_provenance — reference_load records where a dataset came
-- from upstream, and the map's tile archives are recorded too (issue #604
-- R3-D; docs/deployment.md § Reference datasets, Which file is loaded and
-- Refreshing a dataset).
--
-- In this file:
--  * reference_load (192, widened by 225 and 238) takes the kind 'tiles': one
--    row per archive the tiles bucket serves, its dataset the archive's name
--    ('basemap', 'fonts', 'terrain', 'water'; geo/referenceOrigin.ts
--    TILE_ARCHIVES). source_key is the archive's served key
--    ('tiles/terrain.pmtiles', 'tiles/fonts/' for the glyph ranges) and
--    source_sha256 our SHA-256 of it (of the glyph files' listing, for the
--    fonts). backend/scripts/tiles-upload.ts writes it: locally straight into
--    the dev database, in production through load-reference.yml's `tiles`
--    kind, which reads the provenance file tiles-upload.ts put in the
--    reference bucket (geo/referenceLoad.ts).
--  * Seven nullable columns, for any kind: the upstream's URL, version, ETag
--    and Last-Modified as the operator's download saw them; the licence the
--    dataset is used under (recorded from the code's table, never the file);
--    and the original downloads kept in the reference bucket under
--    originals/<dataset>/<file>, each with its SHA-256, so a dataset can be
--    re-derived without the upstream. A table load records none of them yet
--    (its dataset row carries its source and version); null means unknown,
--    never empty.
--  * app_reference_provenance(): the app's one read of it (the Map's dataset
--    lines, geo/referenceOrigin.ts referenceProvenance). The table stays
--    owner-only (RLS on, no policy, no grant: catalogue.db.test.ts OWNER_ONLY);
--    the function returns the kind, dataset, version, upstream date, licence
--    and when it was recorded, never a bucket key, hash or ETag.

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles'));

ALTER TABLE reference_load
	ADD COLUMN upstream_url           text CHECK (char_length(upstream_url) <= 500 AND upstream_url ~ '^https://[^[:space:]]+$'),
	ADD COLUMN upstream_version       text CHECK (char_length(upstream_version) BETWEEN 1 AND 100 AND upstream_version !~ '[\u0001-\u001f]'),
	ADD COLUMN upstream_etag          text CHECK (char_length(upstream_etag) BETWEEN 1 AND 200 AND upstream_etag !~ '[\u0001-\u001f]'),
	ADD COLUMN upstream_last_modified timestamptz,
	ADD COLUMN licence                text CHECK (char_length(licence) BETWEEN 1 AND 300 AND licence !~ '[\u0001-\u001f]'),
	-- [{ "key": "originals/<dataset>/<file>", "sha256": "<hex>", "bytes": n }, …] (at most 50).
	ADD COLUMN originals              jsonb CHECK (jsonb_typeof(originals) = 'array' AND jsonb_array_length(originals) BETWEEN 1 AND 50);

-- A tiles row names one of the four archives; its key is where that archive is served.
ALTER TABLE reference_load ADD CONSTRAINT reference_load_tiles_archive CHECK (
	kind <> 'tiles'
	OR (dataset = 'basemap' AND source_key = 'tiles/south-africa.pmtiles')
	OR (dataset = 'fonts' AND source_key = 'tiles/fonts/')
	OR (dataset = 'terrain' AND source_key = 'tiles/terrain.pmtiles')
	OR (dataset = 'water' AND source_key = 'tiles/water.pmtiles')
);

COMMENT ON TABLE reference_load IS
	'Which file each production-loaded reference dataset or served tile archive came from: its key and SHA-256 (192), and its upstream URL, version, ETag, Last-Modified, licence and the originals kept in the reference bucket (248). Written with the dataset, cleared by any other replace of it. Owner-only; the app reads it through app_reference_provenance().';

-- The Map's dataset lines show an archive's upstream version and date from here.
CREATE OR REPLACE FUNCTION app_reference_provenance()
	RETURNS TABLE (kind text, dataset text, upstream_version text, upstream_last_modified timestamptz, licence text, loaded_at timestamptz)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT r.kind, r.dataset, r.upstream_version, r.upstream_last_modified, r.licence, r.loaded_at
		FROM reference_load r
		ORDER BY r.kind, r.dataset
	$$;

REVOKE ALL ON FUNCTION app_reference_provenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reference_provenance() TO water_app;
