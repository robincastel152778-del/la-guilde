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

/* ---------- Notifications Discord ----------
   DISCORD_WEBHOOK_URL est une variable d'environnement à configurer dans
   Render. Si elle est absente ou que Discord ne répond pas, l'appli
   continue de fonctionner normalement : la notif est un bonus, jamais
   un point de panne. */
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
async function notifyDiscord(content) {
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'La Guilde', content, allowed_mentions: { parse: [] } })
    });
  } catch (e) { console.error('Notif Discord impossible :', e.message); }
}
/* "A, B et C" à la française */
const joinFr = arr => arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' et ' + arr[arr.length - 1];
const euro = n => String(n).replace('.', ',') + ' €';
const ddmm = iso => { const [, m, d] = String(iso).split('-'); return d && m ? d + '/' + m : iso; };
const promoPct = (game) => (game.price > 0 && game.promo && game.promo.price < game.price)
  ? Math.round((1 - game.promo.price / game.price) * 100) : null;

/* Journal des promos dénichées (sert au bilan mensuel) */
async function logPromo(by) {
  try {
    await pool.query(`INSERT INTO meta (key, value) VALUES ('promoLog', '[]') ON CONFLICT (key) DO NOTHING`);
    await pool.query(`UPDATE meta SET value = value || $1 WHERE key='promoLog'`,
      [JSON.stringify([{ by: by || '?', at: new Date().toISOString() }])]);
  } catch (e) { console.error(e); }
}

/* ---------- Petites protections sur les entrées ---------- */
const isStr = (v, max = 300) => typeof v === 'string' && v.length <= max;
const clampScore = v => Math.max(0, Math.min(10, Math.round(Number(v))));

/* Valide un objet promo { price, platform, until? } envoyé par le front */
function parsePromo(p) {
  if (!p || typeof p !== 'object') return null;
  const price = Number(p.price);
  if (!isStr(p.platform, 60) || !p.platform.trim() || isNaN(price) || price < 0) return null;
  const promo = { price: Math.round(price * 100) / 100, platform: p.platform.trim() };
  if (isStr(p.until, 20) && p.until) promo.until = p.until;
  if (isStr(p.by, 40) && p.by) promo.by = p.by;   // qui a déniché la promo
  promo.at = new Date().toISOString();             // quand (pour le bilan mensuel)
  return promo;
}

/* ==================== L'API ==================== */

/* Tout l'état d'un coup : joueurs, jeux, aventures */
app.get('/api/state', async (req, res) => {
  maybeMonthlyReport(); // vérifie si le bilan du mois doit partir (sans bloquer la réponse)
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
    // Promo signalée dès la proposition, si fournie
    const promo = parsePromo(b.promo);
    if (promo) game.promo = promo;
    await pool.query(`INSERT INTO games (id, data) VALUES ($1, $2)`, [game.id, JSON.stringify(game)]);
    // Notif Discord : "X propose Jeu (prix · genres) — envie : N/10"
    const proposer = game.proposedBy[0] || '?';
    const envy = game.ratings[proposer];
    let priceTxt = game.price === 0 ? 'gratuit' : (game.price != null ? euro(game.price) : 'prix ?');
    if (game.promo) {
      const pct = promoPct(game);
      priceTxt = euro(game.promo.price) + (pct ? ` en promo −${pct}%` : ' en promo');
      logPromo(game.promo.by || proposer);
    }
    const genresTxt = game.genres.length ? ' · ' + game.genres.join(', ') : '';
    notifyDiscord(`🎮 **${proposer}** propose **${game.name}** (${priceTxt}${genresTxt})${envy != null ? ` — envie : ${envy}/10` : ''}`);
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

/* Signaler, modifier ou retirer une promo : { price, platform, until? } ou { remove: true } */
app.post('/api/games/:id/promo', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT data FROM games WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const game = rows[0].data;
    if (req.body && req.body.remove) {
      delete game.promo;
    } else {
      const promo = parsePromo(req.body);
      if (!promo) return res.status(400).json({ error: 'invalid' });
      game.promo = promo;
    }
    await pool.query(`UPDATE games SET data=$2 WHERE id=$1`, [req.params.id, JSON.stringify(game)]);
    if (!(req.body && req.body.remove)) {
      // Notif Discord : "X a trouvé une bonne affaire !"
      const pct = promoPct(game);
      const deal = pct ? `à **−${pct}%**` : `à **${euro(game.promo.price)}**`;
      const until = game.promo.until ? ` jusqu'au ${ddmm(game.promo.until)}` : '';
      notifyDiscord(`🏷️ **${game.promo.by || 'Quelqu\u2019un'}** a trouvé une bonne affaire ! **${game.name}** ${deal}${until} sur ${game.promo.platform}`);
      logPromo(game.promo.by);
    }
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
      // Paliers de hype : 3 fans (≥7/10) → "lancez-vous", 4 → "il faut s'y mettre",
      // 5+ → "unanimité". Chaque palier ne notifie qu'une seule fois (hypeLevel).
      const { rows } = await pool.query(`SELECT data FROM games WHERE id=$1`, [gameId]);
      if (rows.length) {
        const game = rows[0].data;
        const fans = Object.entries(game.ratings || {}).filter(([, s]) => s >= 7).map(([m]) => m);
        const level = fans.length >= 5 ? 5 : fans.length;
        if (level >= 3 && level > (game.hypeLevel || 0)) {
          game.hypeLevel = level;
          await pool.query(`UPDATE games SET data=$2 WHERE id=$1`, [gameId, JSON.stringify(game)]);
          const list = joinFr(fans);
          if (level === 3) notifyDiscord(`⭐ **${game.name}** a l'air de plaire à au moins ${list}, lancez-vous !`);
          else if (level === 4) notifyDiscord(`⭐⭐ **${game.name}** plaît carrément à ${list} — il faut vraiment vous y mettre !`);
          else notifyDiscord(`🌟 **${game.name}** fait l'unanimité : ${list} sont chauds. Vous devriez clairement le lancer MAINTENANT !`);
        }
      }
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
    // Notif Discord : "X lance l'aventure « Y » sur Jeu avec A et B ! Bonne chance les nazes !"
    const others = arc.participants.filter(p => p !== arc.createdBy);
    notifyDiscord(`🚀 **${arc.createdBy}** lance l'aventure « ${arc.name} » sur **${arc.gameName}** ${others.length ? 'avec ' + joinFr(others) : 'en solo'} ! Bonne chance les nazes !`);
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

/* Supprimer une aventure (le front ne propose l'option qu'à son créateur) */
app.delete('/api/arcs/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM arcs WHERE id=$1`, [req.params.id]);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Le bilan mensuel ----------
   Le serveur gratuit dort quand personne ne l'utilise : le bilan part donc
   à la PREMIÈRE visite de l'appli après le 1er du mois, et une seule fois.
   Il porte sur le mois écoulé (propositions, promos) ; les moyennes hype/aigri
   portent sur toutes les notes actuelles, minimum 5 jeux notés pour concourir. */
let reportRunning = false;
async function maybeMonthlyReport() {
  if (!WEBHOOK || reportRunning) return;
  reportRunning = true;
  try {
    const nowKey = new Date().toISOString().slice(0, 7); // ex : "2026-08"
    const row = (await pool.query(`SELECT value FROM meta WHERE key='lastReport'`)).rows[0];
    if (!row) { // tout premier lancement : on note le mois courant sans rien envoyer
      await pool.query(`INSERT INTO meta (key, value) VALUES ('lastReport', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(nowKey)]);
      return;
    }
    if (row.value === nowKey) return; // déjà fait ce mois-ci
    // On marque AVANT d'envoyer, pour qu'un double chargement ne crée pas de doublon
    await pool.query(`UPDATE meta SET value=$1 WHERE key='lastReport'`, [JSON.stringify(nowKey)]);

    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    const prevKey = d.toISOString().slice(0, 7);
    const monthName = d.toLocaleDateString('fr-FR', { month: 'long' });

    const members = (await pool.query(`SELECT value FROM meta WHERE key='members'`)).rows[0]?.value ?? [];
    const games = (await pool.query(`SELECT data FROM games`)).rows.map(r => r.data);
    const promoLog = (await pool.query(`SELECT value FROM meta WHERE key='promoLog'`)).rows[0]?.value ?? [];
    if (!members.length) return;

    // Propositions du mois écoulé
    const propCount = Object.fromEntries(members.map(m => [m, 0]));
    for (const g of games) if ((g.addedAt || '').startsWith(prevKey))
      for (const p of (g.proposedBy || [])) if (p in propCount) propCount[p]++;
    const maxProp = Math.max(...Object.values(propCount));
    const minProp = Math.min(...Object.values(propCount));
    const topProp = members.filter(m => propCount[m] === maxProp);
    const lowProp = members.filter(m => propCount[m] === minProp);

    // Moyennes des notes (les jeux non notés ne comptent pas ; minimum 5 notes)
    const avgs = {};
    for (const m of members) {
      const notes = games.map(g => g.ratings?.[m]).filter(v => typeof v === 'number');
      if (notes.length >= 5) avgs[m] = notes.reduce((a, b) => a + b, 0) / notes.length;
    }
    const fmtAvg = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
    const qualified = Object.keys(avgs);
    let hypeLine = '_personne n\u2019a noté assez de jeux (minimum 5)_';
    let sourLine = hypeLine;
    if (qualified.length) {
      const hi = Math.max(...Object.values(avgs)), lo = Math.min(...Object.values(avgs));
      hypeLine = `${joinFr(qualified.filter(m => avgs[m] === hi))} — ${fmtAvg(hi)}/10 de moyenne`;
      sourLine = `${joinFr(qualified.filter(m => avgs[m] === lo))} — ${fmtAvg(lo)}/10 de moyenne`;
    }

    // Promos dénichées sur le mois écoulé
    const promoCount = {};
    for (const p of promoLog) if ((p.at || '').startsWith(prevKey)) promoCount[p.by] = (promoCount[p.by] || 0) + 1;
    const promoBest = Object.keys(promoCount).length ? Math.max(...Object.values(promoCount)) : 0;
    const snipers = Object.keys(promoCount).filter(m => promoCount[m] === promoBest);

    const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
    const report = [
      `🏆 **LE BILAN DU MOIS DE ${monthName.toUpperCase()}** 🏆`,
      maxProp > 0
        ? `📦 **Le fournisseur officiel** : ${joinFr(topProp)} — ${plural(maxProp, 'jeu')} proposé${maxProp > 1 ? 's' : ''}`
        : `📦 **Le fournisseur officiel** : personne n\u2019a proposé de jeu ce mois-ci 😬`,
      `🔥 **Le gamer le plus hype** : ${hypeLine}`,
      `🍋 **L'aigri d'or** : ${sourLine}`,
      `🐢 **Le fantôme des propositions** : ${joinFr(lowProp)} — ${plural(minProp, 'jeu')} proposé${minProp > 1 ? 's' : ''}`,
      promoBest > 0
        ? `🕵️ **Le sniper des promos** : ${joinFr(snipers)} — ${plural(promoBest, 'bonne')} affaire${promoBest > 1 ? 's' : ''} dénichée${promoBest > 1 ? 's' : ''}`
        : `🕵️ **Le sniper des promos** : aucune promo dénichée ce mois-ci`
    ].join('\n');
    await notifyDiscord(report);
    console.log('Bilan mensuel de ' + monthName + ' envoyé sur Discord.');
  } catch (e) { console.error('Bilan mensuel :', e); }
  finally { reportRunning = false; }
}

/* ---------- Démarrage ---------- */
const PORT = process.env.PORT || 3000; // Render fournit PORT automatiquement
initDb()
  .then(() => app.listen(PORT, () => console.log('La Guilde est en ligne sur le port ' + PORT)))
  .catch(e => { console.error('Impossible d\'initialiser la base :', e); process.exit(1); });
