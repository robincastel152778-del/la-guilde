// economy.js — Économie « Guildpoints » + boutique journalière + gains, pour La Guilde
// Module autonome : sa propre table SQL, lit catalogue.json.
//
// Intégration dans server.js :
//     const economy = require('./economy');
//     const eco = economy(pool, broadcast);      // 'broadcast' = ta fonction SSE (optionnelle)
//     app.use('/api/economy', eco);
//
// Puis, pour créditer les gains, appelle depuis TES routes existantes :
//     await eco.onProposeGame(proposeur, gameId);
//     await eco.onRating(proposeur, gameId, votant, note);   // à la 1re note du votant
//     await eco.onPromo(membre, promoId);
//     await eco.onDispos(membre, cleSemaine);                // ex: "2026-W30"
//     await eco.onCampaignSuccess(arcId, "facile|normale|difficile", [participants]);
//
// catalogue.json doit être à la racine du repo (à côté de server.js).

const fs = require('fs');
const path = require('path');
const express = require('express');

const START_BALANCE = 2000;
const REROLL_COST    = 400;
const RARITY_ORDER = ['commun', 'rare', 'epique', 'mythique', 'legendaire'];

// Montants des gains
const GAIN = {
  propose: 100,
  rate7: 25,      // note >= 7 (et < 10)
  rate10: 75,     // note == 10
  promo: 100,
  dispos: 300,
  campaign: { facile: 350, normale: 700, difficile: 1500 },
};

// --- normalisation catalogue -------------------------------------------------
function stripAccents(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
function normRarity(r){
  const s = stripAccents(r);
  if (s.startsWith('comm')) return 'commun';
  if (s.startsWith('rare')) return 'rare';
  if (s.startsWith('epiq') || s.startsWith('epic')) return 'epique';
  if (s.startsWith('myth')) return 'mythique';
  if (s.startsWith('leg'))  return 'legendaire';
  return 'commun';
}
function loadCatalogue(){
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname,'catalogue.json'),'utf8'));
  const items = [];
  for (const cat of Object.keys(raw))
    for (const it of raw[cat])
      items.push({ key: cat+':'+it.id, cat, id: it.id, nom: it.nom||it.texte||it.id,
                   fichier: it.fichier||null, rarity: normRarity(it.rarete), price: Number(it.prix)||0 });
  return items;
}
let ITEMS = [];
try { ITEMS = loadCatalogue(); } catch(e){ console.error('[economy] catalogue.json:', e.message); }
const ITEM_BY_KEY = new Map(ITEMS.map(i => [i.key, i]));

// --- génération du shop ------------------------------------------------------
function sample(arr, n, used){
  const pool = arr.filter(i => !used.has(i.key));
  for (let i = pool.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [pool[i],pool[j]]=[pool[j],pool[i]]; }
  const out = pool.slice(0, n); out.forEach(i => used.add(i.key)); return out;
}
function weightedHiRarity(){
  const r = Math.random();
  if (r < 0.5)   return 'epique';       // 50 %
  if (r < 0.875) return 'mythique';     // 37.5 %
  return 'legendaire';                  // 12.5 %
}
function genShop(ownedSet){
  const avail = ITEMS.filter(i => !ownedSet.has(i.key) && i.price > 0);
  const byR = { commun:[], rare:[], epique:[], mythique:[], legendaire:[] };
  avail.forEach(i => byR[i.rarity].push(i));
  const used = new Set(); const slots = [];
  const fill = (arr, n) => {
    let pick = sample(arr, n, used);
    if (pick.length < n) pick = pick.concat(sample(avail.filter(i => !used.has(i.key)), n - pick.length, used));
    pick.forEach(i => slots.push(i.key));
  };
  fill(byR.commun, 5);
  fill(byR.rare, 3);
  fill(byR.epique, 2);
  // 1 slot « épique ou plus » pondéré (50 / 37.5 / 12.5)
  const rar = weightedHiRarity();
  let one = sample(byR[rar], 1, used);
  if (!one.length) one = sample([...byR.epique, ...byR.mythique, ...byR.legendaire], 1, used);
  if (!one.length) one = sample(avail, 1, used);
  one.forEach(i => slots.push(i.key));
  return slots;
}
function todayStr(){ return new Date().toISOString().slice(0,10); }

// --- module ------------------------------------------------------------------
module.exports = function (pool, broadcast) {
  const router = express.Router();
  const notify = typeof broadcast === 'function' ? broadcast : () => {};
  let ready = null;
  async function ensure(){ if (!ready) ready = pool.query('CREATE TABLE IF NOT EXISTS economy_kv (k text PRIMARY KEY, v jsonb NOT NULL)'); return ready; }

  async function getRec(me){
    await ensure();
    const { rows } = await pool.query('SELECT v FROM economy_kv WHERE k=$1', ['m:'+me]);
    return rows[0] ? rows[0].v : { balance: START_BALANCE, purchases: [], equipped: {}, shop: null };
  }
  async function saveRec(me, rec){
    await pool.query('INSERT INTO economy_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', ['m:'+me, rec]);
  }
  async function getCredited(){ await ensure(); const { rows } = await pool.query('SELECT v FROM economy_kv WHERE k=$1', ['_credited']); return rows[0] ? rows[0].v : {}; }
  async function saveCredited(c){ await pool.query('INSERT INTO economy_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', ['_credited', c]); }
  async function creditMember(me, amount, reason){
    const rec = await getRec(me);
    rec.balance = (rec.balance||0) + amount;
    rec.ledger = [...(rec.ledger||[]), { amount, reason: reason||'', at: Date.now() }].slice(-200);
    await saveRec(me, rec);
  }
  async function creditOnce(key, me, amount, reason){
    const c = await getCredited();
    if (c[key]) return false;
    c[key] = true; await saveCredited(c);
    if (amount > 0) await creditMember(me, amount, reason);
    return true;
  }

  async function stateFor(me){
    const rec = await getRec(me);
    const owned = new Set(rec.purchases || []);
    // Régénère si le shop date d'hier OU s'il est vide (ex. catalogue corrigé entre-temps)
    const empty = !rec.shop || !Array.isArray(rec.shop.slots) ||
                  rec.shop.slots.filter(k => ITEM_BY_KEY.has(k)).length === 0;
    if (!rec.shop || rec.shop.date !== todayStr() || empty){
      rec.shop = { date: todayStr(), slots: genShop(owned), revealed: false, rerolled: (rec.shop && rec.shop.date === todayStr()) ? !!rec.shop.rerolled : false };
      await saveRec(me, rec);
    }
    const slots = rec.shop.slots.map(k => ITEM_BY_KEY.get(k)).filter(Boolean).map(it => ({
      key: it.key, cat: it.cat, id: it.id, nom: it.nom, rarity: it.rarity,
      price: it.price, fichier: it.fichier, owned: owned.has(it.key),
    }));
    return { me, balance: rec.balance, purchases: rec.purchases||[], equipped: rec.equipped||{},
             shop: { date: rec.shop.date, rerolled: !!rec.shop.rerolled, revealed: !!rec.shop.revealed,
                     cost: REROLL_COST, slots } };
  }
  function getMe(req){ const me = (req.body && req.body.me) || req.query.me; return (typeof me==='string' && me.trim()) ? me.trim() : null; }

  router.get('/catalogue', (req, res) => res.json({
    items: ITEMS, rarityOrder: RARITY_ORDER,
    rarityColors: { commun:'#4ADE80', rare:'#5EC8F2', epique:'#B78CFF', mythique:'#FF6B81', legendaire:'#FFC857' },
  }));

  router.post('/state', async (req, res) => {
    const me = getMe(req); if (!me) return res.status(400).json({ error:'me manquant' });
    try { res.json(await stateFor(me)); } catch(e){ console.error('[economy] state', e); res.status(500).json({ error:'db' }); }
  });

  router.post('/buy', async (req, res) => {
    const me = getMe(req); const key = req.body && req.body.key;
    if (!me || !key) return res.status(400).json({ error:'params' });
    try {
      const rec = await getRec(me);
      if (!rec.shop || rec.shop.date !== todayStr() || !rec.shop.slots.includes(key)) return res.status(400).json({ error:'pas en vente aujourd\'hui' });
      if ((rec.purchases||[]).includes(key)) return res.status(400).json({ error:'déjà possédé' });
      const it = ITEM_BY_KEY.get(key); if (!it) return res.status(400).json({ error:'inconnu' });
      if (rec.balance < it.price) return res.status(400).json({ error:'solde insuffisant' });
      rec.balance -= it.price; rec.purchases = [...(rec.purchases||[]), key];
      await saveRec(me, rec); notify(); res.json(await stateFor(me));
    } catch(e){ console.error('[economy] buy', e); res.status(500).json({ error:'db' }); }
  });

  router.post('/equip', async (req, res) => {
    const me = getMe(req); const { cat, id } = req.body || {};
    if (!me || !cat) return res.status(400).json({ error:'params' });
    try {
      const rec = await getRec(me); rec.equipped = rec.equipped || {};
      if (id === null || id === undefined || id === '') delete rec.equipped[cat];
      else { if (!(rec.purchases||[]).includes(cat+':'+id)) return res.status(400).json({ error:'non possédé' }); rec.equipped[cat] = id; }
      await saveRec(me, rec); notify(); res.json(await stateFor(me));
    } catch(e){ console.error('[economy] equip', e); res.status(500).json({ error:'db' }); }
  });

  router.post('/reroll', async (req, res) => {
    const me = getMe(req); if (!me) return res.status(400).json({ error:'me manquant' });
    try {
      const rec = await getRec(me); const owned = new Set(rec.purchases||[]);
      if (!rec.shop || rec.shop.date !== todayStr()) rec.shop = { date: todayStr(), slots: genShop(owned), rerolled: false };
      if (rec.shop.rerolled) return res.status(400).json({ error:'coupon déjà utilisé aujourd\'hui' });
      if (rec.balance < REROLL_COST) return res.status(400).json({ error:'solde insuffisant' });
      rec.balance -= REROLL_COST;
      rec.shop = { date: todayStr(), slots: genShop(owned), revealed: false, rerolled: true };
      await saveRec(me, rec); notify(); res.json(await stateFor(me));
    } catch(e){ console.error('[economy] reroll', e); res.status(500).json({ error:'db' }); }
  });

  // Révèle définitivement (pour la journée) le slot « épique ou plus »
  router.post('/reveal', async (req, res) => {
    const me = getMe(req); if (!me) return res.status(400).json({ error:'me manquant' });
    try {
      const rec = await getRec(me);
      if (rec.shop && rec.shop.date === todayStr() && !rec.shop.revealed){
        rec.shop.revealed = true; await saveRec(me, rec);
      }
      res.json(await stateFor(me));
    } catch(e){ console.error('[economy] reveal', e); res.status(500).json({ error:'db' }); }
  });

  // Cosmétiques équipés de TOUS les membres (pour l'affichage sur les profils)
  router.get('/all', async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query("SELECT k, v FROM economy_kv WHERE k LIKE 'm:%'");
      const out = {};
      for (const r of rows){
        const name = r.k.slice(2);
        const eq = (r.v && r.v.equipped) || {};
        const detail = {};
        for (const cat of Object.keys(eq)){
          const it = ITEM_BY_KEY.get(cat + ':' + eq[cat]);
          if (it) detail[cat] = { id: it.id, nom: it.nom, fichier: it.fichier, rarity: it.rarity };
        }
        out[name] = detail;
      }
      res.json(out);
    } catch(e){ console.error('[economy] all', e); res.status(500).json({ error:'db' }); }
  });

  // ---- GAINS (à appeler depuis tes routes existantes) ----
  router.gains = GAIN;
  router.credit = (me, amount, reason) => creditMember(me, Number(amount)||0, reason).then(() => notify());

  router.onProposeGame = (proposeur, gameId) =>
    creditOnce('propose:'+gameId+':'+proposeur, proposeur, GAIN.propose, 'Jeu proposé').then(ok => { if (ok) notify(); return ok; });

  // À appeler à la PREMIÈRE note d'un votant sur un jeu (seule la 1re compte)
  router.onRating = async (proposeur, gameId, votant, note) => {
    const key = 'rate:'+gameId+':'+votant; const c = await getCredited();
    if (c[key]) return false;
    c[key] = true; await saveCredited(c);
    const amount = note >= 10 ? GAIN.rate10 : (note >= 7 ? GAIN.rate7 : 0);
    if (amount > 0) { await creditMember(proposeur, amount, 'Note '+note+' reçue'); notify(); }
    return true;
  };

  router.onPromo = (membre, promoId) =>
    creditOnce('promo:'+promoId, membre, GAIN.promo, 'Promo repérée').then(ok => { if (ok) notify(); return ok; });

  router.onDispos = (membre, cleSemaine) =>
    creditOnce('dispos:'+membre+':'+cleSemaine, membre, GAIN.dispos, 'Dispos hebdo').then(ok => { if (ok) notify(); return ok; });

  // difficulté: 'facile' | 'normale' | 'difficile' — récompense tous les participants, 1×/campagne
  router.onCampaignSuccess = async (arcId, difficulte, participants) => {
    const key = 'camp:'+arcId; const c = await getCredited();
    if (c[key]) return false;
    c[key] = true; await saveCredited(c);
    const reward = GAIN.campaign[stripAccents(difficulte)] || GAIN.campaign.normale;
    for (const p of (participants||[])) await creditMember(p, reward, 'Campagne réussie ('+difficulte+')');
    notify(); return true;
  };

  return router;
};
