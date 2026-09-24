create table if not exists public.tactic_shares (
  id uuid primary key default gen_random_uuid(),
  share_token text not null unique check (share_token ~ '^[a-f0-9]{64}$'),
  owner_token_hash text not null,
  visibility text not null default 'unlisted' check (visibility = 'unlisted'),
  object_path text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.tactic_shares enable row level security;
revoke all on public.tactic_shares from anon, authenticated;

create table if not exists public.tactic_share_rate_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null,
  uploads integer not null default 0
);
alter table public.tactic_share_rate_limits enable row level security;
revoke all on public.tactic_share_rate_limits from anon, authenticated;

create or replace function public.consume_tactic_share_quota(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare current_count integer;
begin
  insert into public.tactic_share_rate_limits(ip_hash, window_started_at, uploads)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update set
    uploads = case when tactic_share_rate_limits.window_started_at < now() - interval '1 hour' then 1 else tactic_share_rate_limits.uploads + 1 end,
    window_started_at = case when tactic_share_rate_limits.window_started_at < now() - interval '1 hour' then now() else tactic_share_rate_limits.window_started_at end
  returning uploads into current_count;
  return current_count <= 3;
end;
$$;
revoke all on function public.consume_tactic_share_quota(text) from public, anon, authenticated;
grant execute on function public.consume_tactic_share_quota(text) to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('tactic-shares', 'tactic-shares', false, 134217728, array['application/vnd.tacticlab.cstactic'])
on conflict (id) do update set public = false, file_size_limit = 134217728,
  allowed_mime_types = array['application/vnd.tacticlab.cstactic'];
