-- 039_api_keys — per-project API keys and the ingest endpoint (roadmap
-- WP-2.9; docs/data-model.md § API keys, docs/security.md § API keys,
-- docs/api.md § Ingest).
--
-- A logger gateway or a script pushes daily readings without a user session.
-- An owner makes a key for one project; the key can merge days into that
-- project's series (optionally only some of them) and nothing else.
--
-- * The key is `wm_<prefix>_<secret>`: `prefix` is the first 8 characters of
--   the key's id (shown in lists, and how a request finds its row), `secret`
--   is 32 random bytes as base64url (43 characters). `key_hash` holds only
--   the SHA-256 of the whole key. With 256 bits of entropy a slow hash adds
--   nothing (the reasoning of 004_email.sql's tokens). The raw key is shown
--   once, in the 201 that creates it.
-- * A request is authenticated in the backend (ingest/auth.ts): the prefix
--   finds the row through app_api_key_lookup (SECURITY DEFINER: there is no
--   user yet), and the hash is compared in constant time. Then the request's
--   transaction sets app.current_api_key_id (withApiKey in db/tx.ts) and no
--   user id, and RLS does the rest:
--     app_api_key_project(scope)  the key's project while the key exists, isn't
--                                 revoked or expired, and has the scope; NULL
--                                 otherwise. Re-checked on every call, so a
--                                 revocation applies to the next statement.
--     app_api_key_allows(kind, name)  the key's allowed_series admits the series.
--   New permissive policies let a key SELECT, INSERT and UPDATE time_series
--   of its project (and allowed series), and INSERT audit_event rows naming
--   itself. Every other table's policies call app_has_role, which is false
--   without a user: a key sees nothing else.
-- * api_key_throttle: a token bucket per key (60 a minute), the
--   login_throttle pattern: SECURITY DEFINER access only, a deny-all policy.
--
-- Rows are never deleted by the app (they go with their project): a revoked
-- key stays as the record of who made and withdrew it, and audit events name
-- it (audit_event.actor_api_key_id, reserved by 030_history.sql).

CREATE TABLE api_key (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The owner's name for it ("Weir logger gateway").
	name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
	-- The first 8 characters of the id: part of the key, and shown in lists.
	prefix         text GENERATED ALWAYS AS (left(id::text, 8)) STORED UNIQUE,
	-- SHA-256 of the whole key. Never the key itself.
	key_hash       bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
	scopes         text[] NOT NULL DEFAULT '{series:write}'
		CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['series:write']),
	-- NULL: any series of the project. Else [{ kind, name }, …] (1–50): only those.
	allowed_series jsonb CHECK (
		allowed_series IS NULL
		OR (jsonb_typeof(allowed_series) = 'array' AND jsonb_array_length(allowed_series) BETWEEN 1 AND 50)
	),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT now(),
	-- Bumped by app_api_key_take at most once a minute.
	last_used_at   timestamptz,
	-- NULL: until revoked.
	expires_at     timestamptz,
	revoked_at     timestamptz,
	revoked_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	CHECK (expires_at IS NULL OR (expires_at > created_at AND expires_at <= created_at + interval '3650 days')),
	-- Whoever revoked it may since have been deleted (SET NULL), never the reverse.
	CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);
COMMENT ON TABLE api_key IS
	'Per-project API keys for the ingest endpoint (039, WP-2.9). Owner only; a key request reads its row only through app_api_key_lookup. Key stored as SHA-256.';

-- The owner's list (newest first); also covers the project_id foreign key.
CREATE INDEX api_key_project_idx ON api_key (project_id, created_at DESC);
CREATE INDEX api_key_created_by_idx ON api_key (created_by);
CREATE INDEX api_key_revoked_by_idx ON api_key (revoked_by);

-- A key is made by the signed-in owner, now; the rest is the caller's.
CREATE FUNCTION api_key_issue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		NEW.created_by := app_current_user_id();
		NEW.created_at := now();
		NEW.revoked_at := NULL;
		NEW.revoked_by := NULL;
		NEW.last_used_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER api_key_issue BEFORE INSERT ON api_key
	FOR EACH ROW EXECUTE FUNCTION api_key_issue();

-- Owners only, for every operation water_app has. No DELETE (see above).
ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_key_select ON api_key FOR SELECT USING (app_has_role(project_id, 'owner'));
CREATE POLICY api_key_insert ON api_key FOR INSERT
	WITH CHECK (app_has_role(project_id, 'owner') AND created_by = app_current_user_id());
CREATE POLICY api_key_update ON api_key FOR UPDATE
	USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));

GRANT SELECT, INSERT ON api_key TO water_app;
GRANT UPDATE (revoked_at, revoked_by) ON api_key TO water_app;

-- The change history's reserved column gets its foreign key (030_history.sql).
ALTER TABLE audit_event
	ADD CONSTRAINT audit_event_actor_api_key_fkey FOREIGN KEY (actor_api_key_id) REFERENCES api_key(id) ON DELETE SET NULL;
CREATE INDEX audit_event_actor_api_key_idx ON audit_event (actor_api_key_id);

-- ---------------------------------------------------------------------------
-- The per-key rate limit
-- ---------------------------------------------------------------------------
CREATE TABLE api_key_throttle (
	key_id      uuid PRIMARY KEY REFERENCES api_key(id) ON DELETE CASCADE,
	tokens      double precision NOT NULL CHECK (tokens >= 0),
	refilled_at timestamptz NOT NULL
);
ALTER TABLE api_key_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_key_throttle_none ON api_key_throttle USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_throttle TO water_app;

-- ---------------------------------------------------------------------------
-- Key context
-- ---------------------------------------------------------------------------

-- The transaction's API key (app.current_api_key_id, set by withApiKey); NULL
-- in a user's transaction.
CREATE FUNCTION app_current_api_key_id() RETURNS uuid
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	BEGIN
		RETURN nullif(current_setting('app.current_api_key_id', true), '')::uuid;
	END
	$$;

-- The key's project, while it is live and holds p_scope (NULL: any scope).
-- Never in a transaction that also has a user: the two contexts don't mix.
CREATE FUNCTION app_api_key_project(p_scope text) RETURNS uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_key uuid := app_current_api_key_id();
	BEGIN
		IF v_key IS NULL OR app_current_user_id() IS NOT NULL THEN
			RETURN NULL;
		END IF;
		RETURN (
			SELECT project_id FROM api_key
			WHERE id = v_key AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
			  AND (p_scope IS NULL OR p_scope = ANY (scopes))
		);
	END
	$$;

-- Whether the key may write the series (kind, name): its allowed_series is
-- NULL (any) or lists it. False without a key.
CREATE FUNCTION app_api_key_allows(p_kind text, p_name text) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_key uuid := app_current_api_key_id();
	BEGIN
		IF v_key IS NULL THEN
			RETURN false;
		END IF;
		RETURN coalesce((
			SELECT allowed_series IS NULL OR allowed_series @> jsonb_build_array(jsonb_build_object('kind', p_kind, 'name', p_name))
			FROM api_key WHERE id = v_key
		), false);
	END
	$$;

-- The actor label an audit event records for the key: 'API key “<name>”'.
CREATE FUNCTION app_api_key_label() RETURNS text
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (SELECT left('API key “' || name || '”', 200) FROM api_key WHERE id = app_current_api_key_id());
	END
	$$;

-- ---------------------------------------------------------------------------
-- Authentication (no user yet, so SECURITY DEFINER)
-- ---------------------------------------------------------------------------

-- The key with this prefix, live or not, with its hash for the backend's
-- constant-time comparison (ingest/auth.ts), and its project's name (for
-- GET /ingest/v1/whoami: a key can't read project). The backend never puts
-- the hash in a response.
CREATE FUNCTION app_api_key_lookup(p_prefix text)
	RETURNS TABLE (id uuid, project_id uuid, project_name text, key_hash bytea, name text, scopes text[], allowed_series jsonb, live boolean)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT k.id, k.project_id, p.name::text, k.key_hash, k.name, k.scopes, k.allowed_series,
			k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
		FROM api_key k JOIN project p ON p.id = k.project_id
		WHERE k.prefix = p_prefix
	$$;

-- Take one request from the key's bucket: p_capacity tokens, refilled at
-- p_per_minute. Returns 0 to go ahead (and records the use, at most once a
-- minute), or the seconds until a token is back. The row lock counts
-- concurrent requests one by one. A dead key answers -1 and takes nothing.
CREATE FUNCTION app_api_key_take(p_key uuid, p_capacity integer, p_per_minute integer) RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_tokens double precision;
		v_at timestamptz;
		v_now timestamptz;
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM api_key WHERE id = p_key AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
		) THEN
			RETURN -1;
		END IF;
		INSERT INTO api_key_throttle (key_id, tokens, refilled_at) VALUES (p_key, p_capacity, clock_timestamp())
			ON CONFLICT (key_id) DO NOTHING;
		SELECT tokens, refilled_at INTO v_tokens, v_at FROM api_key_throttle WHERE key_id = p_key FOR UPDATE;
		-- After the lock: a request that waited refills from when it got it.
		v_now := clock_timestamp();
		v_tokens := least(p_capacity, v_tokens + greatest(0, extract(epoch FROM v_now - v_at)) * p_per_minute / 60.0);
		IF v_tokens < 1 THEN
			UPDATE api_key_throttle SET tokens = v_tokens, refilled_at = v_now WHERE key_id = p_key;
			RETURN greatest(1, ceil((1 - v_tokens) * 60.0 / p_per_minute))::integer;
		END IF;
		UPDATE api_key_throttle SET tokens = v_tokens - 1, refilled_at = v_now WHERE key_id = p_key;
		UPDATE api_key SET last_used_at = now()
			WHERE id = p_key AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 minute');
		RETURN 0;
	END
	$$;

-- ---------------------------------------------------------------------------
-- What a key may do: write its project's (allowed) series, and log it
-- ---------------------------------------------------------------------------
CREATE POLICY time_series_api_key_select ON time_series FOR SELECT
	USING (project_id = app_api_key_project('series:write') AND app_api_key_allows(kind, name));
CREATE POLICY time_series_api_key_insert ON time_series FOR INSERT
	WITH CHECK (project_id = app_api_key_project('series:write') AND app_api_key_allows(kind, name));
CREATE POLICY time_series_api_key_update ON time_series FOR UPDATE
	USING (project_id = app_api_key_project('series:write') AND app_api_key_allows(kind, name))
	WITH CHECK (project_id = app_api_key_project('series:write') AND app_api_key_allows(kind, name));

CREATE POLICY audit_event_api_key_insert ON audit_event FOR INSERT
	WITH CHECK (
		actor_user_id IS NULL
		AND actor_api_key_id = app_current_api_key_id()
		AND project_id = app_api_key_project(NULL)
	);
