-- 予約が入ったら LINE とメールで知らせる
-- オーナー：すべての予約・キャンセル・チケットの申し込み
-- トレーナー：自分が担当の予約・キャンセル

create extension if not exists pg_net with schema extensions;

alter table public.settings add column if not exists notify_line_url text;

-- 通知を受け取る人（管理画面にログインする人ごと）
create table if not exists public.notify_recipients (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  email_on boolean not null default true,
  line_user_id text,
  line_on boolean not null default true,
  link_code text unique,
  updated_at timestamptz not null default now()
);
alter table public.notify_recipients enable row level security;

-- 送る通知の控え（同じ通知を2回送らないため）
create table if not exists public.notify_queue (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  result jsonb
);
alter table public.notify_queue enable row level security;

-- 宛先：オーナー全員 ＋（担当トレーナーのアカウント）
create or replace function public.notify_targets(p_trainer uuid, p_owner_only boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'email', case when coalesce(r.email_on, true) then coalesce(nullif(trim(r.email), ''), u.email) end,
      'line',  case when coalesce(r.line_on, true) then r.line_user_id end)), '[]'::jsonb)
  from auth.users u
  left join public.notify_recipients r on r.user_id = u.id
  where u.email_confirmed_at is not null
    and (exists (select 1 from public.admins a where a.user_id = u.id)
         or (not p_owner_only and p_trainer is not null and exists (
               select 1 from public.staff s where s.email = lower(u.email) and s.trainer_id = p_trainer)));
$$;

create or replace function public.notify_enqueue(p_kind text, p_payload jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.notify_queue(kind, payload) values (p_kind, p_payload) returning id into v_id;
  perform net.http_post(
    url := 'https://xqxcsmwtwhcwzabjlzzo.supabase.co/functions/v1/notify',
    body := jsonb_build_object('id', v_id),
    headers := '{"Content-Type":"application/json"}'::jsonb);
  return v_id;
end $$;

create or replace function public.booking_payload(b public.bookings)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'on_date', b.on_date, 'start_time', to_char(b.start_time, 'HH24:MI'),
    'end_time', to_char(b.start_time + make_interval(mins => s.slot_minutes), 'HH24:MI'),
    'trainer', t.name, 'nominated', b.nominated,
    'customer', c.name, 'contact', c.contact,
    'pay_type', b.pay_type, 'pass_label', p.label, 'price', b.price + coalesce(b.fee, 0),
    'note', b.note)
  from public.settings s
  left join public.trainers t on t.id = b.trainer_id
  left join public.customers c on c.id = b.customer_id
  left join public.passes p on p.id = b.pass_id
  where s.id = 1;
$$;

-- お客さんの予約（管理画面から入れた予約は通知しない）
create or replace function public.trg_notify_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then return null; end if;
  if tg_op = 'INSERT' then
    perform public.notify_enqueue('booking',
      public.booking_payload(new) || jsonb_build_object('targets', public.notify_targets(new.trainer_id, false)));
  elsif tg_op = 'DELETE' and old.status is null then
    perform public.notify_enqueue('cancel',
      public.booking_payload(old) || jsonb_build_object('targets', public.notify_targets(old.trainer_id, false)));
  end if;
  return null;
end $$;

drop trigger if exists notify_booking on public.bookings;
create trigger notify_booking after insert or delete on public.bookings
  for each row execute function public.trg_notify_booking();

create or replace function public.trg_notify_application()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then return null; end if;
  perform public.notify_enqueue('apply', (
    select jsonb_build_object('customer', c.name, 'contact', c.contact, 'plan', p.label, 'price', p.price,
                              'targets', public.notify_targets(null, true))
    from public.customers c, public.plans p where c.id = new.customer_id and p.id = new.plan_id));
  return null;
end $$;

drop trigger if exists notify_application on public.applications;
create trigger notify_application after insert on public.applications
  for each row execute function public.trg_notify_application();

-- 管理画面：自分の通知の設定
create or replace function public.my_notify()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.notify_recipients; v_code text;
begin
  if not public.is_team() then raise exception 'NOT_ALLOWED'; end if;
  insert into public.notify_recipients(user_id) values (auth.uid()) on conflict do nothing;
  select * into r from public.notify_recipients where user_id = auth.uid();
  if r.line_user_id is null and r.link_code is null then
    loop
      v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
      begin
        update public.notify_recipients set link_code = v_code where user_id = auth.uid() returning * into r;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
  end if;
  return jsonb_build_object(
    'email', coalesce(nullif(trim(r.email), ''), (select email from auth.users where id = auth.uid())),
    'email_on', r.email_on, 'line_on', r.line_on,
    'linked', r.line_user_id is not null, 'code', case when r.line_user_id is null then r.link_code end);
end $$;

create or replace function public.set_my_notify(p_email text, p_email_on boolean, p_line_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team() then raise exception 'NOT_ALLOWED'; end if;
  if coalesce(trim(p_email), '') <> '' and trim(p_email) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_EMAIL'; end if;
  insert into public.notify_recipients(user_id) values (auth.uid()) on conflict do nothing;
  update public.notify_recipients
     set email = nullif(left(trim(coalesce(p_email, '')), 200), ''), email_on = coalesce(p_email_on, true),
         line_on = coalesce(p_line_on, true), updated_at = now()
   where user_id = auth.uid();
end $$;

create or replace function public.unlink_my_line()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team() then raise exception 'NOT_ALLOWED'; end if;
  update public.notify_recipients set line_user_id = null, link_code = null, updated_at = now() where user_id = auth.uid();
end $$;

-- 自分あてにテストの通知を送る
create or replace function public.notify_test()
returns bigint language plpgsql security definer set search_path = '' as $$
declare r public.notify_recipients; v_email text;
begin
  if not public.is_team() then raise exception 'NOT_ALLOWED'; end if;
  if (select count(*) from public.notify_queue where kind = 'test' and created_at > now() - interval '1 minute') >= 3 then
    raise exception 'TOO_MANY';
  end if;
  select * into r from public.notify_recipients where user_id = auth.uid();
  select email into v_email from auth.users where id = auth.uid();
  return public.notify_enqueue('test', jsonb_build_object('targets', jsonb_build_array(jsonb_build_object(
    'email', case when coalesce(r.email_on, true) then coalesce(nullif(trim(r.email), ''), v_email) end,
    'line',  case when coalesce(r.line_on, true) then r.line_user_id end))));
end $$;

-- 最後に送った結果（管理画面に表示）
create or replace function public.my_last_test()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.is_team() then
    (select jsonb_build_object('sent_at', sent_at, 'result', result) from public.notify_queue
      where kind = 'test' order by id desc limit 1) end;
$$;

revoke all on function public.notify_targets(uuid, boolean), public.notify_enqueue(text, jsonb),
  public.booking_payload(public.bookings), public.trg_notify_booking(), public.trg_notify_application()
  from public, anon, authenticated;
revoke all on function public.my_notify(), public.set_my_notify(text, boolean, boolean), public.unlink_my_line(),
  public.notify_test(), public.my_last_test() from public, anon;
grant execute on function public.my_notify(), public.set_my_notify(text, boolean, boolean), public.unlink_my_line(),
  public.notify_test(), public.my_last_test() to authenticated;
