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
