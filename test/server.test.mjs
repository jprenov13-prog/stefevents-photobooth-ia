import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudServer } from '../server.mjs';
import { newEvent, MongoUsageStore, reservationFilter } from '../usage-store.mjs';

const tabletToken = 'tablet-test-'.padEnd(48, 't');
const adminToken = 'admin-test-'.padEnd(48, 'a');
class TestStore {
  constructor() { this.state = newEvent('event001', 'Test', 3, 2); this.state.enabled = true; }
  async status() { return structuredClone(this.state); }
  async reserve(eventId, session, id, hash) {
    const s = this.state;
    if (s.eventId !== eventId || !s.enabled || s.used >= s.limit || s.requests.some(r => r.id === id) || s.requests.filter(r => r.session === session).length >= s.sessionLimit || s.leaseUntil > new Date()) return null;
    s.used++; s.requests.push({ id, session, hash, status: 'started' }); s.leaseUntil = new Date(Date.now() + 240_000); s.leaseOwner = id;
    return structuredClone(s);
  }
  async finish(eventId, id, status) { const s = this.state; if (s.eventId === eventId && s.leaseOwner === id) { s.requests.find(r => r.id === id).status = status; s.leaseUntil = new Date(0); s.leaseOwner = null; } }
  async configure(id, values) { if (id !== this.state.eventId) return null; Object.assign(this.state, values); return this.status(); }
  async startEvent(id, label, limit, sessionLimit) { if (id === this.state.eventId) return this.status(); if (this.state.leaseUntil > new Date()) return null; this.state = newEvent(id, label, limit, sessionLimit); return this.status(); }
}
async function harness(store, fetchImpl) {
  const server = createCloudServer({ store, key: 'mock-openai-key', tabletToken, adminToken, fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, close: () => new Promise(resolve => server.close(resolve)),
    request: async (route, body, token = tabletToken, headers = {}) => {
      const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { code: res.status, body: await res.json() };
    } };
}
const body = (id, session = 'session01', eventId = 'event001') => ({ eventId, session, requestId: id, prompt: 'Une forêt magique', style: 'realiste' });
const image = () => new Response(JSON.stringify({ data: [{ b64_json: 'a'.repeat(40) }] }), { status: 200 });

test('authentification, doublons, limites persistantes et séparation administrateur', async () => {
  const store = new TestStore(); let calls = 0;
  const mock = async (_url, options) => { calls++; assert.equal(store.state.used, calls); assert.equal(JSON.parse(options.body).model, 'gpt-image-2'); return image(); };
  let h = await harness(store, mock);
  try {
    assert.equal((await h.request('/generate', body('request01'), 'wrong')).code, 401);
    assert.equal((await h.request('/generate', body('request01'), tabletToken, { Origin: 'https://example.com' })).code, 401);
    assert.equal((await h.request('/admin/settings', { eventId: 'event001', limit: 500 })).code, 401);
    assert.equal(calls, 0);
    assert.equal((await h.request('/generate', body('request01'))).code, 200);
    assert.equal((await h.request('/generate', body('request01'))).code, 200); assert.equal(calls, 1);
    assert.equal((await h.request('/generate', body('request02'))).code, 200);
    assert.equal((await h.request('/generate', body('request03'))).code, 429); assert.equal(calls, 2);
    await h.close(); h = await harness(store, mock);
    assert.equal((await h.request('/generate', body('request01'))).code, 409); assert.equal(calls, 2);
    assert.equal((await h.request('/generate', body('request04', 'session02'))).code, 200);
    assert.equal((await h.request('/generate', body('request05', 'session03'))).code, 429); assert.equal(calls, 3);
    const disabled = await h.request('/admin/settings', { eventId: 'event001', enabled: false }, adminToken); assert.equal(disabled.code, 200);
    assert.equal((await h.request('/generate', body('request01'))).code, 403);
    const fresh = await h.request('/admin/new-event', { eventId: 'event002', label: 'Nouvelle soirée', limit: 10, sessionLimit: 3 }, adminToken);
    assert.equal(fresh.body.used, 0); assert.equal(fresh.body.enabled, false);
    assert.equal((await h.request('/generate', body('request06', 'session01', 'event001'))).code, 409);
    assert.equal((await h.request('/admin/settings', { eventId: 'event002', enabled: true, sessionLimit: 99 }, adminToken)).code, 400);
    assert.equal(calls, 3);
  } finally { await h.close(); }
});
test('requêtes simultanées : une seule réserve et un seul appel', async () => {
  const store = new TestStore(); let calls = 0; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = await harness(store, async () => { calls++; await blocked; return image(); });
  try {
    const first = h.request('/generate', body('request01'));
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    const second = await h.request('/generate', body('request02', 'session02')); assert.equal(second.code, 429);
    assert.equal((await h.request('/admin/new-event', { eventId: 'event002', label: 'Autre', limit: 10, sessionLimit: 2 }, adminToken)).code, 409);
    release(); assert.equal((await first).code, 200); assert.equal(calls, 1); assert.equal(store.state.used, 1);
  } finally { release(); await h.close(); }
});
test('MongoDB indisponible : aucun appel payant ; erreur après réservation sans retry', async () => {
  const store = new TestStore(); let calls = 0;
  const h = await harness(store, async () => { calls++; throw new Error('SECRET-MUST-NOT-APPEAR'); });
  try {
    const first = await h.request('/generate', body('request01')); assert.equal(first.code, 503); assert.ok(!JSON.stringify(first.body).includes('SECRET'));
    assert.equal((await h.request('/generate', body('request01'))).code, 409); assert.equal(calls, 1); assert.equal(store.state.used, 1);
    store.status = async () => { throw new Error('DB unavailable'); };
    assert.equal((await h.request('/generate', body('request02'))).code, 503); assert.equal(calls, 1);
  } finally { await h.close(); }
});
test('opération MongoDB : réservation conditionnelle, atomique et sans upsert', async () => {
  const time = new Date(); const filter = reservationFilter('event001', 'session01', 'request01', time);
  assert.equal(filter.enabled, true); assert.equal(filter['requests.id'].$ne, 'request01'); assert.deepEqual(filter.$expr.$and[0], { $lt: ['$used', '$limit'] }); assert.equal(filter.leaseUntil.$lte, time);
  let captured;
  const store = new MongoUsageStore({ findOneAndUpdate: async (...args) => { captured = args; return { used: 1 }; } });
  await store.reserve('event001', 'session01', 'request01', 'hash');
  assert.equal(captured[1].$inc.used, 1); assert.equal(captured[1].$push.requests.id, 'request01'); assert.equal(captured[2].upsert, undefined); assert.equal(captured[2].returnDocument, 'after');
});
