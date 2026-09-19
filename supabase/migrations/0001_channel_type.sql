-- Adds a text/voice distinction to channels (Discord-style Voice Channels
-- section in the sidebar). Purely additive: existing rows default to
-- 'text' (today's only behavior), and none of the existing RPCs
-- (create_room, join_room_by_invite, leave_room, create_channel) are
-- touched.
alter table channels
  add column if not exists type text not null default 'text';

alter table channels
  drop constraint if exists channels_type_check;
alter table channels
  add constraint channels_type_check check (type in ('text', 'voice'));

-- Lets a member flip a channel they just created to 'voice' (create_channel
-- itself is left alone — this is called as a second step from the client,
-- see rooms.js's createChannel). Same membership-check + SECURITY DEFINER
-- pattern as the other RPCs in this file's neighborhood.
create or replace function public.set_channel_type(target_channel_id text, new_type text)
returns channels
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  updated_channel channels;
  is_member boolean;
begin
  if new_type not in ('text', 'voice') then
    raise exception 'invalid channel type';
  end if;

  select exists (select 1 from channels join room_members on room_members.room_id = channels.room_id where channels.id = target_channel_id and room_members.user_id = auth.uid()) into is_member;

  if not is_member then
    raise exception 'not a member of this server';
  end if;

  update channels set type = new_type where id = target_channel_id returning * into updated_channel;
  return updated_channel;
end;
$function$;

grant execute on function public.set_channel_type(text, text) to authenticated;
