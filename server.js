/* =====================================================
   LA GUILDE — Serveur back-end
   Node.js + Express (API) + PostgreSQL (base de données Neon)
   =====================================================
   Rôle de ce fichier :
   1. Servir l'application web (le fichier public/index.html)
   2. Exposer une API REST : /api/state, /api/games, /api/ratings, /api/arcs
   3. Pousser les mises à jour en temps réel aux navigateurs connectés (SSE)
   ===================================================== */

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());            // pour lire le JSON envoyé par le front
app.use(express.static('public'));  // sert public/index.html sur la racine du site

/* ---------- Connexion à la base de données ----------
   DATABASE_URL est une "variable d'environnement" : une valeur secrète
   configurée dans Render (jamais écrite dans le code). */
if (!process.env.DATABASE_URL) {
  console.error('ERREUR : la variable DATABASE_URL est manquante.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // requis par Neon
});

/* ---------- Création des tables + données de départ ---------- */
const DEFAULT_MEMBERS = ['Pierric', 'Hugo', 'Sourya', 'Robin', 'Igor', 'Nico', 'Mathis'];

function seedGames() {
  const base = new Date('2026-06-01').getTime();
  let i = 0;
  const g = (name, proposedBy, robScore, price) => ({
    id: 'seed' + (i + 1),
    name, genres: [], link: '', price: (price === undefined ? null : price), note: '',
    proposedBy, addedAt: new Date(base + (i++) * 86400000).toISOString(),
    ratings: (robScore == null ? {} : { Robin: robScore })
  });
  return [
    g('Project Winter', ['Igor'], 4), g('Fortnite', ['Hugo'], 6, 0), g('Minecraft', ['Robin'], 7),
    g('LoL', ['Sourya'], 8, 0), g('Battlefront 2', ['Hugo'], 6), g('Return to Moria', ['Robin'], 0),
    g('Guilty as sock!', ['Robin'], 8), g('The Elder Scrolls Online', ['Igor'], 3),
    g('Sea of Thieves', ['Pierric', 'Robin'], 1, 0), g('WWZ Aftermath', ['Sourya', 'Hugo'], 1),
    g('Raft', ['Robin'], 8), g('Dead by Daylight', ['Hugo'], 8), g('Unturned', ['Igor'], 0),
    g('Valorant', ['Pierric'], 3, 0), g('Green hell', ['Robin'], 9), g('Icarus', ['Robin', 'Igor'], 8),
    g('Starcraft', ['Pierric', 'Hugo'], 5, 0)
  ];
}

async function initDb() {
  // On stocke chaque jeu/aventure en JSONB : souple et simple à faire évoluer.
  await pool.query(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS arcs  (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS meta  (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);

  // Liste des joueurs (si absente)
  await pool.query(
    `INSERT INTO meta (key, value) VALUES ('members', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_MEMBERS)]
  );

  // Jeux de départ, uniquement si la table est vide
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM games`);
  if (rows[0].n === 0) {
    for (const game of seedGames()) {
      await pool.query(`INSERT INTO games (id, data) VALUES ($1, $2)`, [game.id, JSON.stringify(game)]);
    }
    console.log('Base initialisée avec les jeux de départ.');
  }
}

/* ---------- Temps réel (Server-Sent Events) ----------
   Chaque navigateur ouvert garde une connexion ; à chaque modification,
   on lui envoie un petit signal et il recharge les données. */
let clients = [];
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: hello\n\n');
  clients.push(res);
  req.on('close', () => { clients = clients.filter(c => c !== res); });
});
function broadcast() {
  for (const c of clients) c.write('data: update\n\n');
}
// Battement de cœur toutes les 25 s pour que la connexion reste ouverte
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

/* ---------- Petites protections sur les entrées ---------- */
const isStr = (v, max = 300) => typeof v === 'string' && v.length <= max;
const clampScore = v => Math.max(0, Math.min(10, Math.round(Number(v))));

/* ==================== L'API ==================== */

/* Tout l'état d'un coup : joueurs, jeux, aventures */
app.get('/api/state', async (req, res) => {
  try {
    const members = (await pool.query(`SELECT value FROM meta WHERE key='members'`)).rows[0]?.value ?? DEFAULT_MEMBERS;
    const games = (await pool.query(`SELECT data FROM games`)).rows.map(r => r.data);
    const arcs = (await pool.query(`SELECT data FROM arcs`)).rows.map(r => r.data);
    res.json({ members, games, arcs });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Proposer un jeu */
app.post('/api/games', async (req, res) => {
  try {
    const b = req.body || {};
    if (!isStr(b.id, 60) || !isStr(b.name, 120) || !b.name.trim()) return res.status(400).json({ error: 'invalid' });
    const game = {
      id: b.id, name: b.name.trim(),
      genres: Array.isArray(b.genres) ? b.genres.filter(g => isStr(g, 40)).slice(0, 12) : [],
      link: isStr(b.link, 500) ? b.link : '',
      price: (b.price === null || b.price === undefined) ? null : Math.max(0, Number(b.price) || 0),
      note: isStr(b.note, 1000) ? b.note : '',
      proposedBy: Array.isArray(b.proposedBy) ? b.proposedBy.filter(p => isStr(p, 40)) : [],
      addedAt: new Date().toISOString(),
      ratings: {}
    };
    // La note d'envie du proposeur, si fournie
    if (b.ratings && typeof b.ratings === 'object') {
      for (const [m, s] of Object.entries(b.ratings)) if (isStr(m, 40)) game.ratings[m] = clampScore(s);
    }
    await pool.query(`INSERT INTO games (id, data) VALUES ($1, $2)`, [game.id, JSON.stringify(game)]);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Modifier la fiche d'un jeu (nom, genres, lien, prix, mot) */
app.put('/api/games/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(`SELECT data FROM games WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const game = rows[0].data;
    if (isStr(b.name, 120) && b.name.trim()) game.name = b.name.trim();
    if (Array.isArray(b.genres)) game.genres = b.genres.filter(g => isStr(g, 40)).slice(0, 12);
    if (isStr(b.link, 500)) game.link = b.link;
    game.price = (b.price === null || b.price === undefined) ? null : Math.max(0, Number(b.price) || 0);
    if (isStr(b.note, 1000)) game.note = b.note;
    await pool.query(`UPDATE games SET data=$2 WHERE id=$1`, [req.params.id, JSON.stringify(game)]);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Supprimer un jeu */
app.delete('/api/games/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM games WHERE id=$1`, [req.params.id]);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Enregistrer des notes : { member: "Hugo", updates: { idDuJeu: 8, ... } }
   On ne réécrit QUE la note du joueur concerné : deux amis peuvent noter
   en même temps sans s'écraser mutuellement. */
app.post('/api/ratings', async (req, res) => {
  try {
    const { member, updates } = req.body || {};
    if (!isStr(member, 40) || !updates || typeof updates !== 'object') return res.status(400).json({ error: 'invalid' });
    for (const [gameId, score] of Object.entries(updates)) {
      await pool.query(
        `UPDATE games SET data = jsonb_set(data, ARRAY['ratings', $2::text], to_jsonb($3::int), true) WHERE id=$1`,
        [gameId, member, clampScore(score)]
      );
    }
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Lancer une aventure */
app.post('/api/arcs', async (req, res) => {
  try {
    const b = req.body || {};
    if (!isStr(b.id, 60) || !isStr(b.name, 120) || !b.name.trim()) return res.status(400).json({ error: 'invalid' });
    const arc = {
      id: b.id, name: b.name.trim(),
      gameId: isStr(b.gameId, 60) ? b.gameId : '',
      gameName: isStr(b.gameName, 120) ? b.gameName : '?',
      participants: Array.isArray(b.participants) ? b.participants.filter(p => isStr(p, 40)) : [],
      startDate: isStr(b.startDate, 20) ? b.startDate : new Date().toISOString().slice(0, 10),
      createdBy: isStr(b.createdBy, 40) ? b.createdBy : '?',
      createdAt: new Date().toISOString(),
      status: 'en cours'
    };
    await pool.query(`INSERT INTO arcs (id, data) VALUES ($1, $2)`, [arc.id, JSON.stringify(arc)]);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Terminer une aventure */
app.post('/api/arcs/:id/end', async (req, res) => {
  try {
    await pool.query(
      `UPDATE arcs SET data = data || jsonb_build_object('status', 'terminée', 'endedAt', $2::text) WHERE id=$1`,
      [req.params.id, new Date().toISOString()]
    );
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Démarrage ---------- */
const PORT = process.env.PORT || 3000; // Render fournit PORT automatiquement
initDb()
  .then(() => app.listen(PORT, () => console.log('La Guilde est en ligne sur le port ' + PORT)))
  .catch(e => { console.error('Impossible d\'initialiser la base :', e); process.exit(1); });
