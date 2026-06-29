#!/bin/bash
# TownBrief multitenancy Phase 1.5c: create a non-super runtime role.
#
# Postgres bypasses Row-Level Security entirely for SUPERUSER roles
# (even FORCE doesn't apply). The bootstrap user that POSTGRES_USER
# creates is a superuser; that role is fine for ops + migrations, but
# the Ghost runtime MUST connect as a non-super role for the Phase 2c
# RLS policies to actually filter.
#
# This script runs only on FRESH Postgres init (data dir is empty).
# For an existing volume, run the SQL in this file manually once.

set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${GHOST_APP_USER:?GHOST_APP_USER must be set in compose env}"
: "${GHOST_APP_PASSWORD:?GHOST_APP_PASSWORD must be set in compose env}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<-EOSQL
    -- Idempotent role create: DO block + pg_roles lookup.
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${GHOST_APP_USER}') THEN
            CREATE ROLE ${GHOST_APP_USER}
                LOGIN PASSWORD '${GHOST_APP_PASSWORD}'
                NOSUPERUSER
                NOBYPASSRLS
                NOCREATEROLE
                NOREPLICATION;
        END IF;
    END
    \$\$;

    -- ghost_app needs to own the schema so it can CREATE/ALTER tables
    -- during knex-migrator init. FORCE RLS still applies to owners
    -- (verified Phase 2c).
    ALTER SCHEMA public OWNER TO ${GHOST_APP_USER};
    GRANT ALL PRIVILEGES ON DATABASE "${POSTGRES_DB}" TO ${GHOST_APP_USER};
    GRANT ALL PRIVILEGES ON SCHEMA public TO ${GHOST_APP_USER};

    -- Objects created by the bootstrap superuser before this script ran
    -- (there shouldn't be any on fresh init, but defensive) get
    -- reassigned to ghost_app.
    DO \$\$
    DECLARE r record;
    BEGIN
        FOR r IN
            SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        LOOP
            EXECUTE format('ALTER TABLE %I.%I OWNER TO ${GHOST_APP_USER}', 'public', r.tablename);
        END LOOP;
    END
    \$\$;

    -- Default privileges so future objects created by other roles
    -- still let ghost_app read/write (relevant if migrations ever run
    -- as a different role).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON TABLES TO ${GHOST_APP_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON SEQUENCES TO ${GHOST_APP_USER};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO ${GHOST_APP_USER};
EOSQL

echo "TownBrief: created ${GHOST_APP_USER} non-super role and granted schema ownership"
