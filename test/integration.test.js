// End-to-end tests: real HTTP server + Socket.IO + MongoDB.
// Run locally:  docker run -d -p 27017:27017 mongo:7
//               MONGODB_URI_TEST=mongodb://localhost:27017/chat_test npm test
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONGO, connect, disconnect, startServer, client, signup, connectSocket, nextEvent, noEvent,
} from './helpers.js';

const { Message } = await import('../src/models/message.model.js');
const { createRateLimiter } = await import('../src/lib/rateLimit.js');

describe('chat API (MongoDB)', { skip: !MONGO && 'MONGODB_URI_TEST not set' }, () => {
  let server;
  let alice;
  let bob;
  let carol;
  const sockets = [];
  const open = async (who, opts) => {
    const s = await connectSocket(server.base, who.cookie, opts);
    sockets.push(s);
    return s;
  };

  before(async () => {
    await connect();
    server = await startServer();
    alice = await signup(server.base, 'Alice');
    bob = await signup(server.base, 'Bob');
    carol = await signup(server.base, 'Carol');
  });

  after(async () => {
    sockets.forEach((s) => s.disconnect());
    await server?.close();
    await disconnect();
  });

  describe('auth', () => {
    test('session cookie is httpOnly + SameSite=Strict, password never returned', async () => {
      const c = client(server.base);
      const res = await c.call('POST', '/api/auth/signup', { fullName: 'Dan', email: 'dan@test.io', password: 'password123' });
      assert.equal(res.status, 201);
      assert.equal(res.body.password, undefined);
      const setCookie = res.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
    });

    test('duplicate email is 409 (case-insensitive)', async () => {
      const res = await client(server.base).call('POST', '/api/auth/signup', { fullName: 'X', email: 'ALICE@test.io', password: 'password123' });
      assert.equal(res.status, 409);
    });

    test('validation errors are 400', async () => {
      const c = client(server.base);
      assert.equal((await c.call('POST', '/api/auth/signup', { fullName: 'X', email: 'nope', password: 'password123' })).status, 400);
      assert.equal((await c.call('POST', '/api/auth/signup', { fullName: 'X', email: 'x@test.io', password: 'short' })).status, 400);
      assert.equal((await c.call('POST', '/api/auth/signup', '{"broken"')).status, 400);
    });

    test('login, me, logout', async () => {
      const c = client(server.base);
      assert.equal((await c.call('POST', '/api/auth/login', { email: 'alice@test.io', password: 'wrong-password' })).status, 401);
      assert.equal((await c.call('POST', '/api/auth/login', { email: 'Alice@Test.io', password: 'password123' })).status, 200);
      const me = await c.call('GET', '/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.email, 'alice@test.io');
      await c.call('POST', '/api/auth/logout');
      assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
    });

    test('garbage token is 401, not 500', async () => {
      const res = await fetch(`${server.base}/api/auth/me`, { headers: { Cookie: 'jwt=garbage' } });
      assert.equal(res.status, 401);
    });

    test('profile name update', async () => {
      const res = await alice.call('PATCH', '/api/auth/profile', { fullName: 'Alice A.' });
      assert.equal(res.status, 200);
      assert.equal(res.body.fullName, 'Alice A.');
    });

    test('image upload without Cloudinary configured is 501, not a crash', async () => {
      const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
      assert.equal((await alice.call('PATCH', '/api/auth/profile', { profilePic: png })).status, 501);
    });

    test('login is rate limited', async () => {
      const limited = await startServer({
        limiters: { auth: createRateLimiter({ windowMs: 60_000, max: 3 }), send: createRateLimiter({ windowMs: 60_000, max: 100 }) },
      });
      try {
        const c = client(limited.base);
        const statuses = [];
        for (let i = 0; i < 5; i++) {
          statuses.push((await c.call('POST', '/api/auth/login', { email: 'alice@test.io', password: 'bad-password' })).status);
        }
        assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
      } finally {
        await limited.close();
      }
    });
  });

  describe('messages', () => {
    test('send and read history in order; both sides see the same conversation', async () => {
      await alice.call('POST', `/api/messages/${bob.user._id}`, { text: 'hi bob' });
      await bob.call('POST', `/api/messages/${alice.user._id}`, { text: 'hi alice' });
      const a = await alice.call('GET', `/api/messages/${bob.user._id}`);
      const b = await bob.call('GET', `/api/messages/${alice.user._id}`);
      assert.deepEqual(a.body.messages.map((m) => m.text), ['hi bob', 'hi alice']);
      assert.deepEqual(b.body.messages.map((m) => m._id), a.body.messages.map((m) => m._id));
      assert.ok(a.body.messages[0].createdAt, 'timestamps are stored');
    });

    test('other users cannot see the conversation', async () => {
      const res = await carol.call('GET', `/api/messages/${bob.user._id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.messages.length, 0, 'carol<->bob is a different conversation');
    });

    test('cursor pagination walks the full history without gaps or duplicates', async () => {
      for (let i = 0; i < 25; i++) {
        // eslint-disable-next-line no-await-in-loop
        await carol.call('POST', `/api/messages/${alice.user._id}`, { text: `m${i}` });
      }
      const seen = [];
      let cursor;
      let pages = 0;
      do {
        // eslint-disable-next-line no-await-in-loop
        const res = await alice.call('GET', `/api/messages/${carol.user._id}?limit=10${cursor ? `&before=${cursor}` : ''}`);
        assert.equal(res.status, 200);
        seen.unshift(...res.body.messages.map((m) => m.text));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor);
      assert.equal(pages, 3);
      assert.deepEqual(seen, Array.from({ length: 25 }, (_, i) => `m${i}`));
    });

    test('validation: empty, too long, self, unknown user, bad ids', async () => {
      assert.equal((await alice.call('POST', `/api/messages/${bob.user._id}`, { text: '  ' })).status, 400);
      assert.equal((await alice.call('POST', `/api/messages/${bob.user._id}`, { text: 'x'.repeat(2001) })).status, 400);
      assert.equal((await alice.call('POST', `/api/messages/${alice.user._id}`, { text: 'me' })).status, 400);
      assert.equal((await alice.call('POST', '/api/messages/64b000000000000000000000', { text: 'ghost' })).status, 404);
      assert.equal((await alice.call('GET', '/api/messages/not-an-id')).status, 400);
      assert.equal((await alice.call('GET', `/api/messages/${bob.user._id}?before=bad`)).status, 400);
    });

    test('unauthenticated requests are rejected', async () => {
      assert.equal((await client(server.base).call('GET', `/api/messages/${bob.user._id}`)).status, 401);
    });
  });

  describe('idempotent sends', () => {
    test('a retried send with the same clientMessageId is stored once', async () => {
      const body = { text: 'pay rent', clientMessageId: 'retry-test-0001' };
      const first = await alice.call('POST', `/api/messages/${bob.user._id}`, body);
      const retry = await alice.call('POST', `/api/messages/${bob.user._id}`, body);
      assert.equal(first.status, 201);
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), 'true');
      assert.equal(retry.body._id, first.body._id);
    });

    test('20 concurrent sends with one clientMessageId create exactly one message', async () => {
      const body = { text: 'race', clientMessageId: 'race-test-000001' };
      const results = await Promise.all(Array.from({ length: 20 }, () => alice.call('POST', `/api/messages/${bob.user._id}`, body)));
      assert.ok(results.every((r) => r.status === 201 || r.status === 200), results.map((r) => r.status).join(','));
      assert.equal(new Set(results.map((r) => r.body._id)).size, 1);
      assert.equal(await Message.countDocuments({ clientMessageId: 'race-test-000001' }), 1);
    });

    test('the same clientMessageId from a different sender is a different message', async () => {
      const body = { text: 'mine', clientMessageId: 'shared-id-000001' };
      const a = await alice.call('POST', `/api/messages/${carol.user._id}`, body);
      const c = await carol.call('POST', `/api/messages/${alice.user._id}`, body);
      assert.equal(a.status, 201);
      assert.equal(c.status, 201);
      assert.notEqual(a.body._id, c.body._id);
    });
  });

  describe('real-time', () => {
    test('socket connection requires a valid session', async () => {
      await assert.rejects(connectSocket(server.base, ''), /unauthorized/);
      await assert.rejects(connectSocket(server.base, 'jwt=forged'), /unauthorized/);
    });

    test('the original ?userId= impersonation no longer works', async () => {
      await assert.rejects(connectSocket(server.base, '', { query: { userId: String(bob.user._id) } }), /unauthorized/);
    });

    test('new messages reach EVERY tab of the receiver, plus the sender\'s other tabs', async () => {
      const bobTab1 = await open(bob);
      const bobTab2 = await open(bob);
      const aliceTab = await open(alice);
      const got = Promise.all([
        nextEvent(bobTab1, 'message:new'),
        nextEvent(bobTab2, 'message:new'),
        nextEvent(aliceTab, 'message:new'),
      ]);
      const sent = await alice.call('POST', `/api/messages/${bob.user._id}`, { text: 'multi-tab' });
      const [m1, m2, m3] = await got;
      assert.equal(m1._id, sent.body._id);
      assert.equal(m2._id, sent.body._id);
      assert.equal(m3._id, sent.body._id);
      assert.equal(await noEvent(await open(carol), 'message:new'), true, 'third parties get nothing');
    });

    test('an idempotent replay does not re-broadcast', async () => {
      const bobTab = await open(bob);
      const body = { text: 'once', clientMessageId: 'broadcast-once-01' };
      const first = nextEvent(bobTab, 'message:new');
      await alice.call('POST', `/api/messages/${bob.user._id}`, body);
      await first;
      await alice.call('POST', `/api/messages/${bob.user._id}`, body);
      assert.equal(await noEvent(bobTab, 'message:new'), true);
    });

    test('typing indicators go only to the addressee', async () => {
      const aliceTab = await open(alice);
      const bobTab = await open(bob);
      const carolTab = await open(carol);
      const got = nextEvent(bobTab, 'typing');
      aliceTab.emit('typing', { to: String(bob.user._id), isTyping: true });
      assert.deepEqual(await got, { from: String(alice.user._id), isTyping: true });
      assert.equal(await noEvent(carolTab, 'typing'), true);
    });

    test('read receipts: unread counts, then messages:read to the sender', async () => {
      const dan = await signup(server.base, 'Dana');
      await dan.call('POST', `/api/messages/${bob.user._id}`, { text: 'one' });
      await dan.call('POST', `/api/messages/${bob.user._id}`, { text: 'two' });

      const contacts = await bob.call('GET', '/api/users');
      const danRow = contacts.body.find((u) => u._id === dan.user._id);
      assert.equal(danRow.unreadCount, 2);
      assert.equal(danRow.lastMessage.text, 'two');
      assert.equal(contacts.body[0]._id, dan.user._id, 'most recent conversation first');

      const danTab = await open(dan);
      const receipt = nextEvent(danTab, 'messages:read');
      const res = await bob.call('POST', `/api/messages/${dan.user._id}/read`);
      assert.equal(res.body.updated, 2);
      const event = await receipt;
      assert.equal(event.by, String(bob.user._id));
      assert.equal(event.ids.length, 2);

      const after = await bob.call('GET', '/api/users');
      assert.equal(after.body.find((u) => u._id === dan.user._id).unreadCount, 0);
      assert.equal((await bob.call('POST', `/api/messages/${dan.user._id}/read`)).body.updated, 0, 'idempotent');
    });

    test('presence: online with any tab open, offline only after the last tab closes', async () => {
      const erin = await signup(server.base, 'Erin');
      const watcher = await open(carol);

      const cameOnline = nextEvent(watcher, 'presence:update');
      const tab1 = await connectSocket(server.base, erin.cookie);
      assert.deepEqual(await cameOnline, { userId: String(erin.user._id), online: true });
      const tab2 = await connectSocket(server.base, erin.cookie);

      const list = await carol.call('GET', '/api/users');
      assert.equal(list.body.find((u) => u._id === erin.user._id).online, true);

      tab1.disconnect();
      assert.equal(await noEvent(watcher, 'presence:update', 400), true, 'still online via tab2');

      const wentOffline = nextEvent(watcher, 'presence:update');
      tab2.disconnect();
      const offline = await wentOffline;
      assert.equal(offline.online, false);
      assert.ok(offline.lastSeenAt);
    });
  });

  describe('ops', () => {
    test('health check and web client are served', async () => {
      const health = await fetch(`${server.base}/health`);
      assert.equal(health.status, 200);
      const page = await fetch(`${server.base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>/);
    });

    test('unknown API routes are JSON 404s', async () => {
      const res = await client(server.base).call('GET', '/api/nope');
      assert.equal(res.status, 404);
      assert.equal(res.body.message, 'Not found');
    });
  });
});
