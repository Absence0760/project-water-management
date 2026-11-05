-- 315_allocation_demo_source — demo registered users, loaded and removed
-- through the app (docs/allocations.md § Demo registered users; docs/api.md
-- § Allocations).
--
-- An editor can load invented registered users onto a project's units
-- (POST /projects/:id/allocations/demo) to show the Registered users table and
-- its map, and remove them again (DELETE …/allocations/demo). Every demo row
-- must be told apart from what a person entered or imported, so removing the
-- demo can never touch a real volume. The schema already groups rows by where
-- they came from (allocation_source, 038: deleting a source deletes its
-- allocations, and their holders with them), so a demo load is one source of a
-- new kind, `demo`: its rows are exactly the rows whose source_id names it.
--
-- In this file:
--  * allocation_source.kind's CHECK (038, inline, so named
--    allocation_source_kind_check) admits 'demo' beside 'warms_extract' and
--    'csv'. Expand only: every stored row passes the new check, and a backend
--    that never writes 'demo' is unaffected. 162's
--    allocation_source_warms_reference (a WARMS extract needs its reference)
--    is unchanged.
--  * Nothing else changes: no new table or column, no policy and no grant.
--    allocation_source's policies (038: viewers read, editors insert and
--    delete) and water_app's SELECT, INSERT, UPDATE, DELETE on it already
--    cover the demo source, so RLS is untouched.

ALTER TABLE allocation_source DROP CONSTRAINT allocation_source_kind_check;
ALTER TABLE allocation_source ADD CONSTRAINT allocation_source_kind_check CHECK (kind IN ('warms_extract', 'csv', 'demo'));

COMMENT ON COLUMN allocation_source.kind IS
	'warms_extract: a CMA/DWS WARMS extract; csv: the app''s template (or any table with its headers); demo: invented registered users an editor loaded to show the Allocations page (315), removed whole by DELETE /projects/:id/allocations/demo.';
