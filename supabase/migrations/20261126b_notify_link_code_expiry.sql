-- LINEをつなぐコードは30分で切れる／間違いが5回続いたら1時間止める
alter table public.notify_recipients add column if not exists link_code_at timestamptz;

create table if not exists public.line_link_attempts (
  line_user_id text primary key,
  fails int not null default 0,
  first_at timestamptz not null default now()
);
alter table public.line_link_attempts enable row level security;

create or replace function public.my_notify()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.notify_recipients; v_code text;
begin
  if not public.is_team() then raise exception 'NOT_ALLOWED'; end if;
  insert into public.notify_recipients(user_id) values (auth.uid()) on conflict do nothing;
  select * into r from public.notify_recipients where user_id = auth.uid();
  if r.line_user_id is null and (r.link_code is null or r.link_code_at is null or r.link_code_at < now() - interval '30 minutes') then
    loop
      v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
      begin
        update public.notify_recipients set link_code = v_code, link_code_at = now() where user_id = auth.uid() returning * into r;
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

create or replace function public.link_line(p_line_user text, p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare a public.line_link_attempts; v_user uuid;
begin
  select * into a from public.line_link_attempts where line_user_id = p_line_user;
  if found and a.first_at < now() - interval '1 hour' then
    delete from public.line_link_attempts where line_user_id = p_line_user; a := null;
  end if;
  if a.fails >= 5 then return 'LOCKED'; end if;
  update public.notify_recipients
     set line_user_id = p_line_user, link_code = null, link_code_at = null, line_on = true, updated_at = now()
   where link_code = p_code and line_user_id is null and link_code_at > now() - interval '30 minutes'
   returning user_id into v_user;
  if v_user is null then
    insert into public.line_link_attempts(line_user_id, fails) values (p_line_user, 1)
      on conflict (line_user_id) do update set fails = public.line_link_attempts.fails + 1;
    return 'NOT_FOUND';
  end if;
  delete from public.line_link_attempts where line_user_id = p_line_user;
  return 'OK';
end $$;
revoke all on function public.link_line(text, text) from public, anon, authenticated;
grant execute on function public.link_line(text, text) to service_role;
