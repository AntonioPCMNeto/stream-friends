// Persistent "servers" (Discord-style rooms) for signed-in accounts — see
// auth.js for the identity these are keyed on. Purely additive: a room's
// id is just a normal room code as far as the realtime layer (peers.js,
// server.js) is concerned, so none of that needs to know these exist.
//
// All writes go through two Postgres RPC functions (create_room,
// join_room_by_invite) rather than direct table inserts — row-level
// security on `rooms`/`room_members` only grants SELECT, so those RPCs are
// the sole path to creating a room or joining one. See the migration this
// was set up with for the exact policies.
import { getClient } from './auth.js';

// Rooms you belong to, newest last. RLS already scopes this to your own
// memberships — no need to filter client-side.
export async function listMyRooms() {
  const supabase = getClient();
  if (!supabase) return [];
  const { data, error } = await supabase.from('rooms').select('id, name').order('created_at');
  if (error) {
    console.error('Failed to list servers:', error);
    return [];
  }
  return data || [];
}

// The latest messages of a channel, oldest first. RLS scopes this to servers
// you're a member of, so a guest (or a room code that isn't a channel) just
// gets []. Never throws: history is a nicety, live chat works without it.
export async function listMessages(channelId, limit) {
  const supabase = getClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('messages')
    .select('username, body, created_at')
    .eq('channel_id', channelId)
    .order('id', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Failed to load chat history:', error);
    return [];
  }
  return (data || []).reverse();
}

// Returns { room } on success or { error } — never throws, same
// error-string convention as auth.js's signIn/signUp.
export async function createRoom(name) {
  const supabase = getClient();
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { data, error } = await supabase.rpc('create_room', { room_name: name });
  if (error) return { error: error.message };
  return { room: data };
}

// Silently registers persistent membership for a room code, if that code
// happens to belong to a real server. Most room codes are just ephemeral
// guest rooms and don't — that's expected, not an error, so failures are
// swallowed and this resolves to null rather than surfacing anything.
export async function tryJoinByInvite(roomId) {
  const supabase = getClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('join_room_by_invite', { invite: roomId });
  if (error) return null;
  return data;
}

// Explicit "join this server" action (the modal's join-by-code tab) — same
// RPC as tryJoinByInvite, but a bad code here is a real error to show the
// user rather than an expected, silently-swallowed no-op.
export async function joinRoomByCode(code) {
  const supabase = getClient();
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { data, error } = await supabase.rpc('join_room_by_invite', { invite: code });
  if (error) return { error: error.message };
  if (!data) return { error: 'Código de convite inválido.' };
  return { room: data };
}

// Any member can delete any channel — same permission model as
// createChannel/set_channel_type (membership only, no owner check).
export async function deleteChannel(channelId) {
  const supabase = getClient();
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { error } = await supabase.rpc('delete_channel', { target_channel_id: channelId });
  if (error) return { error: error.message };
  return {};
}

// Removes your own membership row, dropping the server off "Meus
// Servidores". Doesn't touch the room itself or other members — same
// RPC-only convention as createRoom/tryJoinByInvite, since RLS only grants
// SELECT on room_members directly.
export async function leaveRoom(roomId) {
  const supabase = getClient();
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { error } = await supabase.rpc('leave_room', { target_room_id: roomId });
  if (error) return { error: error.message };
  return {};
}

// A server's channels, newest last. RLS scopes this to servers you're a
// member of (see the channels SELECT policy) — no client-side filtering
// needed. Every server always has at least a default "Geral" channel,
// created by a DB trigger on the room itself.
export async function listChannels(roomId) {
  const supabase = getClient();
  if (!supabase) return [];
  const { data, error } = await supabase.from('channels').select('id, name, type').eq('room_id', roomId).order('created_at');
  if (error) {
    console.error('Failed to list channels:', error);
    return [];
  }
  return data || [];
}

// Returns { channel } on success or { error } — same convention as
// createRoom. Goes through the create_channel RPC (not a direct insert)
// since it also checks the caller is actually a member of the room.
// create_channel itself only ever makes a 'text' channel (its signature
// predates the type column, see supabase/migrations/0001_channel_type.sql)
// — a 'voice' request is a second RPC call, set_channel_type, right after.
// Non-fatal if that second call fails: the channel still exists as text,
// just not the kind that was asked for, rather than not existing at all.
export async function createChannel(roomId, name, type = 'text') {
  const supabase = getClient();
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { data, error } = await supabase.rpc('create_channel', { target_room_id: roomId, channel_name: name });
  if (error) return { error: error.message };

  if (type === 'voice') {
    const { error: typeError } = await supabase.rpc('set_channel_type', { target_channel_id: data.id, new_type: 'voice' });
    if (typeError) {
      console.error('Failed to set channel type to voice:', typeError);
      return { channel: data };
    }
    return { channel: { ...data, type: 'voice' } };
  }

  return { channel: data };
}
