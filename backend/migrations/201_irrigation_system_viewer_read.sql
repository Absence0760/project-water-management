-- 201_irrigation_system_viewer_read — irrigation_system (198) is read from
-- viewer up, no longer by a farmer or an applicant.
--
-- 198 let anyone with a role on the project read every row, on the grounds
-- that a farmer's farm view names its crops' systems. It doesn't read the
-- table: the farm view and the published projections take the systems from
-- the published run's own inputs, server side, and no route a farmer or a
-- contributor can call reads irrigation_system. The rows are the project's
-- (a name an editor types, and an "Imported, NN %" row that 198 made from a
-- farm's own efficiency), so a farmer reading all of them broke the rule
-- that a farmer reads only their own farms' rows
-- (farmer-privacy.security.db.test.ts) and an applicant read a table outside
-- what they may (applicant.security.db.test.ts). Writes stay with editors.

DROP POLICY irrigation_system_select ON irrigation_system;
CREATE POLICY irrigation_system_select ON irrigation_system FOR SELECT USING (app_has_role(project_id, 'viewer'));
