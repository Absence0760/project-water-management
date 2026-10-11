-- 217_project_time_zone_for_render — the zone a server-rendered report prints in (issue #521).
--
-- The headless renderer printed every report, evidence pack and applicant's
-- copy in a UTC browser, so every date and time the page formats in the
-- browser's own zone (a run made, a sign-off, a registration check, a pack
-- issued, "prepared") came out a day early for a stamp between midnight and
-- 02:00 in South Africa, while the same page printed from a browser there
-- showed the right day. The renderer now prints in the project's zone
-- (project.time_zone, 058), which POST /auth/render-session hands it
-- (reports/routes.ts, reports/render.ts).
--
-- The exchange reads the zone as the token's requester, under RLS. A viewer
-- reads the project row, but an applicant's copy is requested by a party of
-- the application (a contributor), whom project_select doesn't show the row.
-- So this reads the one column for any member of the project, whatever their
-- role, and NULL for anyone else (the exchange then prints in the default
-- zone). The zone is no secret: it only says where the catchment is.
-- Returned as stored; the renderer checks it is a zone its Intl knows.

CREATE FUNCTION app_project_time_zone(p_project uuid) RETURNS text
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL OR app_project_role(p_project) IS NULL THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT time_zone FROM project WHERE id = p_project);
	END
	$$;

REVOKE ALL ON FUNCTION app_project_time_zone(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_time_zone(uuid) TO water_app;
