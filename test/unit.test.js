import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceRegistry } from '../src/realtime/presence.js';
import { conversationIdFor } from '../src/models/message.model.js';
import { createRateLimiter } from '../src/lib/rateLimit.js';
import { parseCookies } from '../src/lib/auth.js';
import { validateMessageInput } from '../src/services/message.service.js';
import { validateImageDataUrl } from '../src/lib/images.js';

describe('PresenceRegistry', () => {
  test('a user stays online until their LAST socket disconnects', () => {
    const p = new PresenceRegistry();
    assert.equal(p.add('u1', 'tab-a'), true, 'first socket brings the user online');
    assert.equal(p.add('u1', 'tab-b'), false, 'second tab is not a new online event');
    assert.equal(p.remove('u1', 'tab-a'), false, 'closing one tab keeps them online');
    assert.equal(p.isOnline('u1'), true);
    assert.equal(p.remove('u1', 'tab-b'), true, 'closing the last tab takes them offline');
    assert.equal(p.isOnline('u1'), false);
  });

  test('removing unknown sockets is harmless', () => {
    const p = new PresenceRegistry();
    assert.equal(p.remove('ghost', 'x'), false);
    assert.deepEqual(p.onlineUserIds(), []);
  });
});

describe('conversationIdFor', () => {
  test('is symmetric', () => {
    assert.equal(conversationIdFor('b', 'a'), conversationIdFor('a', 'b'));
    assert.equal(conversationIdFor('a', 'b'), 'a_b');
  });
});

describe('rate limiter', () => {
  test('allows max requests per window, then resets', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    assert.equal(rl.take('k').allowed, true);
    assert.equal(rl.take('k').allowed, true);
    const third = rl.take('k');
    assert.equal(third.allowed, false);
    assert.equal(third.retryAfterMs, 1000);
    assert.equal(rl.take('other').allowed, true, 'keys are independent');
    t = 1000;
    assert.equal(rl.take('k').allowed, true, 'window resets');
  });
});

describe('parseCookies', () => {
  test('parses and decodes', () => {
    assert.deepEqual(parseCookies('a=1; jwt=x%3Dy; b=c=d'), { a: '1', jwt: 'x=y', b: 'c=d' });
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('validateMessageInput', () => {
  test('requires text or image', () => {
    assert.throws(() => validateMessageInput({}), /text or an image/);
    assert.throws(() => validateMessageInput({ text: '   ' }), /text or an image/);
  });
  test('trims and limits text', () => {
    assert.equal(validateMessageInput({ text: '  hi ' }).text, 'hi');
    assert.throws(() => validateMessageInput({ text: 'x'.repeat(2001) }), /at most 2000/);
    assert.throws(() => validateMessageInput({ text: 42 }), /must be a string/);
  });
  test('validates clientMessageId format', () => {
    assert.throws(() => validateMessageInput({ text: 'a', clientMessageId: 'short' }), /clientMessageId/);
    assert.throws(() => validateMessageInput({ text: 'a', clientMessageId: 'has spaces in it' }), /clientMessageId/);
    assert.equal(validateMessageInput({ text: 'a', clientMessageId: 'abcd-1234-efgh' }).clientMessageId, 'abcd-1234-efgh');
  });
});

describe('validateImageDataUrl', () => {
  test('accepts small images and rejects other input', () => {
    const png = `data:image/png;base64,${Buffer.from('hello').toString('base64')}`;
    assert.equal(validateImageDataUrl(png), 5);
    assert.throws(() => validateImageDataUrl('https://evil/x.png'), /data URL/);
    assert.throws(() => validateImageDataUrl('data:text/html;base64,PGgxPg=='), /data URL/);
    assert.throws(() => validateImageDataUrl(png, 2), /at most/);
  });
});
