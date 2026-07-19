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
  // Disponibilités de la semaine (une ligne = une case cochée) et créneaux planifiés
  await pool.query(`CREATE TABLE IF NOT EXISTS avail (member TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'free', arc_id TEXT, PRIMARY KEY (member, day, slot))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, data JSONB NOT NULL)`);

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

/* ---------- Bot Discord ----------
   Trois superpouvoirs de plus que le webhook : créer un canal privé par
   campagne complète, y poster les créneaux avec des boutons ✅/❌, et
   réagir aux clics en direct. Nécessite DISCORD_BOT_TOKEN et
   DISCORD_GUILD_ID dans Render (DISCORD_CATEGORY_ID optionnel).
   Sans eux, l'appli fonctionne en mode webhook seul. */
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const CATEGORY_ID = process.env.DISCORD_CATEGORY_ID || '';
let DJS = null, bot = null, botReady = false;
if (BOT_TOKEN && GUILD_ID) {
  try {
    DJS = require('discord.js');
    bot = new DJS.Client({ intents: [DJS.GatewayIntentBits.Guilds] });
    bot.once('ready', () => { botReady = true; console.log('Bot Discord connecté : ' + bot.user.tag); });
    bot.on('interactionCreate', onDiscordInteraction);
    bot.login(BOT_TOKEN).catch(e => console.error('Connexion bot Discord impossible :', e.message));
  } catch (e) { console.error('discord.js indisponible :', e.message); }
} else {
  console.log('Bot Discord non configuré — mode webhook seul.');
}
const validDiscordId = v => /^\d{15,21}$/.test(v || '');
function slugChannel(name) {
  const base = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return '🎮-' + (base || 'campagne');
}
async function ensureArcChannel(arcId) {
  if (!botReady) return null;
  try {
    const arc = await getArc(arcId);
    if (!arc) return null;
    if (arc.channelId) return arc.channelId;
    const guild = await bot.guilds.fetch(GUILD_ID);
    const profiles = await getProfiles();
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [DJS.PermissionFlagsBits.ViewChannel] },
      { id: bot.user.id, allow: [DJS.PermissionFlagsBits.ViewChannel, DJS.PermissionFlagsBits.SendMessages] }
    ];
    for (const m of (arc.participants || [])) {
      const did = profiles[m]?.discordId;
      if (validDiscordId(did)) overwrites.push({ id: did, allow: [DJS.PermissionFlagsBits.ViewChannel, DJS.PermissionFlagsBits.SendMessages] });
    }
    const ch = await guild.channels.create({
      name: slugChannel(arc.name),
      type: DJS.ChannelType.GuildText,
      parent: CATEGORY_ID || undefined,
      permissionOverwrites: overwrites
    });
    arc.channelId = ch.id;
    await saveArcData(arc);
    await ch.send(`🏰 QG privé de « **${arc.name}** » sur **${arc.gameName}** — équipe : ${joinFr(arc.participants || [])}. Les créneaux planifiés arriveront ici, avec boutons !`);
    broadcast();
    return ch.id;
  } catch (e) { console.error('Création du canal de campagne impossible :', e.message); return null; }
}
/* Crée le canal quand une campagne (pas une session) atteint son effectif complet */
async function maybeCreateChannel(arcId) {
  try {
    const arc = await getArc(arcId);
    if (!arc || arc.status !== 'en cours' || arc.channelId) return;
    if (arc.kind === 'session' || arc.multi === true) return;
    if (arc.slots && (arc.participants || []).length >= arc.slots) await ensureArcChannel(arcId);
  } catch (e) { console.error(e); }
}
async function addMemberToChannel(arc, member) {
  if (!botReady || !arc || !arc.channelId) return;
  try {
    const profiles = await getProfiles();
    const did = profiles[member]?.discordId;
    if (!validDiscordId(did)) return;
    const ch = await bot.channels.fetch(arc.channelId);
    await ch.permissionOverwrites.edit(did, { ViewChannel: true, SendMessages: true });
    await ch.send(`👋 **${member}** rejoint le canal — bienvenue !`);
  } catch (e) { console.error('Ajout au canal impossible :', e.message); }
}
function slotText(s, arc) {
  const yes = Object.entries(s.responses || {}).filter(([, v]) => v === 'yes').map(([m]) => m);
  const no = Object.entries(s.responses || {}).filter(([, v]) => v === 'no').map(([m]) => m);
  return `🗓️ **${s.createdBy}** propose un créneau pour « **${arc.name}** » : **${ddmm(s.day)} · ${SLOT_LABEL[s.slot]}**\n` +
    `✅ Partants : ${yes.length ? joinFr(yes) : '—'}\n❌ Pas dispo : ${no.length ? joinFr(no) : '—'}`;
}
async function postSlotDiscord(s, arc) {
  try {
    const chId = arc.channelId || await ensureArcChannel(arc.id);
    if (botReady && chId) {
      const ch = await bot.channels.fetch(chId);
      const row = new DJS.ActionRowBuilder().addComponents(
        new DJS.ButtonBuilder().setCustomId(`slot:${s.id}:yes`).setLabel(`✅ J'y serai`).setStyle(DJS.ButtonStyle.Success),
        new DJS.ButtonBuilder().setCustomId(`slot:${s.id}:no`).setLabel('❌ Pas dispo').setStyle(DJS.ButtonStyle.Danger)
      );
      const msg = await ch.send({ content: slotText(s, arc), components: [row] });
      s.msgChannelId = chId; s.msgId = msg.id;
      await pool.query(`UPDATE slots SET data=$2 WHERE id=$1`, [s.id, JSON.stringify(s)]);
    } else {
      notifyDiscord(`🗓️ **${s.createdBy}** propose un créneau pour « ${arc.name} » : **${ddmm(s.day)} · ${SLOT_LABEL[s.slot]}** — répondez dans La Guilde !`);
    }
  } catch (e) { console.error('Notif de créneau impossible :', e.message); }
}
async function updateSlotDiscord(s, arc) {
  if (!botReady || !s.msgId || !s.msgChannelId) return;
  try {
    const ch = await bot.channels.fetch(s.msgChannelId);
    const msg = await ch.messages.fetch(s.msgId);
    await msg.edit({ content: slotText(s, arc) });
  } catch (e) { /* message supprimé côté Discord : pas grave */ }
}
async function cancelSlotDiscord(s, arc, by) {
  if (!botReady || !s.msgId || !s.msgChannelId) {
    notifyDiscord(`🗑️ Le créneau du ${ddmm(s.day)} (${SLOT_LABEL[s.slot]}) pour « ${arc.name} » est annulé par ${by}.`);
    return;
  }
  try {
    const ch = await bot.channels.fetch(s.msgChannelId);
    const msg = await ch.messages.fetch(s.msgId);
    await msg.edit({ content: `~~Créneau du ${ddmm(s.day)} · ${SLOT_LABEL[s.slot]} pour « ${arc.name} »~~\n🗑️ **Annulé par ${by}.**`, components: [] });
  } catch (e) { console.error(e); }
}
async function onDiscordInteraction(interaction) {
  try {
    if (!interaction.isButton()) return;
    const [tag, slotId, ans] = (interaction.customId || '').split(':');
    if (tag !== 'slot' || !['yes', 'no'].includes(ans)) return;
    const profiles = await getProfiles();
    const member = Object.keys(profiles).find(m => profiles[m]?.discordId === interaction.user.id);
    if (!member) {
      await interaction.reply({ content: 'Je ne sais pas qui tu es 😅 — colle ton ID Discord dans La Guilde (Mon espace → Profil & avatar), puis reclique.', ephemeral: true });
      return;
    }
    const out = await applySlotResponse(slotId, member, ans);
    if (out.error === 'not_member') { await interaction.reply({ content: 'Tu ne fais pas partie de cette campagne !', ephemeral: true }); return; }
    if (out.error) { await interaction.reply({ content: 'Ce créneau n\u2019existe plus.', ephemeral: true }); return; }
    await interaction.deferUpdate(); // le message est mis à jour par applySlotResponse
  } catch (e) { console.error('Interaction Discord :', e.message); }
}

/* ---------- Petites protections sur les entrées ---------- */
const isStr = (v, max = 300) => typeof v === 'string' && v.length <= max;
const clampScore = v => Math.max(0, Math.min(10, Math.round(Number(v))));

/* ---------- Tranches horaires des dispos ---------- */
const DAY_SLOTS = ['matin', 'aprem', '18-20', '20-22', '22-00', '00-02'];
const SLOT_LABEL = { matin: 'Matin', aprem: 'Aprem', '18-20': '18h-20h', '20-22': '20h-22h', '22-00': '22h-00h', '00-02': '00h-02h' };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
function mondayISO() {
  const d = new Date();
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return d.toISOString().slice(0, 10);
}
async function getProfiles() { return (await pool.query(`SELECT value FROM meta WHERE key='profiles'`)).rows[0]?.value ?? {}; }
async function getArc(id) { const r = await pool.query(`SELECT data FROM arcs WHERE id=$1`, [id]); return r.rows[0]?.data || null; }
async function saveArcData(arc) { await pool.query(`UPDATE arcs SET data=$2 WHERE id=$1`, [arc.id, JSON.stringify(arc)]); }

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

/* Tout l'état d'un coup : joueurs, jeux, aventures, profils */
app.get('/api/state', async (req, res) => {
  maybeMonthlyReport(); // vérifie si le bilan du mois doit partir (sans bloquer la réponse)
  try {
    const members = (await pool.query(`SELECT value FROM meta WHERE key='members'`)).rows[0]?.value ?? DEFAULT_MEMBERS;
    const profiles = (await pool.query(`SELECT value FROM meta WHERE key='profiles'`)).rows[0]?.value ?? {};
    const games = (await pool.query(`SELECT data FROM games`)).rows.map(r => r.data);
    const arcs = (await pool.query(`SELECT data FROM arcs`)).rows.map(r => r.data);
    const monday = mondayISO();
    pool.query(`DELETE FROM avail WHERE day < $1`, [monday]).catch(() => {}); // ménage du passé
    const avail = (await pool.query(`SELECT member, day, slot, state, arc_id FROM avail WHERE day >= $1`, [monday])).rows;
    const slots = (await pool.query(`SELECT data FROM slots`)).rows.map(r => r.data).filter(s => s.day >= monday);
    res.json({ members, profiles, games, arcs, avail, slots });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Ajouter un nouveau joueur à la guilde : { name } */
app.post('/api/members', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!isStr(name, 30) || !name) return res.status(400).json({ error: 'invalid' });
    const row = (await pool.query(`SELECT value FROM meta WHERE key='members'`)).rows[0];
    const members = row?.value ?? DEFAULT_MEMBERS;
    if (members.some(m => m.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'exists' });
    }
    members.push(name);
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ('members', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [JSON.stringify(members)]
    );
    notifyDiscord(`👋 **${name}** rejoint La Guilde ! Souhaitez-lui la bienvenue !`);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Mettre à jour son profil : statut de dispo, avatar, couleur et/ou punchline
   { member, status, avatar, color, tagline } */
const TAGLINES = ['Rage quit imminent', 'AFK professionnel', '300h de jeu, toujours nul', '« Une dernière et j\u2019arrête »', 'Delu et le sait'];
app.post('/api/profile', async (req, res) => {
  try {
    const { member, status, avatar, color, tagline } = req.body || {};
    if (!isStr(member, 40) || !member) return res.status(400).json({ error: 'invalid' });
    const row = (await pool.query(`SELECT value FROM meta WHERE key='profiles'`)).rows[0];
    const profiles = row?.value ?? {};
    const p = profiles[member] || {};
    if (status === null) delete p.status;
    else if (['green', 'orange', 'red'].includes(status)) p.status = status;
    if (avatar === null) delete p.avatar;
    else if (avatar && typeof avatar === 'object' && ['emoji', 'url'].includes(avatar.type) && isStr(avatar.value, 400) && avatar.value) {
      p.avatar = { type: avatar.type, value: avatar.value };
    }
    if (color === null) delete p.color;
    else if (isStr(color, 9) && /^#[0-9a-fA-F]{6}$/.test(color)) p.color = color;
    if (tagline === null) delete p.tagline;
    else if (TAGLINES.includes(tagline)) p.tagline = tagline;
    if (req.body.discordId === null) delete p.discordId;
    else if (isStr(req.body.discordId, 25) && /^\d{15,21}$/.test(req.body.discordId)) p.discordId = req.body.discordId;
    if (typeof req.body.lockPref === 'boolean') p.lockPref = req.body.lockPref;
    profiles[member] = p;
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ('profiles', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [JSON.stringify(profiles)]
    );
    broadcast();
    res.json({ ok: true });
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
      img: (isStr(b.img, 500) && /^https:\/\//.test(b.img)) ? b.img : '',
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
    const linkTxt = game.link ? `\n👉 ${game.link}` : '';
    notifyDiscord(`🎮 **${proposer}** propose **${game.name}** (${priceTxt}${genresTxt})${envy != null ? ` — envie : ${envy}/10` : ''}${linkTxt}`);
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
    if (b.img !== undefined) game.img = (isStr(b.img, 500) && /^https:\/\//.test(b.img)) ? b.img : '';
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
      const linkTxt = game.link ? `\nAllez jeter un œil 👉 ${game.link}` : '';
      notifyDiscord(`🏷️ **${game.promo.by || 'Quelqu\u2019un'}** a trouvé une bonne affaire ! **${game.name}** ${deal}${until} sur ${game.promo.platform}${linkTxt}`);
      logPromo(game.promo.by);
    }
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Disponibilités de la semaine ---------- */
app.post('/api/avail', async (req, res) => {
  try {
    const { member, day, slot, on } = req.body || {};
    if (!isStr(member, 40) || !member || !isDay(day) || !DAY_SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid' });
    if (on) {
      await pool.query(
        `INSERT INTO avail (member, day, slot, state) VALUES ($1,$2,$3,'free')
         ON CONFLICT (member, day, slot) DO UPDATE SET state='free', arc_id=NULL WHERE avail.state <> 'locked'`,
        [member, day, slot]);
    } else {
      await pool.query(`DELETE FROM avail WHERE member=$1 AND day=$2 AND slot=$3 AND state <> 'locked'`, [member, day, slot]);
    }
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Créneaux de campagne ---------- */
/* Verrouille/libère la case du calendrier du joueur (si son option 🔒 est activée) */
async function lockAvail(member, s, arcId, yes) {
  try {
    const profiles = await getProfiles();
    if (!profiles[member]?.lockPref) return;
    if (yes) {
      await pool.query(
        `INSERT INTO avail (member, day, slot, state, arc_id) VALUES ($1,$2,$3,'locked',$4)
         ON CONFLICT (member, day, slot) DO UPDATE SET state='locked', arc_id=$4`,
        [member, s.day, s.slot, arcId]);
    } else {
      await pool.query(
        `UPDATE avail SET state='free', arc_id=NULL WHERE member=$1 AND day=$2 AND slot=$3 AND state='locked' AND arc_id=$4`,
        [member, s.day, s.slot, arcId]);
    }
  } catch (e) { console.error(e); }
}

app.post('/api/slots', async (req, res) => {
  try {
    const { arcId, day, slot, member } = req.body || {};
    if (!isStr(member, 40) || !isStr(arcId, 60) || !isDay(day) || !DAY_SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid' });
    const arc = await getArc(arcId);
    if (!arc || arc.status !== 'en cours') return res.status(404).json({ error: 'not_found' });
    if (!(arc.participants || []).includes(member)) return res.json({ ok: false, reason: 'not_member' });
    const today = new Date().toISOString().slice(0, 10);
    const existing = (await pool.query(`SELECT data FROM slots`)).rows.map(r => r.data).filter(s => s.arcId === arcId && s.day >= today);
    if (existing.some(s => s.day === day && s.slot === slot)) return res.json({ ok: false, reason: 'dup' });
    if (existing.length >= 3) return res.json({ ok: false, reason: 'max' });
    const s = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      arcId, arcName: arc.name, day, slot,
      createdBy: member, createdAt: new Date().toISOString(),
      responses: { [member]: 'yes' } // le proposeur est partant d'office
    };
    await pool.query(`INSERT INTO slots (id, data) VALUES ($1,$2)`, [s.id, JSON.stringify(s)]);
    await lockAvail(member, s, arcId, true);
    postSlotDiscord(s, arc);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Réponse à un créneau — partagée entre l'appli et les boutons Discord */
async function applySlotResponse(slotId, member, answer) {
  const r = await pool.query(`SELECT data FROM slots WHERE id=$1`, [slotId]);
  if (!r.rows.length) return { error: 'not_found' };
  const s = r.rows[0].data;
  const arc = await getArc(s.arcId);
  if (!arc || !(arc.participants || []).includes(member)) return { error: 'not_member' };
  s.responses = s.responses || {};
  s.responses[member] = answer;
  await pool.query(`UPDATE slots SET data=$2 WHERE id=$1`, [slotId, JSON.stringify(s)]);
  await lockAvail(member, s, s.arcId, answer === 'yes');
  updateSlotDiscord(s, arc);
  broadcast();
  return { slot: s, arc };
}

app.post('/api/slots/:id/respond', async (req, res) => {
  try {
    const { member, answer } = req.body || {};
    if (!isStr(member, 40) || !['yes', 'no'].includes(answer)) return res.status(400).json({ error: 'invalid' });
    const out = await applySlotResponse(req.params.id, member, answer);
    if (out.error) return res.json({ ok: false, reason: out.error });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.delete('/api/slots/:id', async (req, res) => {
  try {
    const member = String(req.query.member || '');
    const r = await pool.query(`SELECT data FROM slots WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const s = r.rows[0].data;
    const arc = await getArc(s.arcId);
    if (!arc || !(arc.participants || []).includes(member)) return res.json({ ok: false, reason: 'not_member' });
    await pool.query(`DELETE FROM slots WHERE id=$1`, [req.params.id]);
    await pool.query(`UPDATE avail SET state='free', arc_id=NULL WHERE day=$1 AND slot=$2 AND state='locked' AND arc_id=$3`, [s.day, s.slot, s.arcId]);
    cancelSlotDiscord(s, arc, member);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Demandes d'adhésion aux campagnes complètes ---------- */
app.post('/api/arcs/:id/request', async (req, res) => {
  try {
    const { member } = req.body || {};
    if (!isStr(member, 40) || !member) return res.status(400).json({ error: 'invalid' });
    const arc = await getArc(req.params.id);
    if (!arc || arc.status !== 'en cours') return res.status(404).json({ error: 'not_found' });
    if ((arc.participants || []).includes(member)) return res.json({ ok: false, reason: 'already' });
    arc.requests = arc.requests || {};
    if (arc.requests[member]) return res.json({ ok: false, reason: 'pending' });
    arc.requests[member] = { at: new Date().toISOString(), refusals: [] };
    await saveArcData(arc);
    notifyDiscord(`🙋 **${member}** demande à rejoindre « ${arc.name} » sur **${arc.gameName}** — membres, un seul « Accepter » suffit, votez dans La Guilde !`);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.post('/api/arcs/:id/request/cancel', async (req, res) => {
  try {
    const { member } = req.body || {};
    const arc = await getArc(req.params.id);
    if (!arc || !arc.requests || !arc.requests[member]) return res.json({ ok: true });
    delete arc.requests[member];
    await saveArcData(arc);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Un seul « Accepter » = adhésion immédiate ; refus définitif si TOUS refusent */
app.post('/api/arcs/:id/request/decide', async (req, res) => {
  try {
    const { applicant, by, accept } = req.body || {};
    if (!isStr(applicant, 40) || !isStr(by, 40)) return res.status(400).json({ error: 'invalid' });
    const arc = await getArc(req.params.id);
    if (!arc || !arc.requests || !arc.requests[applicant]) return res.json({ ok: false, reason: 'gone' });
    if (!(arc.participants || []).includes(by)) return res.json({ ok: false, reason: 'not_member' });
    if (accept) {
      arc.participants.push(applicant);
      if (arc.slots) arc.slots = arc.participants.length; // l'équipe s'agrandit
      delete arc.requests[applicant];
      await saveArcData(arc);
      notifyDiscord(`🎉 **${applicant}** rejoint la campagne « ${arc.name} » — l'équipe passe à ${arc.participants.length} joueurs !`);
      await maybeCreateChannel(arc.id);
      await addMemberToChannel(await getArc(arc.id), applicant);
    } else {
      const rq = arc.requests[applicant];
      if (!rq.refusals.includes(by)) rq.refusals.push(by);
      if (rq.refusals.length >= (arc.participants || []).length) {
        delete arc.requests[applicant];
        await saveArcData(arc);
        notifyDiscord(`La demande de **${applicant}** pour « ${arc.name} » n\u2019a pas été retenue.`);
      } else {
        await saveArcData(arc);
      }
    }
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Enregistrer des notes et/ou la possession :
   { member, updates: { idDuJeu: 8, ... }, owned: { idDuJeu: true/false, ... } }
   On ne réécrit QUE les infos du joueur concerné : deux amis peuvent noter
   en même temps sans s'écraser mutuellement. */
app.post('/api/ratings', async (req, res) => {
  try {
    const { member, updates, owned } = req.body || {};
    const hasUpd = updates && typeof updates === 'object' && Object.keys(updates).length;
    const hasOwn = owned && typeof owned === 'object' && Object.keys(owned).length;
    if (!isStr(member, 40) || (!hasUpd && !hasOwn)) return res.status(400).json({ error: 'invalid' });
    for (const [gameId, score] of Object.entries(updates || {})) {
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
    // Possession : "je l'ai / je l'ai pas", propre à chaque joueur
    for (const [gameId, val] of Object.entries(owned || {})) {
      await pool.query(
        `UPDATE games SET data = jsonb_set(jsonb_set(data, '{owned}', COALESCE(data->'owned', '{}'::jsonb)), ARRAY['owned', $2::text], to_jsonb($3::boolean)) WHERE id=$1`,
        [gameId, member, !!val]
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
    const kind = b.kind === 'session' ? 'session' : 'campagne';
    const arc = {
      id: b.id, kind, name: b.name.trim(),
      gameId: '', gameName: '?',
      participants: Array.isArray(b.participants) ? b.participants.filter(p => isStr(p, 40)) : [],
      startDate: isStr(b.startDate, 20) ? b.startDate : new Date().toISOString().slice(0, 10),
      createdBy: isStr(b.createdBy, 40) ? b.createdBy : '?',
      createdAt: new Date().toISOString(),
      status: 'en cours'
    };
    if (!arc.participants.length) arc.participants = [arc.createdBy];
    if (isStr(b.time, 10) && b.time) arc.time = b.time;
    const s = parseInt(b.slots);
    if (kind === 'session') {
      // Session jeux = soirée multigaming ouverte, 7 places par défaut
      arc.multi = true;
      arc.gameName = 'Multigaming';
      arc.slots = (!isNaN(s) && s >= 2 && s <= 20) ? s : 7;
    } else {
      arc.gameId = isStr(b.gameId, 60) ? b.gameId : '';
      arc.gameName = isStr(b.gameName, 120) ? b.gameName : '?';
      if (isStr(b.goal, 200) && b.goal.trim()) arc.goal = b.goal.trim();
      if (!isNaN(s) && s >= 2 && s <= 20) arc.slots = s;
      // Limite : 4 campagnes en cours max par joueur (les sessions ne comptent pas)
      const all = (await pool.query(`SELECT data FROM arcs`)).rows.map(r => r.data);
      const isCamp = a => a.status === 'en cours' && !(a.kind === 'session' || a.multi === true);
      const active = all.filter(a => isCamp(a) && (a.participants || []).includes(arc.createdBy)).length;
      if (active >= 4) return res.json({ ok: false, reason: 'limit' });
    }
    await pool.query(`INSERT INTO arcs (id, data) VALUES ($1, $2)`, [arc.id, JSON.stringify(arc)]);

    const others = arc.participants.filter(p => p !== arc.createdBy);
    const when = `${ddmm(arc.startDate)}${arc.time ? ' à ' + arc.time.replace(':', 'h') : ''}`;
    const goalLine = arc.goal ? `\n🎯 Objectif : ${arc.goal}` : '';
    const open = arc.slots && arc.participants.length < arc.slots;
    if (kind === 'session') {
      const left = arc.slots - arc.participants.length;
      notifyDiscord([
        '🎉 ═══════════════════ 🎉',
        `# 🎮 SOIRÉE JEUX le ${when} !`,
        `🚀 **${arc.createdBy}** lance « **${arc.name}** » — multigaming au programme !`,
        `👥 Déjà chauds : ${joinFr(arc.participants)}`,
        open ? `🔥 **Il reste ${left} place${left > 1 ? 's' : ''} sur ${arc.slots}** — rejoignez l'appel depuis l'onglet « Aventures » !` : `👥 Équipe au complet (${arc.participants.length}/${arc.slots}) !`,
        '⏰ Et pas de retard, bande de coquins !',
        '🎉 ═══════════════════ 🎉'
      ].join('\n'));
    } else if (open) {
      const left = arc.slots - arc.participants.length;
      notifyDiscord([
        '📣 ═══════════════════ 📣',
        '# ⚔️ APPEL À LA CAMPAGNE ! ⚔️',
        `🚀 **${arc.createdBy}** recrute pour « **${arc.name}** » sur **${arc.gameName}** !`,
        `🗓️ Début souhaité : le ${when}`,
        `👥 Déjà chauds : ${joinFr(arc.participants)}`,
        `🔥 **Il reste ${left} place${left > 1 ? 's' : ''} sur ${arc.slots}** — premiers arrivés, premiers servis !${goalLine}`,
        '👉 Rejoignez l\u2019aventure depuis l\u2019onglet « Aventures » de La Guilde',
        '📣 ═══════════════════ 📣'
      ].join('\n'));
    } else {
      notifyDiscord(`🚀 **${arc.createdBy}** lance la campagne « ${arc.name} » sur **${arc.gameName}** ${others.length ? 'avec ' + joinFr(others) : 'en solo'} ! Bonne chance les nazes !${goalLine}`);
    }
    maybeCreateChannel(arc.id);
    broadcast();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Rejoindre une aventure ouverte : { member }
   Mise à jour ATOMIQUE : la base ajoute le participant en une seule opération,
   donc deux joueurs qui cliquent en même temps ne peuvent plus s'écraser
   mutuellement (et on ne peut pas dépasser le nombre de places). */
app.post('/api/arcs/:id/join', async (req, res) => {
  try {
    const { member } = req.body || {};
    if (!isStr(member, 40) || !member) return res.status(400).json({ error: 'invalid' });
    // Limite de 4 campagnes actives : on vérifie AVANT d'ajouter (sessions exemptées)
    const pre = await pool.query(`SELECT data FROM arcs WHERE id=$1`, [req.params.id]);
    if (!pre.rows.length) return res.status(404).json({ error: 'not_found' });
    const target = pre.rows[0].data;
    const isCamp = a => a.status === 'en cours' && !(a.kind === 'session' || a.multi === true);
    if (isCamp(target)) {
      const all = (await pool.query(`SELECT data FROM arcs`)).rows.map(r => r.data);
      const active = all.filter(a => isCamp(a) && (a.participants || []).includes(member)).length;
      if (active >= 4) return res.json({ ok: false, reason: 'limit' });
    }
    const upd = await pool.query(
      `UPDATE arcs
       SET data = jsonb_set(data, '{participants}', (data->'participants') || to_jsonb($2::text))
       WHERE id = $1
         AND data->>'status' = 'en cours'
         AND NOT (data->'participants' ? $2::text)
         AND jsonb_array_length(data->'participants') < COALESCE((data->>'slots')::int, 999999)
       RETURNING data`,
      [req.params.id, member]
    );
    if (upd.rows.length) {
      const arc = upd.rows[0].data;
      const n = (arc.participants || []).length;
      if (arc.slots && n >= arc.slots) {
        notifyDiscord(`🎉 **${member}** rejoint « ${arc.name} » — l'équipe est AU COMPLET (${n}/${arc.slots}) ! GO GO GO !`);
      } else {
        notifyDiscord(`➕ **${member}** rejoint l'aventure « ${arc.name} » sur **${arc.gameName}**${arc.slots ? ` (${n}/${arc.slots})` : ''}`);
      }
      maybeCreateChannel(req.params.id);
      broadcast();
      return res.json({ ok: true });
    }
    // Rien mis à jour : on explique pourquoi
    const { rows } = await pool.query(`SELECT data FROM arcs WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const arc = rows[0].data;
    if ((arc.participants || []).includes(member)) return res.json({ ok: false, reason: 'already' });
    if (arc.status !== 'en cours') return res.json({ ok: false, reason: 'closed' });
    return res.json({ ok: false, reason: 'full' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Se retirer d'une aventure : { member }
   Autorisé uniquement tant qu'elle n'a pas commencé (date de début future).
   Même principe atomique que le join : pas de risque d'écrasement. */
app.post('/api/arcs/:id/leave', async (req, res) => {
  try {
    const { member } = req.body || {};
    if (!isStr(member, 40) || !member) return res.status(400).json({ error: 'invalid' });
    const today = new Date().toISOString().slice(0, 10);
    const upd = await pool.query(
      `UPDATE arcs
       SET data = jsonb_set(data, '{participants}', (data->'participants') - $2::text)
       WHERE id = $1
         AND data->>'status' = 'en cours'
         AND data->'participants' ? $2::text
         AND data->>'startDate' > $3
       RETURNING data`,
      [req.params.id, member, today]
    );
    if (upd.rows.length) {
      const arc = upd.rows[0].data;
      const n = (arc.participants || []).length;
      notifyDiscord(`➖ **${member}** se retire de « ${arc.name} »${arc.slots ? ` (${n}/${arc.slots} — une place se libère !)` : ''}`);
      broadcast();
      return res.json({ ok: true });
    }
    // Rien mis à jour : on explique pourquoi
    const { rows } = await pool.query(`SELECT data FROM arcs WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const arc = rows[0].data;
    if (!(arc.participants || []).includes(member)) return res.json({ ok: false, reason: 'not_in' });
    if (arc.status !== 'en cours') return res.json({ ok: false, reason: 'closed' });
    return res.json({ ok: false, reason: 'started' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* Marquer l'objectif d'une aventure comme atteint (ou le rouvrir) : { done } */
app.post('/api/arcs/:id/goal', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT data FROM arcs WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const arc = rows[0].data;
    const done = !!(req.body && req.body.done);
    const wasDone = !!arc.goalDone;
    arc.goalDone = done;
    await pool.query(`UPDATE arcs SET data=$2 WHERE id=$1`, [req.params.id, JSON.stringify(arc)]);
    if (done && !wasDone && arc.goal) {
      notifyDiscord(`🏆 Objectif ATTEINT pour « ${arc.name} » sur **${arc.gameName}** : « ${arc.goal} » — GG à ${joinFr(arc.participants || [])} !`);
    }
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

/* ---------- Proxy Steam ----------
   Le navigateur ne peut pas interroger Steam directement (blocage CORS) :
   le serveur fait l'intermédiaire, avec un cache en mémoire pour ne pas
   marteler Steam (recherche : 10 min, fiche d'un jeu : 1 h). */
const steamCache = new Map();
async function steamFetch(url, ttlMs) {
  const hit = steamCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept-Language': 'fr' } });
    if (!r.ok) throw new Error('steam ' + r.status);
    const v = await r.json();
    steamCache.set(url, { t: Date.now(), v });
    if (steamCache.size > 500) steamCache.delete(steamCache.keys().next().value); // on limite la taille
    return v;
  } finally { clearTimeout(timer); }
}

/* Recherche dans le catalogue Steam (prix France) */
app.get('/api/steam/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 3) return res.json({ items: [] });
  try {
    const data = await steamFetch(
      'https://store.steampowered.com/api/storesearch/?cc=fr&l=french&term=' + encodeURIComponent(q),
      10 * 60 * 1000
    );
    const items = (data.items || []).slice(0, 8).map(i => ({
      id: i.id,
      name: i.name,
      price: i.price ? Math.round(i.price.final) / 100 : 0, // Steam donne des centimes
      img: i.tiny_image || ''
    }));
    res.json({ items });
  } catch (e) { res.status(502).json({ error: 'steam' }); }
});

/* Fiche résumée d'un jeu Steam (pour l'aperçu au survol) */
app.get('/api/steam/app/:id', async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, '').slice(0, 10);
  if (!id) return res.status(400).json({ error: 'invalid' });
  try {
    const data = await steamFetch(
      'https://store.steampowered.com/api/appdetails?appids=' + id + '&cc=fr&l=french',
      60 * 60 * 1000
    );
    const d = data && data[id];
    if (!d || !d.success) return res.status(404).json({ error: 'not_found' });
    const g = d.data;
    res.json({
      name: g.name || '',
      img: g.header_image || '',
      desc: g.short_description || '',
      genres: (g.genres || []).map(x => x.description).slice(0, 4),
      price: g.is_free ? 'Gratuit' : (g.price_overview ? g.price_overview.final_formatted : ''),
      release: g.release_date?.date || ''
    });
  } catch (e) { res.status(502).json({ error: 'steam' }); }
});

/* Aperçu d'une page de boutique HORS Steam (Epic, GOG, Instant Gaming…)
   Stratégie : pour Epic, on interroge leur API de contenu (bien plus fiable
   que la page web, qui bloque les robots) ; pour le reste, on lit les
   balises Open Graph de la page. Liste blanche de domaines : le serveur
   ne peut pas être détourné pour visiter autre chose. */
const PREVIEW_HOSTS = ['store.epicgames.com', 'www.gog.com', 'gog.com', 'www.instant-gaming.com', 'instant-gaming.com'];
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9'
};
async function fetchText(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: BROWSER_HEADERS });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
function ogTag(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']og:${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:${prop}["']`, 'i'));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, '\u2019').replace(/&quot;/g, '"') : '';
}
/* Epic : API de contenu, à partir du slug de l'URL (…/p/le-slug) */
async function epicPreview(u) {
  const m = u.pathname.match(/\/p\/([^\/?#]+)/);
  if (!m) return null;
  const slug = m[1];
  for (const loc of ['fr', 'en-US']) {
    try {
      const txt = await fetchText(`https://store-content.ak.epicgames.com/api/${loc}/content/products/${slug}`);
      const json = JSON.parse(txt);
      const name = json.productName || json._title || slug.replace(/-/g, ' ');
      // On récupère toutes les images du JSON, en privilégiant les bannières
      // LARGES et en évitant les affiches verticales (Tall/Portrait)
      const urls = [...txt.matchAll(/https:\/\/[^"\s\\]+?\.(?:jpe?g|png|webp)[^"\s\\]*/g)].map(x => x[0]);
      const img = urls.find(x => /OfferImageWide|StoreFrontWide|wide|landscape/i.test(x))
        || urls.find(x => /1920|2560|hero/i.test(x) && !/tall|portrait|logo/i.test(x))
        || urls.find(x => !/tall|portrait|logo/i.test(x))
        || urls[0] || '';
      const dm = txt.match(/"(?:description|shortDescription)"\s*:\s*"([^"]{20,300})"/);
      return { img, name, desc: dm ? dm[1] : '' };
    } catch (e) { /* on tente la locale suivante */ }
  }
  return null;
}
app.get('/api/preview', async (req, res) => {
  try {
    const u = new URL(String(req.query.url || ''));
    if (u.protocol !== 'https:' || !PREVIEW_HOSTS.includes(u.hostname)) return res.status(400).json({ error: 'host' });
    const key = 'og:' + u.href;
    const hit = steamCache.get(key);
    if (hit && Date.now() - hit.t < 6 * 60 * 60 * 1000) return res.json(hit.v);
    let v = null;
    if (u.hostname === 'store.epicgames.com') v = await epicPreview(u);
    if (!v || !v.img) {
      try {
        const html = (await fetchText(u.href)).slice(0, 400000);
        const og = { img: ogTag(html, 'image'), name: ogTag(html, 'title'), desc: ogTag(html, 'description') };
        v = (v && v.name) ? { ...og, ...v, img: v.img || og.img } : og;
      } catch (e) { if (!v) throw e; }
    }
    if (!v || (!v.img && !v.name)) throw new Error('aucune donnée exploitable');
    steamCache.set(key, { t: Date.now(), v });
    res.json(v);
  } catch (e) {
    console.error('Aperçu boutique KO :', req.query.url, '→', e.message);
    res.status(502).json({ error: 'preview', detail: e.message });
  }
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
