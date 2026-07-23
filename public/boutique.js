/* boutique.js — Bourse + Boutique Guildpoints pour La Guilde (module additif, vanilla)
 *
 * Intégration :
 *   1) Mets ce fichier dans  public/boutique.js
 *   2) Dans index.html, avant </body> :  <script src="boutique.js"></script>
 *   3) Règle l'identité si besoin (voir CONFIG.getMe ci-dessous).
 *   4) Ouvre la boutique depuis un onglet de ta nav :  onclick="GuildEconomy.openShop()"
 *      (La bourse en haut à droite s'affiche toute seule.)
 *
 * Rien de ton code existant n'est modifié : tout est injecté par ce module.
 */
(function () {
  const CONFIG = {
    apiBase: '/api/economy',
    assetBase: '',                 // '' => /banners /frames /themes ; sinon préfixe
    // Pseudo du joueur courant (La Guilde le stocke dans localStorage 'guilde:profile')
    getMe() {
      try { return localStorage.getItem('guilde:profile') || (typeof ME !== 'undefined' ? ME : null); }
      catch (e) { return (typeof ME !== 'undefined' ? ME : null); }
    },
  };

  const RCOLOR = { commun:'#4ADE80', rare:'#5EC8F2', epique:'#B78CFF', mythique:'#FF6B81', legendaire:'#FFC857' };
  const RLABEL = { commun:'Commun', rare:'Rare', epique:'Épique', mythique:'Mythique', legendaire:'Légendaire' };
  const CATLABEL = { couleurs:'Couleurs de pseudo', statuts:'Statuts', bannieres:'Bannières', bordures:'Bordures', themes:'Thèmes' };
  const CATORDER = ['couleurs','statuts','bannieres','bordures','themes'];
  const FRAC = 0.4867;
  let CATALOGUE = null, STATE = null, PROF = null;

  const CATLBL = { couleurs:'Couleur de pseudo', statuts:'Statut', bannieres:'Bannière', bordures:'Bordure', themes:'Thème' };
  const CATICO = { couleurs:'🎨', statuts:'💬', bannieres:'🖼️', bordures:'⭕', themes:'🌐' };

  // Palettes des thèmes, pour l'aperçu au survol
  const THEME_PAL = {
    cyberpunk:{bg:'#070b14',panel:'#0d1526',border:'#1c2c4a',text:'#dff6ff',muted:'#6f88a8',accent:'#00E5FF',gold:'#FF3CAC'},
    vaporwave:{bg:'#180a33',panel:'#241246',border:'#3d2170',text:'#ffe6fb',muted:'#a488c8',accent:'#FF6AD5',gold:'#05FFA1'},
    terminal:{bg:'#030a04',panel:'#06140a',border:'#123d1c',text:'#b6ffc4',muted:'#4f9463',accent:'#33FF66',gold:'#9dff33'},
    enfer:{bg:'#140404',panel:'#210909',border:'#4a1c1c',text:'#ffe0d6',muted:'#b07a70',accent:'#FF5722',gold:'#FFB300'},
    toundra:{bg:'#061019',panel:'#0c1a26',border:'#1c3a4f',text:'#e6f9ff',muted:'#7095a8',accent:'#7FE7FF',gold:'#CFF4FF'},
    'or-royal':{bg:'#120f08',panel:'#1e190e',border:'#4a3d1c',text:'#fff3d6',muted:'#b0a070',accent:'#FFD24A',gold:'#FFE9A6'},
    valorant:{bg:'#0d1420',panel:'rgba(15,26,42,.85)',border:'#96465899',text:'#eef0ff',muted:'#8ea0c0',accent:'#FF4655',gold:'#00E5C0'},
    void:{bg:'#0c0718',panel:'rgba(22,14,40,.85)',border:'#a06edc99',text:'#ecdcff',muted:'#a088c8',accent:'#A24BFF',gold:'#C77BFF'},
    shurima:{bg:'#171208',panel:'rgba(34,26,12,.85)',border:'#c8a05a99',text:'#fff0d0',muted:'#c4ac78',accent:'#E8C15A',gold:'#FFDE8A'},
    ionia:{bg:'#12101c',panel:'rgba(28,22,40,.85)',border:'#c896be99',text:'#ffe9f2',muted:'#b8a8c8',accent:'#FF89B0',gold:'#9ED9C0'},
    piltover:{bg:'#17110a',panel:'rgba(34,26,14,.85)',border:'#d2aa5a99',text:'#fff2dc',muted:'#c4ac80',accent:'#F2C14E',gold:'#FFCF87'},
    zaun:{bg:'#0c1109',panel:'rgba(20,30,16,.85)',border:'#78b45a99',text:'#e6ffd8',muted:'#9fb888',accent:'#7CFF6B',gold:'#C87F3A'},
    pirate:{bg:'#0c1512',panel:'rgba(16,30,26,.85)',border:'#96aa7899',text:'#f2ead6',muted:'#a8b49c',accent:'#E8C15A',gold:'#4FD0C0'},
  };

  // Profil réel du joueur (pseudo, avatar, couleur) — repris de /api/state
  async function loadProfile(){
    const me = CONFIG.getMe();
    try {
      const st = await fetch('/api/state').then(r => r.json());
      const p = (st.profiles || {})[me] || {};
      PROF = { name: me, avatar: p.avatar || null, color: p.color || '#8B7CFF' };
    } catch(e){ PROF = { name: me, avatar: null, color: '#8B7CFF' }; }
  }
  function initials(n){ return String(n||'?').slice(0,2).toUpperCase(); }
  function avatarInner(){
    if (!PROF) return '🎮';
    if (PROF.avatar && PROF.avatar.type === 'emoji') return PROF.avatar.value;
    if (PROF.avatar && PROF.avatar.type === 'url')
      return `<img src="${PROF.avatar.value}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    return `<span style="font-size:.5em;font-weight:800">${initials(PROF.name)}</span>`;
  }
  const myName  = () => (PROF && PROF.name) || CONFIG.getMe() || 'Toi';
  const myColor = () => (PROF && PROF.color) || '#8B7CFF';

  // ---------- helpers ----------
  const api = (p, body) => fetch(CONFIG.apiBase + p, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(Object.assign({ me: CONFIG.getMe() }, body || {})),
  }).then(r => r.json());

  function asset(kind, file){ return (CONFIG.assetBase || '') + '/' + kind + '/' + file; }

  // Rendu d'un aperçu d'item selon sa catégorie
  function preview(it){
    if (it.cat === 'bannieres' && it.fichier)
      return `<div class="ge-pv ge-pv-ban" style="background-image:url('${asset('banners',it.fichier)}')"></div>`;
    if (it.cat === 'bordures' && it.fichier)
      return `<div class="ge-pv ge-pv-frm"><span class="ge-av" style="background:${myColor()}">${avatarInner()}</span>`+
             `<img src="${asset('frames',it.fichier)}" alt=""></div>`;
    if (it.cat === 'themes')
      return it.fichier
        ? `<div class="ge-pv ge-pv-ban" style="background-image:url('${asset('themes',it.fichier)}')"></div>`
        : `<div class="ge-pv ge-pv-theme ge-th-${it.id}"></div>`;
    if (it.cat === 'couleurs')
      return `<div class="ge-pv ge-pv-txt"><span class="ge-nom ge-c-${it.id}">${myName()}</span></div>`;
    if (it.cat === 'statuts')
      return `<div class="ge-pv ge-pv-txt"><span class="ge-statut">${it.nom}</span></div>`;
    return `<div class="ge-pv"></div>`;
  }

  function itemCard(it, ctx){
    const col = RCOLOR[it.rarity] || '#8A90A6';
    const owned = it.owned;
    const me = STATE ? STATE.balance : 0;
    const afford = me >= it.price;
    let action = '';
    if (ctx === 'shop'){
      action = owned
        ? `<span class="ge-owned">Possédé</span>`
        : `<button class="ge-buy" data-buy="${it.key}" ${afford?'':'disabled'}>
             ${it.price} <b>GP</b></button>`;
    } else { // owned tab
      const eq = STATE && STATE.equipped && STATE.equipped[it.cat] === it.id;
      action = eq
        ? `<button class="ge-eq on" data-eq="${it.cat}" data-id="">Équipé ✓</button>`
        : `<button class="ge-eq" data-eq="${it.cat}" data-id="${it.id}">Équiper</button>`;
    }
    const themeAttr = (it.cat === 'themes') ? ` data-theme="${it.id}" data-tname="${it.nom}"` : '';
    return `<div class="ge-card" style="border-color:${col}55"${themeAttr}>
      <div class="ge-catlbl">${CATICO[it.cat]||''} ${CATLBL[it.cat]||it.cat}</div>
      ${preview(it)}
      <div class="ge-meta">
        <div class="ge-nm">${it.nom}</div>
        <div class="ge-rar" style="color:${col}">${RLABEL[it.rarity]||''}</div>
      </div>
      <div class="ge-act" style="--rc:${col}">${action}</div>
    </div>`;
  }

  function lockedCard(rarity){
    const col = RCOLOR[rarity] || '#8A90A6';
    return `<div class="ge-card ge-locked" style="border-color:${col}33">
      <div class="ge-pv ge-pv-lock">?</div>
      <div class="ge-meta"><div class="ge-nm">? ? ?</div>
      <div class="ge-rar" style="color:${col}">${RLABEL[rarity]||''}</div></div>
      <div class="ge-act"></div></div>`;
  }

  // ---------- vues ----------
  function mysteryCard(){
    return `<div class="ge-card ge-mystery" id="ge-mystery">
      <div class="ge-catlbl">✨ Emplacement mystère</div>
      <div class="ge-pv ge-pv-myst"><span class="ge-qm">?</span></div>
      <div class="ge-meta">
        <div class="ge-nm">? ? ?</div>
        <div class="ge-rar" style="color:#8A90A6">Épique ou plus</div>
      </div>
      <div class="ge-act"><button class="ge-reveal">Révéler</button></div>
    </div>`;
  }

  function renderShop(){
    const s = STATE.shop;
    const last = s.slots.length - 1;
    const cards = s.slots.map((it, i) =>
      (i === last && !s.revealed) ? mysteryCard() : itemCard(it, 'shop')
    ).join('');
    const usedCoupon = s.rerolled;
    const nbCat = (CATALOGUE && CATALOGUE.items) ? CATALOGUE.items.length : 0;
    const nbVente = (CATALOGUE && CATALOGUE.items) ? CATALOGUE.items.filter(i => i.price > 0).length : 0;
    const emptyMsg = s.slots.length ? '' :
      `<div class="ge-empty"><b>Aucun objet en vente.</b><br><br>
       Diagnostic : <b>${nbCat}</b> objets lus dans <code>catalogue.json</code>,
       dont <b>${nbVente}</b> avec un prix &gt; 0.<br><br>
       ${nbCat === 0
         ? 'Le fichier <code>catalogue.json</code> est absent de la racine du repo, ou sa syntaxe est invalide.'
         : 'Les objets n\'ont pas de prix : remplis le champ <code>prix</code> dans <code>catalogue.json</code>.'}
       </div>`;
    return `
      <div class="ge-shop-head">
        <span class="ge-info" tabindex="0">i
          <span class="ge-tip">
            <b>Comment marche la boutique</b>
            <span>· La boutique se <b>réinitialise chaque jour</b>, et elle t'est propre : chacun a la sienne.</span>
            <span>· <b>11 emplacements</b> : 5 communs, 3 rares, 2 épiques, et 1 emplacement mystère.</span>
            <span>· L'emplacement mystère donne un objet <b>épique ou mieux</b> :
              <b style="color:#B78CFF">50 % épique</b>, <b style="color:#FF6B81">37,5 % mythique</b>,
              <b style="color:#FFC857">12,5 % légendaire</b>.</span>
            <span>· Le <b>coupon de reset</b> régénère toute la boutique. Une seule fois par jour, c'est définitif.</span>
            <span>· Un objet déjà possédé ne réapparaît jamais en vente.</span>
          </span>
        </span>
        <div class="ge-legend">
          ${Object.keys(RCOLOR).map(r=>`<span><i style="background:${RCOLOR[r]}"></i>${RLABEL[r]}</span>`).join('')}
        </div>
        <button class="ge-coupon ${usedCoupon?'used':''}" id="ge-reroll" ${usedCoupon?'disabled':''}>
          🎟️ Coupon de reset journalier · ${s.cost} GP
        </button>
      </div>
      ${emptyMsg}
      <div class="ge-grid">${cards}</div>
      <div class="ge-foot">Le shop se réinitialise chaque jour. Les objets déjà possédés n'y réapparaissent pas.
        <span style="opacity:.5"> · boutique.js v2</span></div>`;
  }

  function renderOwned(){
    const owned = new Set(STATE.purchases || []);
    let html = '';
    for (const cat of CATORDER){
      const items = CATALOGUE.items.filter(i => i.cat === cat);
      if (!items.length) continue;
      html += `<h3 class="ge-cat">${CATLABEL[cat]||cat}</h3>`;
      for (const rar of CATALOGUE.rarityOrder){
        const grp = items.filter(i => i.rarity === rar);
        if (!grp.length) continue;
        html += `<div class="ge-rowlabel" style="color:${RCOLOR[rar]}">${RLABEL[rar]}</div><div class="ge-grid">`;
        html += grp.map(it => owned.has(it.key)
          ? itemCard(Object.assign({owned:true}, it), 'owned')
          : lockedCard(it.rarity)).join('');
        html += `</div>`;
      }
    }
    return html;
  }

  function paint(){
    const body = document.getElementById('ge-body');
    if (!body) return;
    body.innerHTML = (STATE.tab === 'owned') ? renderOwned() : renderShop();
    document.querySelectorAll('#ge-tab-shop,#ge-tab-owned').forEach(b=>b.classList.remove('on'));
    document.getElementById(STATE.tab==='owned'?'ge-tab-owned':'ge-tab-shop').classList.add('on');
    const w = document.getElementById('ge-panel-gp'); if (w) w.textContent = STATE.balance;
    updateWallet();
  }

  // ---------- actions ----------
  async function refresh(){ STATE = Object.assign({ tab: (STATE&&STATE.tab)||'shop' }, await api('/state')); paint(); }

  async function doBuy(key){
    const r = await api('/buy', { key });
    if (r.error) return toast(r.error);
    STATE = Object.assign({ tab:'shop' }, r); paint();
    toast('Acheté ✓');
  }
  async function doEquip(cat, id){
    const r = await api('/equip', { cat, id: id || null });
    if (r.error) return toast(r.error);
    STATE = Object.assign({ tab:'owned' }, r); paint();
  }
  async function doReveal(){
    const card = document.getElementById('ge-mystery');
    if (card) card.classList.add('ge-flip');
    await new Promise(r => setTimeout(r, 620));      // laisse l'animation se jouer
    const r = await api('/reveal');
    if (r.error) return toast(r.error);
    STATE = Object.assign({ tab:'shop' }, r); paint();
    const fresh = document.querySelector('.ge-grid .ge-card:last-child');
    if (fresh) fresh.classList.add('ge-pop');
  }

  async function doReroll(){
    confirmBox(
      'Coupon de reset journalier',
      'Cette action est valable une fois par jour et est définitive. Elle régénère entièrement ta boutique du jour pour ' + STATE.shop.cost + ' GP.',
      async () => {
        const r = await api('/reroll');
        if (r.error) return toast(r.error);
        STATE = Object.assign({ tab:'shop' }, r); paint();
        toast('Boutique régénérée ✓');
      });
  }

  // ---------- aperçu d'un thème au survol ----------
  function themeMock(pal, nom, img){
    const bgImg = img ? `background-image:linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.62)),url('${asset('themes',img)}');background-size:cover;background-position:center;` : '';
    return `<div class="ge-tm" style="background:${pal.bg};${bgImg}">
      <div class="ge-tm-h" style="border-color:${pal.border}">
        <span style="color:${pal.gold};font-family:'Silkscreen',monospace;font-size:11px">LA <span style="color:${pal.accent}">GUILDE</span></span>
        <span class="ge-tm-chip" style="background:${pal.panel};border-color:${pal.border};color:${pal.text}">
          <i style="background:${pal.accent}"></i>${myName()}</span>
      </div>
      <div class="ge-tm-tabs">
        <span style="background:${pal.accent}33;border-color:${pal.accent};color:${pal.text}">Panneau</span>
        <span style="border-color:${pal.border};color:${pal.muted}">Social</span>
        <span style="border-color:${pal.border};color:${pal.muted}">Aventures</span>
      </div>
      <div class="ge-tm-card" style="background:${pal.panel};border-color:${pal.border}">
        <div style="color:${pal.accent};font-family:'Silkscreen',monospace;font-size:8px;letter-spacing:1px;margin-bottom:7px">DERNIERS JEUX</div>
        <div class="ge-tm-row" style="border-color:${pal.border};color:${pal.text}">Sea of Thieves <b style="color:${pal.gold}">19,99 €</b></div>
        <div class="ge-tm-row" style="border-color:${pal.border};color:${pal.text}">Hades II <b style="color:${pal.gold}">-30 %</b></div>
        <div class="ge-tm-row" style="border:none;color:${pal.text}">Valheim <b style="color:${pal.gold}">Gratuit</b></div>
      </div>
      <div class="ge-tm-foot" style="color:${pal.muted}">Aperçu — « ${nom} »</div>
    </div>`;
  }
  function showThemePreview(card){
    const id = card.dataset.theme, pal = THEME_PAL[id];
    if (!pal) return;
    const item = (CATALOGUE.items || []).find(i => i.cat === 'themes' && i.id === id);
    let box = document.getElementById('ge-tpv');
    if (!box){ box = document.createElement('div'); box.id = 'ge-tpv'; document.body.appendChild(box); }
    box.innerHTML = themeMock(pal, card.dataset.tname, item && item.fichier);
    const r = card.getBoundingClientRect();
    const W = 300, H = 235;
    let left = r.right + 12; if (left + W > innerWidth - 10) left = r.left - W - 12;
    if (left < 10) left = Math.max(10, (innerWidth - W) / 2);
    let top = r.top; if (top + H > innerHeight - 10) top = Math.max(10, innerHeight - H - 10);
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.classList.add('on');
  }
  function hideThemePreview(){ const b = document.getElementById('ge-tpv'); if (b) b.classList.remove('on'); }

  // ---------- ouverture / fermeture ----------
  async function openShop(){
    ensureStyle();
    if (!CATALOGUE) CATALOGUE = await fetch(CONFIG.apiBase + '/catalogue').then(r=>r.json());
    if (!PROF) await loadProfile();
    let ov = document.getElementById('ge-overlay');
    if (!ov){
      ov = document.createElement('div');
      ov.id = 'ge-overlay';
      ov.innerHTML = `
        <div class="ge-modal">
          <div class="ge-top">
            <div class="ge-title">🛒 Boutique</div>
            <div class="ge-purse">◆ <b id="ge-panel-gp">…</b> GP</div>
            <div class="ge-tabs">
              <button id="ge-tab-shop" class="on">Shop du jour</button>
              <button id="ge-tab-owned">Possédés</button>
            </div>
            <button class="ge-close" id="ge-close">✕</button>
          </div>
          <div class="ge-scroll"><div id="ge-body"></div></div>
        </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', e => { if (e.target === ov) closeShop(); });
      document.getElementById('ge-close').onclick = closeShop;
      document.getElementById('ge-tab-shop').onclick = () => { STATE.tab='shop'; paint(); };
      document.getElementById('ge-tab-owned').onclick = () => { STATE.tab='owned'; paint(); };
      const bodyEl = document.getElementById('ge-body');
      bodyEl.addEventListener('mouseover', e => {
        const c = e.target.closest('.ge-card[data-theme]');
        if (c) showThemePreview(c);
      });
      bodyEl.addEventListener('mouseout', e => {
        const c = e.target.closest('.ge-card[data-theme]');
        if (c && !c.contains(e.relatedTarget)) hideThemePreview();
      });
      document.querySelector('.ge-scroll').addEventListener('scroll', hideThemePreview);
      bodyEl.addEventListener('click', e => {
        const b = e.target.closest('[data-buy]'); if (b) return doBuy(b.dataset.buy);
        const q = e.target.closest('[data-eq]');  if (q) return doEquip(q.dataset.eq, q.dataset.id);
        if (e.target.closest('#ge-reroll')) return doReroll();
        if (e.target.closest('.ge-reveal')) return doReveal();
      });
    }
    ov.style.display = 'flex';
    if (!CONFIG.getMe()){ document.getElementById('ge-body').innerHTML =
      '<p class="ge-foot">Impossible de trouver ton pseudo. Règle <code>CONFIG.getMe</code> dans boutique.js.</p>'; return; }
    await refresh();
  }
  function closeShop(){ const ov=document.getElementById('ge-overlay'); if (ov) ov.style.display='none'; }

  // ---------- bourse (haut droite) ----------
  async function updateWallet(){
    const el = document.getElementById('ge-wallet-gp'); if (!el) return;
    if (STATE) { el.textContent = STATE.balance; return; }
    try { const s = await api('/state'); el.textContent = s.balance; } catch(e){}
  }
  function mountWallet(){
    if (document.getElementById('ge-wallet')) return;
    const w = document.createElement('button');
    w.id = 'ge-wallet'; w.title = 'Ta bourse — ouvrir la boutique';
    w.innerHTML = `◆ <b id="ge-wallet-gp">…</b> <span>GP</span>`;
    w.onclick = openShop;
    document.body.appendChild(w);
    updateWallet();
    setInterval(updateWallet, 30000);
  }

  // ---------- petits UI (toast / confirm) ----------
  function toast(msg){
    let t = document.getElementById('ge-toast');
    if (!t){ t=document.createElement('div'); t.id='ge-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('on'), 2200);
  }
  function confirmBox(title, msg, onYes){
    const d = document.createElement('div'); d.className = 'ge-confirm';
    d.innerHTML = `<div class="ge-cbox"><h4>${title}</h4><p>${msg}</p>
      <div class="ge-cbtns"><button class="ge-no">Annuler</button>
      <button class="ge-yes">Confirmer</button></div></div>`;
    document.body.appendChild(d);
    d.querySelector('.ge-no').onclick = () => d.remove();
    d.querySelector('.ge-yes').onclick = () => { d.remove(); onYes(); };
  }

  // ---------- styles ----------
  function ensureStyle(){
    if (document.getElementById('ge-style')) return;
    const css = `
    #ge-wallet{position:fixed;top:14px;right:16px;z-index:9000;background:#171A24;color:#FFC857;
      border:1px solid #FFC85755;border-radius:999px;padding:7px 15px;font:700 14px 'Outfit',sans-serif;
      cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;gap:6px;align-items:center;}
    #ge-wallet span{color:#8A90A6;font-weight:600;} #ge-wallet b{color:#FFC857;}
    #ge-overlay{position:fixed;inset:0;z-index:9500;background:rgba(6,7,12,.72);backdrop-filter:blur(5px);
      display:none;align-items:center;justify-content:center;padding:20px;}
    .ge-modal{width:min(1000px,96vw);max-height:92vh;background:#12141d;border:1px solid #262B3B;border-radius:18px;
      display:flex;flex-direction:column;overflow:hidden;font-family:'Outfit',sans-serif;color:#E9EBF5;}
    .ge-top{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid #262B3B;flex-wrap:wrap;}
    .ge-title{font-family:'Silkscreen',monospace;font-size:15px;color:#FFC857;letter-spacing:1px;}
    .ge-purse{background:#0F1118;border:1px solid #FFC85744;border-radius:999px;padding:5px 13px;color:#FFC857;font-weight:800;}
    .ge-tabs{display:flex;gap:6px;margin-left:auto;}
    .ge-tabs button{background:none;border:1px solid #262B3B;color:#8A90A6;border-radius:9px;padding:7px 14px;
      font:700 13px 'Outfit';cursor:pointer;}
    .ge-tabs button.on{background:rgba(139,124,255,.16);border-color:#8B7CFF;color:#E9EBF5;}
    .ge-close{background:none;border:1px solid #262B3B;color:#8A90A6;border-radius:9px;width:34px;height:34px;cursor:pointer;font-size:15px;}
    .ge-scroll{overflow:auto;padding:16px 18px 22px;}
    .ge-shop-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
    .ge-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#8A90A6;}
    .ge-legend span{display:inline-flex;align-items:center;gap:5px;}
    .ge-legend i{width:10px;height:10px;border-radius:50%;display:inline-block;}
    .ge-coupon{margin-left:auto;background:#1D2130;border:1px solid #FFC85766;color:#FFC857;border-radius:10px;
      padding:9px 15px;font:800 13px 'Outfit';cursor:pointer;}
    .ge-coupon.used{opacity:.45;cursor:not-allowed;border-color:#262B3B;color:#8A90A6;}
    .ge-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:10px;}
    .ge-card{background:#171A24;border:1.5px solid #262B3B;border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;}
    .ge-pv{height:96px;border-radius:10px;background:#0F1118;overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;}
    .ge-pv-ban{background-size:cover;background-position:center;}
    .ge-pv-frm .ge-av{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:52px;height:52px;border-radius:50%;
      background:#8B7CFF;display:flex;align-items:center;justify-content:center;font-size:26px;}
    .ge-pv-frm img{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:calc(52px / ${FRAC});height:calc(52px / ${FRAC});}
    .ge-pv-lock{font:800 32px 'Silkscreen';color:#3a4056;}
    .ge-pv-txt{background:#0F1118;} .ge-nom{font-weight:800;font-size:20px;} .ge-statut{font-style:italic;font-weight:700;color:#E9EBF5;font-size:14px;padding:0 8px;text-align:center;}
    .ge-meta .ge-nm{font-weight:800;font-size:13.5px;} .ge-rar{font-family:'Silkscreen',monospace;font-size:9px;letter-spacing:.5px;margin-top:2px;}
    .ge-act{display:flex;} .ge-buy{flex:1;background:var(--rc);color:#0b0b12;border:none;border-radius:9px;padding:8px;font:800 13px 'Outfit';cursor:pointer;}
    .ge-buy:disabled{opacity:.4;cursor:not-allowed;} .ge-owned{color:#4ADE80;font-weight:800;font-size:13px;}
    .ge-eq{flex:1;background:none;border:1px solid var(--rc,#8B7CFF);color:#E9EBF5;border-radius:9px;padding:7px;font:800 13px 'Outfit';cursor:pointer;}
    .ge-eq.on{background:#4ADE8022;border-color:#4ADE80;color:#4ADE80;}
    .ge-locked{opacity:.6;} .ge-cat{font-family:'Silkscreen',monospace;font-size:13px;color:#FFC857;margin:20px 0 8px;}
    .ge-rowlabel{font-family:'Silkscreen',monospace;font-size:9px;letter-spacing:1px;margin:6px 0 8px;}
    .ge-foot{color:#8A90A6;font-size:12px;margin-top:8px;}
    /* catégorie sur la carte */
    .ge-catlbl{font-family:'Silkscreen',monospace;font-size:8px;letter-spacing:.5px;color:#8A90A6;text-transform:uppercase;margin-bottom:-2px;}
    /* emplacement mystère */
    .ge-mystery{border-color:#FFC85766!important;background:linear-gradient(160deg,#1a1626,#171A24);}
    .ge-pv-myst{background:radial-gradient(circle at 50% 45%,#2a2340,#12141d);position:relative;overflow:hidden;}
    .ge-pv-myst::after{content:"";position:absolute;inset:-40%;background:linear-gradient(115deg,transparent 42%,rgba(255,200,87,.22) 50%,transparent 58%);animation:ge-shine 2.6s linear infinite;}
    .ge-qm{font:800 44px 'Silkscreen',monospace;color:#FFC857;text-shadow:0 0 18px rgba(255,200,87,.55);position:relative;z-index:1;animation:ge-float 2.4s ease-in-out infinite;}
    .ge-reveal{flex:1;background:linear-gradient(90deg,#FFC857,#FFB300);color:#12141d;border:none;border-radius:9px;padding:8px;font:800 13px 'Outfit';cursor:pointer;}
    .ge-flip{animation:ge-flip .6s ease-in forwards;}
    .ge-pop{animation:ge-pop .5s cubic-bezier(.2,1.5,.4,1);}
    @keyframes ge-shine{to{transform:translateX(60%)}}
    @keyframes ge-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
    @keyframes ge-flip{0%{transform:rotateY(0)}60%{transform:rotateY(90deg) scale(1.06)}100%{transform:rotateY(90deg) scale(.9);opacity:0}}
    @keyframes ge-pop{0%{transform:rotateY(-90deg) scale(.9);opacity:0}100%{transform:none;opacity:1}}
    /* bulle d'aide */
    .ge-info{width:22px;height:22px;border-radius:50%;border:1px solid #8B7CFF;color:#8B7CFF;display:inline-flex;
      align-items:center;justify-content:center;font:800 13px 'Outfit';cursor:help;position:relative;flex:none;}
    .ge-info .ge-tip{display:none;position:absolute;top:28px;left:0;width:330px;background:#0F1118;border:1px solid #8B7CFF66;
      border-radius:12px;padding:14px;z-index:50;box-shadow:0 12px 30px rgba(0,0,0,.6);color:#C9CEDE;font:400 12.5px/1.6 'Outfit';}
    .ge-info:hover .ge-tip,.ge-info:focus .ge-tip{display:block;}
    .ge-tip b{color:#E9EBF5;} .ge-tip>b{display:block;margin-bottom:7px;color:#FFC857;font-size:13px;}
    .ge-tip span{display:block;margin-bottom:5px;}
    /* aperçu de thème */
    #ge-tpv{position:fixed;z-index:9700;width:300px;opacity:0;pointer-events:none;transition:opacity .15s;}
    #ge-tpv.on{opacity:1;}
    .ge-tm{border:1px solid #262B3B;border-radius:12px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.7);font-family:'Outfit',sans-serif;}
    .ge-tm-h{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid;background:rgba(0,0,0,.2);}
    .ge-tm-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid;border-radius:999px;padding:2px 9px 2px 3px;font-size:10px;font-weight:700;}
    .ge-tm-chip i{width:13px;height:13px;border-radius:50%;display:inline-block;}
    .ge-tm-tabs{display:flex;gap:5px;padding:8px 10px 4px;}
    .ge-tm-tabs span{border:1px solid;border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;}
    .ge-tm-card{margin:6px 10px;border:1px solid;border-radius:9px;padding:9px;backdrop-filter:blur(3px);}
    .ge-tm-row{display:flex;justify-content:space-between;font-size:10px;font-weight:600;padding:4px 0;border-bottom:1px solid;}
    .ge-tm-foot{padding:2px 10px 8px;font-size:9px;font-style:italic;}
    .ge-empty{background:#1D2130;border:1px solid #FF6B8155;border-radius:12px;padding:18px;color:#C9CEDE;font-size:13.5px;line-height:1.6;}
    .ge-empty code{background:#0F1118;border:1px solid #262B3B;border-radius:5px;padding:1px 6px;color:#FFC857;}
    #ge-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(20px);z-index:9999;
      background:#1D2130;border:1px solid #262B3B;color:#E9EBF5;padding:10px 18px;border-radius:10px;font:700 13px 'Outfit';
      opacity:0;transition:.25s;pointer-events:none;} #ge-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}
    .ge-confirm{position:fixed;inset:0;z-index:9800;background:rgba(6,7,12,.7);display:flex;align-items:center;justify-content:center;padding:20px;}
    .ge-cbox{background:#12141d;border:1px solid #FFC85755;border-radius:16px;padding:22px;max-width:420px;font-family:'Outfit';}
    .ge-cbox h4{font-family:'Silkscreen',monospace;color:#FFC857;font-size:14px;margin-bottom:10px;}
    .ge-cbox p{color:#C9CEDE;font-size:14px;margin-bottom:18px;} .ge-cbtns{display:flex;gap:10px;justify-content:flex-end;}
    .ge-cbtns button{border-radius:9px;padding:9px 16px;font:800 13px 'Outfit';cursor:pointer;border:1px solid #262B3B;background:none;color:#8A90A6;}
    .ge-cbtns .ge-yes{background:#FFC857;color:#0b0b12;border-color:#FFC857;}
    /* aperçus couleurs de pseudo */
    .ge-nom.clip,.ge-c-encre,.ge-c-crepuscule,.ge-c-agrume,.ge-c-ocean,.ge-c-poison,.ge-c-vernis-pro,.ge-c-chrome,.ge-c-or-liquide,.ge-c-hologramme,.ge-c-braise,.ge-c-givre,.ge-c-arc-en-ciel,.ge-c-amethyste,.ge-c-sakura,.ge-c-emeraude,.ge-c-cuivre{-webkit-background-clip:text;background-clip:text;color:transparent;background-size:200% auto;}
    .ge-c-or-guilde{color:#FFC857;}.ge-c-sang{color:#FF4D4D;}.ge-c-menthe{color:#7CE7C4;}
    .ge-c-crepuscule{background-image:linear-gradient(90deg,#8B7CFF,#FF6B81);}
    .ge-c-agrume{background-image:linear-gradient(90deg,#FF9D5C,#FFD93D);}
    .ge-c-ocean{background-image:linear-gradient(90deg,#5EC8F2,#7CE7C4);}
    .ge-c-poison{background-image:linear-gradient(90deg,#4ADE80,#B78CFF);}
    .ge-c-vernis-pro{background-image:linear-gradient(100deg,#8B7CFF 0 38%,#fff 50%,#8B7CFF 62% 100%);animation:ge-sheen 1.5s linear infinite;}
    .ge-c-chrome{background-image:linear-gradient(100deg,#c8ccdd 0 40%,#fff 50%,#c8ccdd 60% 100%);animation:ge-sheen 2.6s linear infinite;}
    .ge-c-or-liquide{background-image:linear-gradient(100deg,#FFD24A 0 40%,#fff7d6 50%,#E8A33A 60% 100%);animation:ge-sheen 2.8s linear infinite;}
    .ge-c-hologramme{background-image:linear-gradient(90deg,#ff6ad5,#5EC8F2,#7CE7C4,#FFD93D,#ff6ad5);background-size:300% auto;animation:ge-holo 5s linear infinite;}
    .ge-c-braise{background-image:linear-gradient(0deg,#FF3D00,#FF9D00,#FFD93D);}
    .ge-c-givre{background-image:linear-gradient(100deg,#CFF4FF 0 40%,#fff 50%,#8FD8FF 60% 100%);animation:ge-sheen 4.2s linear infinite;}
    .ge-c-neon-fusion{color:#fff;text-shadow:0 0 5px #b388ff,0 0 12px #8B7CFF,0 0 22px #8B7CFF;}
    .ge-c-cyber{color:#9dfcff;text-shadow:0 0 6px #00E5FF,0 0 16px #00E5FF;}
    .ge-c-arc-en-ciel{background-image:linear-gradient(90deg,#FF6B81,#FFD93D,#4ADE80,#5EC8F2,#B78CFF,#FF6B81);background-size:300% auto;animation:ge-holo 3s linear infinite;}
    .ge-c-encre{background-image:linear-gradient(100deg,#31313d 0 42%,#c4c4d6 50%,#31313d 58% 100%);background-size:220% auto;animation:ge-sheen 3.4s linear infinite;}
    .ge-c-amethyste{background-image:linear-gradient(90deg,#A24BFF,#E36BFF,#A24BFF);background-size:200% auto;animation:ge-sheen 3.4s linear infinite;}
    .ge-c-sakura{background-image:linear-gradient(100deg,#ffd7e6 0 40%,#fff 50%,#ffb3d1 60% 100%);animation:ge-sheen 4s linear infinite;}
    .ge-c-emeraude{background-image:linear-gradient(100deg,#3ef0b0 0 40%,#eafff6 50%,#12b98a 60% 100%);animation:ge-sheen 3s linear infinite;}
    .ge-c-cuivre{background-image:linear-gradient(100deg,#E8894A 0 40%,#ffd9b0 50%,#B5652A 60% 100%);animation:ge-sheen 2.9s linear infinite;}
    .ge-c-toxique{color:#c6ff6b;text-shadow:0 0 6px #7CFF6B,0 0 16px #7CFF6B;}
    .ge-pv-theme{width:100%;height:100%;} .ge-th-cyberpunk{background:linear-gradient(135deg,#070b14,#00E5FF44);}
    .ge-th-vaporwave{background:linear-gradient(135deg,#180a33,#FF6AD5);} .ge-th-terminal{background:linear-gradient(135deg,#030a04,#33FF66);}
    .ge-th-enfer{background:linear-gradient(135deg,#140404,#FF5722);} .ge-th-toundra{background:linear-gradient(135deg,#061019,#7FE7FF);}
    .ge-th-or-royal{background:linear-gradient(135deg,#120f08,#FFD24A);}
    @keyframes ge-sheen{to{background-position:-200% center;}} @keyframes ge-holo{to{background-position:300% center;}}`;
    const st = document.createElement('style'); st.id = 'ge-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------- boot ----------
  function boot(){ console.log('[La Guilde] boutique.js v2 chargé'); ensureStyle(); mountWallet(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.GuildEconomy = { openShop, closeShop, refresh, CONFIG };
})();
