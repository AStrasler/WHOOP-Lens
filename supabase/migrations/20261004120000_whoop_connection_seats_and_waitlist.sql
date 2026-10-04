-- Apply this before deploying whoop-mcp from this repo. It does not store tokens.
-- Public seats: 9 connections with seat_role public.
-- Developer seat: 1 connection with seat_role developer.
-- The edge function sets developer only when WHOOP_LENS_DEVELOPER_USER_ID matches.
-- Existing rows default to public until that user reconnects.

alter table public.whoop_connections
  add column seat_role text not null default 'public';

alter table public.whoop_connections
  add constraint whoop_connections_seat_role_check
  check (seat_role in ('public', 'developer'));

comment on column public.whoop_connections.seat_role is
  'public (max 9) or developer (max 1). Not a credential.';

create or replace function public.enforce_whoop_connection_seats()
returns trigger
language plpgsql
set search_path to public
as $$
declare
  public_seats integer;
  developer_seats integer;
begin
  if tg_op = 'UPDATE'
     and old.user_id is not distinct from new.user_id
     and old.seat_role is not distinct from new.seat_role then
    return new;
  end if;

  perform pg_advisory_xact_lock(814201);

  select count(*) into public_seats
  from public.whoop_connections
  where seat_role is distinct from 'developer'
    and user_id is distinct from new.user_id;

  select count(*) into developer_seats
  from public.whoop_connections
  where seat_role = 'developer'
    and user_id is distinct from new.user_id;

  if new.seat_role = 'developer' and developer_seats >= 1 then
    raise exception 'WHOOP developer seat is already taken';
  end if;
  if new.seat_role is distinct from 'developer' and public_seats >= 9 then
    raise exception 'WHOOP integration is limited to 9 public seats';
  end if;
  return new;
end;
$$;

drop trigger if exists whoop_connection_seats on public.whoop_connections;
create trigger whoop_connection_seats
  before insert or update on public.whoop_connections
  for each row execute function public.enforce_whoop_connection_seats();

revoke all on function public.enforce_whoop_connection_seats() from public, anon, authenticated;
grant execute on function public.enforce_whoop_connection_seats() to service_role;

create table public.whoop_waitlist (
  user_id uuid primary key references auth.users (id) on delete cascade,
  contact_email text,
  destination text not null default 'whoop-lens@outlook.com',
  created_at timestamptz not null default now(),
  constraint whoop_waitlist_destination_check check (destination = 'whoop-lens@outlook.com'),
  constraint whoop_waitlist_contact_email_check check (
    contact_email is null
    or (
      char_length(contact_email) <= 254
      and contact_email ~ '^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$'
    )
  )
);

comment on table public.whoop_waitlist is
  'Seat intake only. destination is whoop-lens@outlook.com. Columns are user_id, contact_email, destination, and created_at. Do not store WHOOP tokens, refresh tokens, client secrets, authorization codes, or health data. This table does not send mail.';

alter table public.whoop_waitlist enable row level security;

create policy "no direct waitlist access"
  on public.whoop_waitlist
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.whoop_waitlist from public, anon, authenticated;
grant select, insert, update, delete on table public.whoop_waitlist to service_role;
