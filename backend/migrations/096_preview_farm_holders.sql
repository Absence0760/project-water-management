-- 096_preview_farm_holders — the aggregate rule (D2, design §10.3) as a
-- farm's own farmer meets it, for "Preview as farmer" (issue #51).
--
-- app_other_farm_holders(p_project) (020) counts the other holders from the
-- *caller's* point of view: the farms not linked to them. A viewer links no
-- farm, so for the WUA previewing a farm it counted every farm, the
-- previewed one included, and the preview showed the even share on a farm
-- whose farmer is told "Not shown: with so few farms…". No leak (a viewer
-- may read every farm anyway), but the preview wasn't what the farmer sees.
--
-- app_other_farm_holders(p_project, p_node) answers:
--   - a farmer: the same as the one-argument form (their own point of view;
--     p_node is ignored, so it can't be used to probe another farm);
--   - a viewer and above: the count p_node's farmer would get, the smallest
--     over its linked farmers when it has several (the preview never shows
--     what one of them wouldn't see); for an unlinked farm, the holders of
--     every other farm (it would have a holder of its own once linked);
--   - anyone else: NULL.
-- The one-argument form stays as it was (the data-subject export and older
-- callers), so no existing definition changes.

CREATE FUNCTION app_other_farm_holders(p_project uuid, p_node uuid) RETURNS integer
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH holder AS (
			-- Each farm and its holder key (020's rule): the lowest linked user, or the farm itself.
			SELECT n.id, coalesce(
				(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
				'node:' || n.id::text
			) AS key
			FROM node n
			WHERE n.project_id = p_project AND n.kind = 'farm'
		), linked AS (
			SELECT fl.user_id FROM farm_link fl WHERE fl.project_id = p_project AND fl.node_id = p_node
		)
		SELECT CASE
			WHEN NOT app_has_role(p_project, 'farmer') THEN NULL
			WHEN NOT app_has_role(p_project, 'viewer') THEN app_other_farm_holders(p_project)
			WHEN EXISTS (SELECT 1 FROM linked) THEN (
				SELECT min((
					SELECT count(DISTINCT h.key)::integer FROM holder h
					WHERE h.id NOT IN (SELECT fl.node_id FROM farm_link fl WHERE fl.project_id = p_project AND fl.user_id = l.user_id)
				)) FROM linked l
			)
			ELSE (SELECT count(DISTINCT h.key)::integer FROM holder h WHERE h.id <> p_node)
		END
	$$;

COMMENT ON FUNCTION app_other_farm_holders(uuid, uuid) IS
	'The aggregate rule''s other-holder count (D2) as p_node''s own farmer meets it, for "Preview as farmer" (096, issue #51). A farmer gets their own count (p_node ignored); NULL for a non-member.';

-- SECURITY DEFINER: the owner and water_app only (028's rule).
REVOKE ALL ON FUNCTION app_other_farm_holders(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_other_farm_holders(uuid, uuid) TO water_app;
