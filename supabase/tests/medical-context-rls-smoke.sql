\set ON_ERROR_STOP on
-- Disposable PostgreSQL smoke environment with synthetic rows only.
-- Roles are cluster-wide; this script may run after the Health Connect smoke in another database.
do $roles$
begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $roles$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$fn$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
insert into auth.users values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

\ir ../migrations/20261011115000_health_connect_records.sql
\ir ../migrations/20261011120000_medical_context_entries.sql

do $test$
begin
  if has_table_privilege('anon','public.medical_context_entries','SELECT') then
    raise exception 'anon unexpectedly has SELECT';
  end if;
  if has_table_privilege('authenticated','public.medical_context_entries','INSERT') or
     has_table_privilege('authenticated','public.medical_context_entries','UPDATE') or
     has_table_privilege('authenticated','public.medical_context_entries','DELETE') then
    raise exception 'authenticated client has direct writes';
  end if;
  if (select not relrowsecurity from pg_class where oid='public.medical_context_entries'::regclass) then
    raise exception 'RLS disabled';
  end if;
end $test$;

set role service_role;
insert into public.medical_context_entries (user_id,category,detail_json,source_type,source_label,reviewed_at) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','note','{"title":"synthetic A"}','self_reported','Personal notes',now()),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','allergy','{"title":"synthetic B"}','provider_document','Synthetic clinic',now());
reset role;

-- Invalid category and non-object detail are rejected.
do $test$
begin
  begin
    insert into public.medical_context_entries (user_id,category,detail_json,source_type,reviewed_at)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','diagnosis','{}','self_reported',now());
    raise exception 'invalid category accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.medical_context_entries (user_id,category,detail_json,source_type,reviewed_at)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','note','[1]','self_reported',now());
    raise exception 'non-object detail accepted';
  exception when check_violation then null;
  end;
end $test$;

set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
do $test$
begin
  if (select count(*) from public.medical_context_entries) <> 1 or
     (select detail_json->>'title' from public.medical_context_entries) <> 'synthetic A' then
    raise exception 'user A sees another user or cannot read own row';
  end if;
  begin
    insert into public.medical_context_entries (user_id,category,detail_json,source_type,reviewed_at)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','note','{}','self_reported',now());
    raise exception 'direct client insert succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.medical_context_entries;
    raise exception 'direct client delete succeeded';
  exception when insufficient_privilege then null;
  end;
end $test$;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
do $test$
begin
  if (select count(*) from public.medical_context_entries) <> 1 or
     (select detail_json->>'title' from public.medical_context_entries) <> 'synthetic B' then
    raise exception 'user B isolation failed';
  end if;
end $test$;
select set_config('request.jwt.claim.sub','',false);
do $test$
begin
  if (select count(*) from public.medical_context_entries) <> 0 then
    raise exception 'no-identity caller sees rows';
  end if;
end $test$;
reset role;

-- Account deletion cascades.
delete from auth.users where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
do $test$
begin
  if (select count(*) from public.medical_context_entries) <> 1 then
    raise exception 'account deletion did not cascade';
  end if;
end $test$;

-- Rollback note is executable on the disposable database.
drop policy if exists medical_context_owner_select on public.medical_context_entries;
drop table if exists public.medical_context_entries;
select 'Medical context RLS isolation, grants, checks, cascade and rollback verified' as smoke_result;
