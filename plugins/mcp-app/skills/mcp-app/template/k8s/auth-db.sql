-- The database of the login server (Supabase Auth). k8s/deploy.sh runs this file inside the
-- pod of the Postgres, as the superuser of that Postgres, with psql reading from standard
-- input. deploy.sh writes three lines in front of it:
--
--   \set auth_password '...'      the password of the new database user
--   \set db_name '...'            the name of the database (the name of the app, "_" for "-")
--   \set db_role '...'            the name of its user
--
-- So the password is a psql variable that comes in on standard input: it is never on a
-- command line. Safe to run again: it makes only what is missing. The one thing it sets
-- every time is the password of the user, to the one that was given.
--
-- What it makes:
--   the role (db_role)         the user of the login server. It can log in and nothing more.
--   the database (db_name)     owned by that user. Nobody else may connect to it.
--   schema auth (inside it)    where the login server keeps its tables.
--   role postgres, no login    only when there is no role of that name: the login server
--                              gives rights to a role "postgres" when it sets up its tables,
--                              and stops when there is none.
-- Nothing is made or changed in any other database.

\set ON_ERROR_STOP on

-- Stop here, before anything is made, when one of the three values was not given.
\if :{?auth_password}
\else
  do $$ begin raise exception 'auth-db.sql: the psql variable auth_password is not set'; end $$;
\endif
\if :{?db_name}
\else
  do $$ begin raise exception 'auth-db.sql: the psql variable db_name is not set'; end $$;
\endif
\if :{?db_role}
\else
  do $$ begin raise exception 'auth-db.sql: the psql variable db_role is not set'; end $$;
\endif
-- The two names are written into statements: only plain names are taken.
select :'db_name' !~ '^[a-z][a-z0-9_]{0,62}$' or :'db_role' !~ '^[a-z][a-z0-9_]{0,62}$' as bad_name \gset
\if :bad_name
  do $$ begin raise exception 'auth-db.sql: db_name and db_role must be lower-case letters, digits and _'; end $$;
\endif

-- The lines below hold the password. They must not be copied into the log of the server.
set log_statement = 'none';
set log_min_duration_statement = -1;
set log_min_error_statement = 'panic';

select length(:'auth_password') < 16 as password_too_short \gset
\if :password_too_short
  do $$ begin raise exception 'auth-db.sql: auth_password is empty or shorter than 16 characters'; end $$;
\endif

-- "create role" and "create database" have no "if not exists": the statement is written only
-- when the thing is missing, and \gexec runs what was written.
select format('create role %I login nosuperuser nocreatedb nocreaterole', :'db_role')
 where not exists (select from pg_roles where rolname = :'db_role') \gexec
alter role :"db_role" password :'auth_password';

select format('create database %I owner %I', :'db_name', :'db_role')
 where not exists (select from pg_database where datname = :'db_name') \gexec
revoke connect on database :"db_name" from public;

select 'create role postgres nologin'
 where not exists (select from pg_roles where rolname = 'postgres') \gexec

-- The rest happens inside the new database.
\connect :"db_name"
-- No "already exists, skipping" lines on a second run.
set client_min_messages = warning;
create schema if not exists auth authorization :"db_role";
alter role :"db_role" in database :"db_name" set search_path = auth;
