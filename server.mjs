import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { publicStatus } from './usage-store.mjs';

const styles = { realiste: 'photographie réaliste et cinématographique', magique: 'décor féerique élégant, matières réalistes', aventure: 'décor de film d’aventure, matières réalistes' };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
export function authorized(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token.length < 32) return false;
  const supplied = Buffer.from(header), expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export function createCloudServer({ store, key, tabletToken, adminToken, fetchImpl = fetch }) {
  if (!store || !key || typeof tabletToken !== 'string' || tabletToken.length < 32 || typeof adminToken !== 'string' || adminToken.length < 32 || tabletToken === adminToken) throw new Error('ServerConfigurationInvalid');
  const cache = new Map();
  const send = (res, code, value) => {
    const body = JSON.stringify(value);
    if (!res.destroyed) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' }).end(body);
  };
  const getBody = async req => {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 8192) throw new Error('BodyTooLarge'); chunks.push(c); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BadBody');
    return value;
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      try { await store.status(); return send(res, 200, { status: 'ok', service: 'StefEvents Photobooth IA' }); }
      catch { return send(res, 503, { status: 'unavailable' }); }
    }
    const admin = req.url === '/admin/settings' || req.url === '/admin/new-event';
    if (req.headers.origin || !authorized(req.headers.authorization, admin ? adminToken : tabletToken)) return send(res, 401, { error: 'Connexion photobooth non autorisée. Vérifie les réglages dans Gestion.' });
    if (req.method === 'GET' && req.url === '/status') {
      try { return send(res, 200, publicStatus(await store.status())); }
      catch { return send(res, 503, { error: 'Compteur indisponible. Les créations sont bloquées par précaution.' }); }
    }
    if (admin && req.method === 'POST') {
      try {
        const body = await getBody(req);
        if (!validId(body.eventId)) return send(res, 400, { error: 'Événement invalide.' });
        if (req.url === '/admin/settings') {
          const values = {};
          if (Object.hasOwn(body, 'enabled')) { if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'Activation invalide.' }); values.enabled = body.enabled; }
          if (Object.hasOwn(body, 'limit')) { if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 500) return send(res, 400, { error: 'Plafond : de 1 à 500 appels.' }); values.limit = body.limit; }
          if (Object.hasOwn(body, 'sessionLimit')) { if (!Number.isInteger(body.sessionLimit) || body.sessionLimit < 1 || body.sessionLimit > 5) return send(res, 400, { error: 'Essais par session : de 1 à 5.' }); values.sessionLimit = body.sessionLimit; }
          if (!Object.keys(values).length) return send(res, 400, { error: 'Aucun réglage fourni.' });
          const result = await store.configure(body.eventId, values);
          return result ? send(res, 200, publicStatus(result)) : send(res, 409, { error: 'Événement modifié. Actualise le compteur.' });
        }
        if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 100 || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 500 || !Number.isInteger(body.sessionLimit) || body.sessionLimit < 1 || body.sessionLimit > 5) return send(res, 400, { error: 'Nom de soirée ou limites invalides.' });
        const result = await store.startEvent(body.eventId, body.label.trim(), body.limit, body.sessionLimit);
        if (result) { cache.clear(); return send(res, 200, publicStatus(result)); }
        return send(res, 409, { error: 'Une création est en cours ou la soirée a changé. Réessaie après actualisation.' });
      } catch (e) { return send(res, ['SyntaxError', 'BadBody', 'BodyTooLarge'].includes(e?.name) || ['BadBody', 'BodyTooLarge'].includes(e?.message) ? 400 : 503, { error: 'Réglage non enregistré. Vérifie la connexion et actualise le compteur.' }); }
    }
    if (req.method !== 'POST' || req.url !== '/generate') return send(res, 404, { error: 'Route inconnue.' });
    let reserved = null; let requestId = null;
    try {
      const body = await getBody(req);
      const { eventId, session, prompt, style } = body; requestId = body.requestId;
      if (!validId(eventId) || !validId(session) || !validId(requestId) || typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 600 || !Object.hasOwn(styles, style)) return send(res, 400, { error: 'Description, style ou session invalide.' });
      const hash = createHash('sha256').update(JSON.stringify({ prompt: prompt.trim(), style, session })).digest('hex');
      let state = await store.status();
      if (state.eventId !== eventId) return send(res, 409, { error: 'La soirée a changé. Reviens à l’accueil pour démarrer une nouvelle session.' });
      if (!state.enabled) return send(res, 403, { error: 'L’offre IA est désactivée pour cet événement.' });
      const previous = state.requests.find(r => r.id === requestId);
      const cacheKey = `${eventId}:${requestId}`;
      if (previous) {
        if (previous.hash !== hash) return send(res, 409, { error: 'Identifiant de demande déjà utilisé.' });
        const saved = cache.get(cacheKey);
        if (saved && saved.expiresAt > Date.now()) return send(res, 200, saved.value);
        return send(res, 409, { error: 'Cet essai a déjà été lancé. Aucun nouvel appel automatique.', attemptsUsed: state.requests.filter(r => r.session === session).length, remaining: Math.max(0, state.limit - state.used) });
      }
      reserved = await store.reserve(eventId, session, requestId, hash);
      if (!reserved) {
        state = await store.status();
        const count = state.requests.filter(r => r.session === session).length;
        const error = state.eventId !== eventId ? 'La soirée a changé. Actualise la session.' : !state.enabled ? 'L’offre IA est désactivée.' : state.used >= state.limit ? 'Les créations IA sont terminées pour cette soirée. Explore nos autres décors.' : count >= state.sessionLimit ? 'Les essais de cette session sont utilisés. Explore nos autres décors.' : 'Une création est déjà en cours. Patiente un instant.';
        return send(res, 429, { error, attemptsUsed: count, remaining: Math.max(0, state.limit - state.used) });
      }
      // L'écriture atomique MongoDB est confirmée AVANT d'appeler OpenAI.
      const response = await fetchImpl('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', n: 1, size: '1536x1024', quality: 'medium', output_format: 'jpeg',
          prompt: `Crée uniquement un fond pour un photobooth, format paysage. Style : ${styles[style]}. Idée de l’invité : ${prompt.trim()}. Aucun personnage ni visage humain, aucun texte, aucun logo. Conserve une zone centrale dégagée où des personnes réelles seront ajoutées ensuite. Perspective naturelle à hauteur humaine, lumière douce, détails nets. Les éléments spectaculaires restent sur les côtés ou en arrière-plan.` }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        const e = await response.json().catch(() => ({})); const code = e.error?.code;
        const error = code === 'insufficient_quota' ? 'Crédit OpenAI insuffisant. Vérifie Billing.' : response.status === 401 ? 'Clé OpenAI invalide ou expirée.' : response.status === 403 ? 'Accès au modèle refusé. Vérifie les permissions et les vérifications demandées par OpenAI.' : response.status === 429 ? 'OpenAI demande de patienter.' : code === 'moderation_blocked' ? 'Cette description ne peut pas être générée. Choisis une autre idée.' : `Création refusée par OpenAI (HTTP ${response.status}).`;
        await store.finish(eventId, requestId, 'failed'); return send(res, 502, { error, attemptsUsed: reserved.requests.filter(r => r.session === session).length, remaining: Math.max(0, reserved.limit - reserved.used) });
      }
      const result = await response.json(); const image = result.data?.[0]?.b64_json;
      if (typeof image !== 'string' || image.length < 10 || image.length > 14_000_000) throw new Error('InvalidImage');
      await store.finish(eventId, requestId, 'complete');
      const value = { image, attemptsUsed: reserved.requests.filter(r => r.session === session).length, remaining: Math.max(0, reserved.limit - reserved.used), eventId };
      // Dernière image en mémoire environ dix minutes. Aucun fond enregistré dans MongoDB.
      cache.clear(); cache.set(cacheKey, { expiresAt: Date.now() + 600_000, value }); send(res, 200, value);
    } catch (e) {
      if (reserved && requestId) await store.finish(reserved.eventId, requestId, 'uncertain').catch(() => {});
      const invalid = e?.name === 'SyntaxError' || ['BodyTooLarge', 'BadBody'].includes(e?.message);
      send(res, invalid ? 400 : 503, { error: invalid ? 'Demande invalide.' : reserved ? 'Création interrompue. Cet essai reste compté ; aucun nouvel appel automatique.' : 'Compteur ou connexion indisponible. Aucun appel OpenAI lancé.' });
    }
  });
  const sweep = setInterval(() => { for (const [id, item] of cache) if (item.expiresAt <= Date.now()) cache.delete(id); }, 60_000); sweep.unref();
  server.on('close', () => { clearInterval(sweep); cache.clear(); });
  server.requestTimeout = 240_000;
  return server;
}
