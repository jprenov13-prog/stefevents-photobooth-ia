# StefEvents Photobooth — relais IA en ligne

Serveur Node.js destiné à un service Render séparé de la caisse. Il transmet les demandes à OpenAI et conserve le compteur dans **MongoDB Atlas → `stefevents_photobooth` → `ai_usage`**. Le nom de cette base est fixé dans le code. L’utilisateur MongoDB prévu est `photobooth_ia`, autorisé uniquement sur cette base.

## Fonctionnement

- Le premier événement est créé avec **l’offre désactivée**, un plafond de **10 appels** et **2 essais par session**.
- Les limites sont appliquées côté serveur. Une réservation atomique MongoDB incrémente le compteur **avant** l’appel OpenAI.
- Double clic : pas de deuxième appel pour le même identifiant. Après un redémarrage, la demande reste enregistrée et n’est pas relancée.
- Une erreur ou un délai dépassé laisse l’essai compté par précaution. Aucun retry automatique d’OpenAI.
- MongoDB indisponible : créations bloquées avant l’appel payant.
- Seul le dernier fond est conservé temporairement en mémoire, pendant environ dix minutes. Aucune image, photo de personne, clé ni description de l’invité n’est enregistrée dans MongoDB. Les métadonnées de demande et les compteurs y restent pour éviter les doublons.
- Modèle : **gpt-image-2**, qualité **medium**, une image JPEG **1536 × 1024**. Le prompt ajoute automatiquement une zone centrale dégagée, sans personnages, texte ni logos.
- Le jeton tablette autorise les créations et la lecture du compteur. Un jeton administrateur distinct autorise les réglages et le démarrage d’une nouvelle soirée.

Ce dépôt public ne doit contenir **aucun secret**, ni fichier `.env`, ni export de Render, ni copie des mots de passe MongoDB.

## Mettre les fichiers sur GitHub

Dans le dépôt `stefevents-photobooth-ia`, utiliser **Add file → Upload files**. Déposer les fichiers du dossier extrait **à la racine du dépôt** (pas le ZIP ni le dossier parent) : `package.json`, `package-lock.json`, `main.mjs`, `server.mjs`, `usage-store.mjs`, `README.md`, ainsi que les fichiers de `test/` et les fichiers de configuration fournis. Remplacer le README vide créé au départ si nécessaire.

Avant de valider le commit, vérifier que `package.json` apparaît directement à la racine. Ce sont uniquement les fichiers de code fournis ; ne jamais ajouter l’adresse MongoDB renseignée ni les clés.

## Configurer Render

Créer un **nouveau Web Service**, avec l’URL du dépôt public. Utiliser la même région que le service de caisse si possible.

| Champ | Valeur |
|---|---|
| Name | `stefevents-photobooth-ia` |
| Language / Runtime | Node |
| Branch | `main` |
| Root Directory | laisser vide |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Instance Type | Free pour le test |
| Health Check Path | `/health` |

Ajouter **uniquement dans Environment de ce nouveau service** :

| Variable | Valeur à saisir toi-même |
|---|---|
| `MONGO_URL` | Adresse Atlas avec l’utilisateur `photobooth_ia` et son mot de passe |
| `OPENAI_API_KEY` | La clé OpenAI créée pour le photobooth |
| `PHOTOBOOTH_TOKEN` | Jeton aléatoire réservé à la tablette, au moins 32 caractères |
| `PHOTOBOOTH_ADMIN_TOKEN` | Deuxième jeton aléatoire, différent, réservé aux réglages administrateur |
| `NODE_VERSION` | `24.21.0` |

Ne pas modifier l’environnement du service `stefevents-backend` de la caisse. Ne pas copier ses variables SMTP dans ce nouveau service : le relais IA n’en a pas besoin.

### Adresse MongoDB

Dans l’URI copiée depuis Atlas, remplacer le nom d’utilisateur par `photobooth_ia` si nécessaire et `<db_password>` par son mot de passe. Si le mot de passe contient des caractères réservés (`@`, `:`, `/`, etc.), les encoder pour une URL. Ne pas réutiliser l’utilisateur de la caisse. La chaîne ne doit plus contenir de texte entre chevrons.

Les IP sortantes du **nouveau** service Render doivent être autorisées dans Atlas → Network Access. En cas de blocage, ajouter les plages affichées par Render pour ce service ; conserver les règles existantes nécessaires à la caisse.

### Générer les deux jetons sur le PC

Dans PowerShell, exécuter cette commande **deux fois** :

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chaque résultat est un secret différent. Copier le premier dans `PHOTOBOOTH_TOKEN`, le second dans `PHOTOBOOTH_ADMIN_TOKEN`, puis les conserver pour la configuration de la tablette. Ne pas les envoyer dans le chat, les committer ni les inclure dans une capture.

## Après le déploiement

La page publique `https://nom-du-service.onrender.com/health` doit afficher `status: ok`. Elle ne permet aucune création ni modification.

La génération et les routes d’administration exigent un en-tête `Authorization: Bearer …`. L’offre reste bloquée jusqu’à son activation explicite.

**L’APK actuel utilise encore le relais USB.** Une mise à jour de la connexion de l’application en HTTPS sera fournie après récupération de l’URL de ce service. Ne pas débrancher le PC pour utiliser l’IA tant que cette mise à jour n’est pas installée et testée.

## Routes

| Route | Accès | Usage |
|---|---|---|
| `GET /health` | public | État du service et de sa base |
| `GET /status` | tablette | Événement, activation et compteur |
| `POST /generate` | tablette | `eventId`, `session`, `requestId`, `prompt`, `style` |
| `POST /admin/settings` | administrateur | `eventId`, puis `enabled`, `limit` et/ou `sessionLimit` |
| `POST /admin/new-event` | administrateur | Nouvel `eventId`, `label`, `limit`, `sessionLimit` |

Le changement de limites conserve le compteur consommé. Un nouvel événement remet son propre compteur à zéro **après action explicite administrateur** et archive les compteurs précédents. Il démarre désactivé. Il est refusé si une création est en cours. Les limites autorisées vont de 1 à 500 appels par soirée et de 1 à 5 essais par session.

Le compteur du premier événement cloud ne reprend pas automatiquement les appels du prototype USB. Il s’agit d’un nouveau test, désactivé au départ. Les consommations OpenAI restent visibles dans Billing.

## Limites de Render gratuit

Render gratuit peut se mettre en veille après 15 minutes sans requête. Le réveil peut ajouter environ une minute d’attente. La base Atlas conserve le compteur lors de ces redémarrages.

Les services gratuits partagent les 750 heures mensuelles du même espace Render, dont le service de caisse. Une éventuelle suspension pour dépassement concerne les services gratuits. Le gratuit est prévu ici pour valider le fonctionnement ; il n’apporte pas de garantie de disponibilité pour une soirée. Les générations restent facturées par OpenAI même si l’hébergement est gratuit.

Sources : https://render.com/docs/free et https://render.com/docs/node-version

## Vérifications

```text
npm ci
npm test
```

Les tests utilisent une API OpenAI et un stockage simulés : authentification, refus des réglages avec le jeton tablette, limites par session et globales, doublons après redémarrage, concurrence, changement de soirée, erreur de base et erreur d’API sans retry. La forme de la réservation atomique MongoDB est aussi contrôlée. Aucun appel OpenAI réel ni accès aux données de la caisse pendant ces tests.

La connexion Atlas réelle et le déploiement Render restent à valider après configuration de tes variables privées.

Documentation : https://www.mongodb.com/docs/manual/core/write-operations-atomicity/ et https://developers.openai.com/api/reference/resources/images/methods/generate
