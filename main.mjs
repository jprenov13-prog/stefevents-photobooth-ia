import { MongoClient } from 'mongodb';
import { MongoUsageStore } from './usage-store.mjs';
import { createCloudServer } from './server.mjs';

let client;
try {
  const uri = process.env.MONGO_URL;
  if (typeof uri !== 'string' || !uri.startsWith('mongodb+srv://')) throw new Error('MongoConfiguration');
  const parsed = new URL(uri);
  if (decodeURIComponent(parsed.username) !== 'photobooth_ia' || !parsed.hostname.endsWith('.mongodb.net') || parsed.searchParams.get('tls') === 'false') throw new Error('MongoUserConfiguration');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 5, retryWrites: true });
  await client.connect();
  // Base fixe : impossible de sélectionner une base de la caisse par une variable incorrecte.
  const store = new MongoUsageStore(client.db('stefevents_photobooth').collection('ai_usage'));
  await store.init();
  const server = createCloudServer({ store, key: process.env.OPENAI_API_KEY, tabletToken: process.env.PHOTOBOOTH_TOKEN, adminToken: process.env.PHOTOBOOTH_ADMIN_TOKEN });
  const port = Number(process.env.PORT || 10000);
  server.on('error', () => { console.error('Démarrage du serveur impossible. Vérifier le port et les réglages.'); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', () => console.log('StefEvents Photobooth IA prêt. MongoDB connecté. Offre désactivée au premier lancement.'));
  const stop = () => { server.close(() => { client.close().finally(() => process.exit(0)); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch {
  console.error('Démarrage impossible : vérifier MONGO_URL, OPENAI_API_KEY et les deux jetons, les droits MongoDB et les IP autorisées. Aucun secret affiché.');
  if (client) await client.close().catch(() => {});
  process.exitCode = 1;
}
