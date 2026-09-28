-- 095_wua_name — the name of the WUA that publishes the catchment's figures
-- (issue #74; docs/data-model.md § Projects, docs/api.md § Projects and § Farm).
--
-- Expand-only:
--
--   project.wua_name text, NULL by default: the Water User Association (or
--   irrigation board) a farmer contacts about their farm, as the farm pages'
--   "Questions? Contact Vaalbank WUA." lines name it. NULL keeps the pages'
--   "your WUA". Not the project's team: a team may be the consultancy that
--   runs the model rather than the WUA its farmers know.
--
--   The API trims the name and stores an empty one as NULL; the CHECK bounds
--   the text for any other writer.
--
-- Access is unchanged: project_select (001) and project_select_farmer (020)
-- let every member read the row, farmers included, project_update (002) lets
-- an editor change it, and water_app's table-level grant on project (001)
-- covers the new column.

ALTER TABLE project
	ADD COLUMN wua_name text CHECK (wua_name IS NULL OR char_length(wua_name) BETWEEN 1 AND 200);
