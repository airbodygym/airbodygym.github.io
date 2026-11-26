-- 通知の鍵（LINE・Gmail）を管理画面のオーナーが入れられるようにする。
-- 入れた値は画面にもAPIにも二度と出さない（Edge Function だけが読む）。
create table if not exists public.notify_secrets (
  key text primary key check (key in ('LINE_CHANNEL_ACCESS_TOKEN','LINE_CHANNEL_SECRET','GMAIL_USER','GMAIL_APP_PASSWORD')),
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.notify_secrets enable row level security;
revoke all on public.notify_secrets from anon, authenticated;

create or replace function public.set_notify_secret(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'NOT_ALLOWED'; end if;
  if p_key not in ('LINE_CHANNEL_ACCESS_TOKEN','LINE_CHANNEL_SECRET','GMAIL_USER','GMAIL_APP_PASSWORD') then raise exception 'BAD_KEY'; end if;
  if coalesce(trim(p_value), '') = '' then
    delete from public.notify_secrets where key = p_key;
  else
    insert into public.notify_secrets(key, value) values (p_key, left(trim(p_value), 1000))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end $$;

create or replace function public.notify_secret_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_admin() then
    (select coalesce(jsonb_object_agg(key, true), '{}'::jsonb) from public.notify_secrets) end;
$$;

revoke all on function public.set_notify_secret(text, text), public.notify_secret_status() from public, anon;
grant execute on function public.set_notify_secret(text, text), public.notify_secret_status() to authenticated;
