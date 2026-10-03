const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

process.env.PORT = '3998';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.LIVEKIT_API_KEY = 'testkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

const seen = [];
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url, host: req.headers.host });
  res.writeHead(401, { 'content-type': 'text/plain' }).end('no token');
});
const wss = new WebSocketServer({ server: upstream });
wss.on('connection', (ws, req) => {
  seen.push({ url: req.url, host: req.headers.host });
  ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
});

const BASE = 'localhost:3998';
let server;
let UPSTREAM_PORT;

// Port 0 so a busy fixed port can't fail the run; LIVEKIT_URL is read when
// server.js loads, hence the late require.
test.before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  UPSTREAM_PORT = upstream.address().port;
  process.env.LIVEKIT_URL = `ws://127.0.0.1:${UPSTREAM_PORT}`;
  ({ server } = require('../server'));
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
});
test.after(() => {
  wss.close();
  upstream.close();
  server.close();
  setTimeout(() => process.exit(), 100).unref();
});

test('/sfu/rtc/* WebSocket upgrades are relayed to the SFU with the path prefix stripped', async () => {
  const ws = new WebSocket(`ws://${BASE}/sfu/rtc/v1?access_token=abc`);
  const echoed = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (data) => resolve(data.toString()));
    ws.on('error', reject);
  });
  ws.close();
  assert.strictEqual(echoed, 'ping');
  assert.deepStrictEqual(seen.at(-1), { url: '/rtc/v1?access_token=abc', host: `127.0.0.1:${UPSTREAM_PORT}` });
});

test('/sfu/rtc/* HTTP requests are relayed, including the upstream status', async () => {
  const res = await fetch(`http://${BASE}/sfu/rtc/v1/validate?access_token=abc`);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(await res.text(), 'no token');
  assert.strictEqual(seen.at(-1).url, '/rtc/v1/validate?access_token=abc');
});

test('only the SFU rtc endpoints are reachable through /sfu', async () => {
  const before = seen.length;
  const res = await fetch(`http://${BASE}/sfu/twirp/livekit.RoomService/ListRooms`, { method: 'POST' });
  assert.notStrictEqual(res.status, 401);
  assert.strictEqual(seen.length, before);

  const ws = new WebSocket(`ws://${BASE}/sfu/admin`);
  const failed = await new Promise((resolve) => { ws.on('error', () => resolve(true)); ws.on('open', () => resolve(false)); });
  assert.strictEqual(failed, true);
  assert.strictEqual(seen.length, before);
});

test('an unreachable SFU gives the browser a failed upgrade, not a hang', async () => {
  upstream.close();
  wss.clients.forEach((c) => c.terminate());
  const ws = new WebSocket(`ws://${BASE}/sfu/rtc/v1`);
  const failed = await new Promise((resolve) => { ws.on('error', () => resolve(true)); ws.on('open', () => resolve(false)); });
  assert.strictEqual(failed, true);
});
