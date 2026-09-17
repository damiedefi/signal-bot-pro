-- Additive v6 schema. Does not overwrite or reinterpret the old signals table.
begin;
create table if not exists public.bot_v6_records (
  id text primary key,
  kind text not null check (kind in ('candle','signal','snapshot','meta','notification')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  updated_at bigint not null
);
create index if not exists bot_v6_kind_id on public.bot_v6_records(kind,id);
create index if not exists bot_v6_candle_lookup on public.bot_v6_records
  ((payload->>'source'),(payload->>'sym'),((payload->>'time')::bigint)) where kind='candle';
alter table public.bot_v6_records enable row level security;
revoke all on public.bot_v6_records from anon, authenticated, service_role;
grant select on public.bot_v6_records to service_role;

create table if not exists public.bot_v6_lease (
  id integer primary key check (id=1),
  holder text not null,
  expires_at timestamptz not null
);
alter table public.bot_v6_lease enable row level security;
revoke all on public.bot_v6_lease from anon, authenticated, service_role;
grant select on public.bot_v6_lease to service_role;

create or replace function public.bot_v6_acquire_lease(p_holder text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare won boolean;
begin
  if p_holder is null or length(p_holder)>128 or p_ttl_seconds<10 or p_ttl_seconds>300 then
    raise exception 'Invalid lease arguments';
  end if;
  insert into public.bot_v6_lease(id,holder,expires_at)
  values (1,p_holder,clock_timestamp()+make_interval(secs=>p_ttl_seconds))
  on conflict (id) do update set holder=excluded.holder,expires_at=excluded.expires_at
  where public.bot_v6_lease.expires_at<clock_timestamp() or public.bot_v6_lease.holder=p_holder
  returning true into won;
  return coalesce(won,false);
end;
$$;
revoke all on function public.bot_v6_acquire_lease(text,integer) from public,anon,authenticated;
grant execute on function public.bot_v6_acquire_lease(text,integer) to service_role;

-- Fencing: a process whose lease expires cannot overwrite a newer recorder.
create or replace function public.bot_v6_write_records(p_holder text, p_rows jsonb)
returns setof public.bot_v6_records language plpgsql security definer set search_path = '' as $$
declare item jsonb; saved public.bot_v6_records;
begin
  perform 1 from public.bot_v6_lease
    where id=1 and holder=p_holder and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Recorder lease unavailable'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>200 then
    raise exception 'Invalid record batch';
  end if;
  for item in select value from jsonb_array_elements(p_rows) loop
    insert into public.bot_v6_records(id,kind,payload,updated_at)
      values(item->>'id',item->>'kind',item->'payload',(item->>'updated_at')::bigint)
      on conflict(id) do update set payload=excluded.payload,updated_at=excluded.updated_at
      where public.bot_v6_records.updated_at<=excluded.updated_at
      and not (public.bot_v6_records.kind='signal'
        and public.bot_v6_records.payload->>'finalResult'<>'pending'
        and excluded.payload->>'finalResult'='pending')
      returning * into saved;
    if not found then raise exception 'Stale record revision; recover before retrying'; end if;
    return next saved;
  end loop;
end;
$$;
revoke all on function public.bot_v6_write_records(text,jsonb) from public,anon,authenticated;
grant execute on function public.bot_v6_write_records(text,jsonb) to service_role;
commit;
