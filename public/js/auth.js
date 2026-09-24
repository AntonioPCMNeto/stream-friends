// Optional email/password accounts via Supabase Auth. Purely additive —
// everything here degrades to "not signed in" (the existing guest flow) if
// SUPABASE_URL/SUPABASE_ANON_KEY aren't configured (see /config.js,
// server.js), so a deployment without Supabase set up still works exactly
// as before accounts existed.
//
// Loaded from a CDN ESM build to match the rest of public/js/ — no bundler
// in this project, so a package-manager dependency isn't reachable from
// the browser directly.
// Electron build: index.html loads a bundled supabase-js (vendor/supabase.js)
// since its CSP forbids the esm.sh import the web build uses.
const { createClient } = window.supabase;

const supabase = (window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
  ? createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

export function isConfigured() {
  return supabase !== null;
}

// Lets other modules (rooms.js) reuse this same client/session instead of
// creating a second one.
export function getClient() {
  return supabase;
}

// The username chosen at signup (stored as user_metadata on the Supabase
// user) is what should show up everywhere in the app — falls back to the
// email's local part for an account created before this field existed.
function displayNameOf(user) {
  const meta = user?.user_metadata || {};
  return meta.username || user?.email?.split('@')[0] || null;
}

// Supabase's GoTrue returns error messages in English with no localization
// hook of its own — matched against the common ones by substring since the
// exact wording isn't part of any stable API contract. Falls back to the
// original message for anything unrecognized, so a new/rare error is still
// visible (in English) rather than silently swallowed.
const ERROR_TRANSLATIONS = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail antes de entrar — veja o link que enviamos.'],
  [/user already registered/i, 'Já existe uma conta com esse e-mail.'],
  [/password should be at least/i, 'A senha deve ter pelo menos 6 caracteres.'],
  [/unable to validate email address/i, 'E-mail em formato inválido.'],
  [/email address .* is invalid/i, 'Esse e-mail não foi aceito pelo servidor — tente outro.'],
  [/email rate limit exceeded/i, 'Muitos e-mails enviados em pouco tempo. Aguarde um pouco e tente de novo.'],
  [/for security purposes, you can only request this after/i, 'Aguarde alguns segundos antes de tentar de novo.'],
  [/signup requires a valid password/i, 'Informe uma senha.'],
  [/to signup, please provide your email/i, 'Informe um e-mail.'],
];

function translateError(message) {
  if (!message) return message;
  const match = ERROR_TRANSLATIONS.find(([pattern]) => pattern.test(message));
  return match ? match[1] : message;
}

function toIdentity(session) {
  if (!session) return null;
  return {
    accessToken: session.access_token,
    username: displayNameOf(session.user),
    avatarUrl: session.user.user_metadata?.avatar_url || null,
  };
}

// Resolves to null when not signed in (or Supabase isn't configured).
export async function getIdentity() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return toIdentity(data?.session);
}

export function onIdentityChange(callback) {
  if (!supabase) return;
  supabase.auth.onAuthStateChange((_event, session) => callback(toIdentity(session)));
}

// Returns { error } — error is a user-facing message string, or undefined
// on success. Never throws: a signup/login failure is something the lobby
// form shows inline, not a crash.
export async function signUp(email, password, username) {
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { error } = await supabase.auth.signUp({ email, password, options: { data: { username } } });
  return { error: translateError(error?.message) };
}

export async function signIn(email, password) {
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: translateError(error?.message) };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Stores the picture under the account's own folder in the public "avatars"
// bucket (see supabase/migrations/0004_avatars.sql) with a fresh file name each
// time, so the old one can be dropped without CDN/browser caches serving it
// again, and records its URL in the account's metadata — which is what the
// server reads and relays to everyone else. Returns { error } like signIn.
export async function uploadAvatar(blob) {
  if (!supabase) return { error: 'Contas não estão configuradas neste servidor.' };
  const { data } = await supabase.auth.getSession();
  const user = data?.session?.user;
  if (!user) return { error: 'Entre na sua conta para trocar a foto.' };

  const path = `${user.id}/${Date.now()}.webp`;
  const upload = await supabase.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
  if (upload.error) return { error: 'Não foi possível enviar a foto. Tente de novo.' };

  const { publicUrl } = supabase.storage.from('avatars').getPublicUrl(path).data;
  const previous = user.user_metadata?.avatar_url;
  const { error } = await supabase.auth.updateUser({ data: { ...user.user_metadata, avatar_url: publicUrl } });
  if (error) {
    await supabase.storage.from('avatars').remove([path]);
    return { error: 'Não foi possível salvar a foto. Tente de novo.' };
  }

  const previousPath = previous?.split('/avatars/')[1];
  if (previousPath) supabase.storage.from('avatars').remove([previousPath]).catch(() => {});
  return {};
}
