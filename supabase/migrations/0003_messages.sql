-- Persistent text chat history. Purely additive: nothing existing is touched,
-- and the realtime chat path (server.js 'chat-message') keeps working the
-- same whether or not a message ends up stored here.
--
-- Same permission model as channels: any member of a channel's server can
-- read and post. Reads go straight through RLS (SELECT only); the only way to
-- write is post_message below, which takes the author's name from their
-- account instead of trusting the caller — same RPC-only convention as
-- create_channel/delete_channel.
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  username text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists messages_channel_id_idx on public.messages (channel_id, id desc);

alter table public.messages enable row level security;

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using (exists (
    select 1 from public.channels c
    join public.room_members m on m.room_id = c.room_id
    where c.id = messages.channel_id and m.user_id = auth.uid()
  ));

-- Returns false (instead of raising) when there's nothing to store — a guest,
-- a room code that isn't a real channel, or a non-member — so the server can
-- call it for every message of a signed-in user without treating that as an error.
create or replace function public.post_message(target_channel_id text, body text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  clean text := btrim(body);
  author text;
begin
  if uid is null or clean is null or char_length(clean) not between 1 and 500 then
    return false;
  end if;

  if not exists (
    select 1 from channels c
    join room_members m on m.room_id = c.room_id
    where c.id = target_channel_id and m.user_id = uid
  ) then
    return false;
  end if;

  select coalesce(nullif(u.raw_user_meta_data->>'username', ''), split_part(u.email, '@', 1), 'Alguém')
    into author
    from auth.users u
    where u.id = uid;

  insert into messages (channel_id, user_id, username, body)
  values (target_channel_id, uid, coalesce(author, 'Alguém'), clean);
  return true;
end;
$function$;

revoke all on function public.post_message(text, text) from public;
grant execute on function public.post_message(text, text) to authenticated;
