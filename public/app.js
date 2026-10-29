/* Pizarra de conclusiones — IV encuentro de la construcción CAPECO
   Vue 3 (CDN) + Gun.js (conclusiones y "coincido" en tiempo real + localStorage) + qrcode.js.
   La moderación (destacar, ocultar, cerrar recepción) vive en el servidor
   y llega por Server-Sent Events; solo un moderador con PIN puede cambiarla. */
(() => {
  const { createApp, reactive, ref, computed, watch, nextTick, onMounted } = Vue;
  const QA = window.QAShared;

  // ---------------------------------------------------------------- Config
  const CONFIG = {
    cooldownMs: 20000,
    boardSlots: 6,          // casillas por página en el proyector (3 × 2)
    boardRotateMs: 12000,   // cambio automático de página
    // Relays Gun adicionales (opcional): ['https://tu-app.onrender.com/gun']
    extraPeers: [],
  };

  // ------------------------------------------------- Almacenamiento local
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } },
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let clientId = store.get('qa:client', null);
  if (!clientId || !QA.VOTER_RE.test(clientId)) { clientId = uid(); store.set('qa:client', clientId); }

  // ------------------------------------------------------------------ Gun
  const isFile = location.protocol === 'file:';
  const peers = [...(isFile ? [] : [location.origin + '/gun']), ...CONFIG.extraPeers];
  const gun = Gun({ peers, localStorage: true });
  const root = gun.get(QA.NAMESPACE);
  const qNode = root.get('questions');
  const voteNode = root.get('votes');

  // --------------------------------------------------------------- Rutas
  const detectRoute = () => {
    const p = location.pathname.replace(/\/+$/, '');
    if (p.endsWith('/proyector')) return 'projector';
    if (p.endsWith('/moderar')) return 'moderator';
    return 'audience';
  };
  const audienceUrl = isFile ? location.href.split('#')[0] : location.origin + '/';
  const NO_MOD = { featured: 0, answered: false, hidden: false };

  // ----------------------------------------------------------------- App
  createApp({
    setup() {
      const route = detectRoute();
      const questions = reactive({});
      const votes = reactive({});
      const mod = reactive({ open: true, closedAt: 0, items: {} });
      const now = ref(Date.now());
      const conn = ref('connecting');
      const draft = ref('');
      const error = ref('');
      const notice = ref('');
      const toast = ref('');
      const sort = ref(store.get('qa:sort', 'recent'));
      const modFilter = ref('visible');
      const boardPage = ref(0);
      const openedId = ref(null);
      const controlsVisible = ref(true);
      const qrEl = ref(null);
      const mine = new Set(store.get('qa:mine', []));
      const rejected = new Set(store.get('qa:rejected', []));

      document.documentElement.dataset.view = route;
      document.title = {
        audience: 'Pizarra de Conclusiones',
        projector: 'Proyector · Pizarra de Conclusiones',
        moderator: 'Moderación · Pizarra de Conclusiones',
      }[route];

      // ---- Preguntas y votos (Gun)
      const watchedVotes = new Set();
      qNode.map().on((data, key) => {
        if (!data || typeof data.text !== 'string' || rejected.has(key) || !QA.textMatchesId(key, data.text)) {
          delete questions[key];
          return;
        }
        questions[key] = { id: key, text: data.text, ts: QA.tsFromId(key) };
        if (!watchedVotes.has(key)) {
          watchedVotes.add(key);
          voteNode.get(key).map().on((v, voter) => {
            if (!votes[key]) votes[key] = {};
            if (v === 1) votes[key][voter] = 1;
            else delete votes[key][voter];
          });
        }
      });

      // ---- Moderación (servidor → todos, en tiempo real)
      const applyMod = (s) => {
        mod.open = s.open !== false;
        mod.closedAt = s.closedAt || 0;
        mod.items = s.items || {};
      };
      if (!isFile) {
        const es = new EventSource('/api/events');
        es.onmessage = (e) => { try { applyMod(JSON.parse(e.data)); } catch { /* ignora */ } };
      }

      // ---- Estado de conexión + re-siembra si el relay se reinició con el disco vacío
      let reseedTimer;
      gun.on('hi', () => {
        conn.value = 'online';
        clearTimeout(reseedTimer);
        reseedTimer = setTimeout(reseed, 1500);
      });
      gun.on('bye', () => { conn.value = 'offline'; });
      setTimeout(() => { if (conn.value === 'connecting') conn.value = 'offline'; }, 5000);

      function reseed() {
        // El proyector/moderador re-siembra todo; cada asistente, solo lo suyo.
        const ids = route === 'audience' ? [...mine] : Object.keys(questions);
        ids.forEach((id) => {
          const q = questions[id];
          if (q) qNode.get(id).put({ text: q.text, ts: q.ts });
        });
        Object.keys(votes).forEach((qid) => {
          if (votes[qid][clientId]) voteNode.get(qid).get(clientId).put(1);
        });
      }

      const connLabel = computed(() => ({
        online: 'En vivo',
        offline: 'Sin conexión · guardado local',
        connecting: 'Conectando…',
      })[conn.value]);

      // ---- Derivados
      const all = computed(() => Object.values(questions)
        .map((q) => ({ ...q, ...NO_MOD, ...(mod.items[q.id] || {}) }))
        .sort((a, b) => a.ts - b.ts));
      const codes = computed(() => {
        const m = {};
        all.value.forEach((q, i) => { m[q.id] = 'C-' + String(i + 1).padStart(3, '0'); });
        return m;
      });
      const visible = computed(() => all.value.filter((q) => !q.hidden));
      const voteCount = (id) => Object.keys(votes[id] || {}).length;
      const hasVoted = (id) => !!(votes[id] && votes[id][clientId]);

      const audienceList = computed(() => {
        const list = [...visible.value];
        if (sort.value === 'top') return list.sort((a, b) => voteCount(b.id) - voteCount(a.id) || b.ts - a.ts);
        return list.sort((a, b) => b.ts - a.ts);
      });

      const hiddenCount = computed(() => all.value.length - visible.value.length);
      const totalVotes = computed(() => visible.value.reduce((n, q) => n + voteCount(q.id), 0));

      // ---- Pizarra del proyector: destacadas primero, luego las más recientes.
      // La destacada más reciente ocupa dos casillas y se mantiene en todas las páginas.
      const boardOrder = computed(() => [
        ...visible.value.filter((q) => q.featured).sort((a, b) => b.featured - a.featured),
        ...visible.value.filter((q) => !q.featured).sort((a, b) => b.ts - a.ts),
      ]);
      const spotlightId = computed(() => {
        const first = boardOrder.value[0];
        return first && first.featured ? first.id : null;
      });
      const boardRest = computed(() => (spotlightId.value ? boardOrder.value.slice(1) : boardOrder.value));
      const perPage = computed(() => CONFIG.boardSlots - (spotlightId.value ? 2 : 0));
      const boardPages = computed(() => Math.max(1, Math.ceil(boardRest.value.length / perPage.value)));
      const boardItems = computed(() => {
        const p = Math.min(boardPage.value, boardPages.value - 1);
        const items = boardRest.value.slice(p * perPage.value, (p + 1) * perPage.value);
        return spotlightId.value ? [boardOrder.value[0], ...items] : items;
      });
      watch(boardPages, (n) => { if (boardPage.value >= n) boardPage.value = 0; });
      watch(() => visible.value.length, (n, old) => { if (n > old && !openedId.value) boardPage.value = 0; }); // lo nuevo, a la vista

      // ---- Tarjeta abierta (proyector): texto completo; pausa la rotación mientras está abierta
      const openedNote = computed(() => visible.value.find((q) => q.id === openedId.value) || null);
      const openNote = (q) => { openedId.value = q.id; };
      const closeNote = () => { openedId.value = null; };
      const openSize = (q) => (q.text.length > 180 ? 'sz-l' : q.text.length > 90 ? 'sz-m' : 'sz-s');

      const MOD_FILTERS = {
        visible: (q) => !q.hidden,
        featured: (q) => !q.hidden && q.featured,
        hidden: (q) => q.hidden,
        all: () => true,
      };
      const modCounts = computed(() => Object.fromEntries(
        Object.entries(MOD_FILTERS).map(([k, f]) => [k, all.value.filter(f).length])));
      const modList = computed(() => all.value
        .filter(MOD_FILTERS[modFilter.value])
        .sort((a, b) => (b.featured - a.featured) || voteCount(b.id) - voteCount(a.id) || b.ts - a.ts));

      // ---- Envío
      const draftFlagged = computed(() => QA.Profanity.has(draft.value));
      const canSubmit = computed(() => mod.open && draft.value.trim().length >= QA.LIMITS.minLength && !draftFlagged.value);
      const profanityMsg = 'Tu conclusión contiene lenguaje no apropiado para el evento. Reformúlala, por favor.';

      let noticeTimer;
      function submit() {
        error.value = '';
        notice.value = '';
        if (!mod.open) { error.value = 'La pizarra está cerrada a nuevas conclusiones en este momento.'; return; }
        const text = QA.cleanText(draft.value);
        if (text.length < QA.LIMITS.minLength) { error.value = 'Escribe una conclusión un poco más completa.'; return; }
        if (text.length > QA.LIMITS.maxLength) { error.value = `Máximo ${QA.LIMITS.maxLength} caracteres.`; return; }
        if (QA.Profanity.has(text)) { error.value = profanityMsg; return; }
        const wait = store.get('qa:last', 0) + CONFIG.cooldownMs - Date.now();
        if (wait > 0) { error.value = `Espera ${Math.ceil(wait / 1000)} s antes de publicar otra conclusión.`; return; }
        if (visible.value.some((q) => q.text.toLowerCase() === text.toLowerCase())) {
          error.value = 'Esa conclusión ya está en la pizarra. Puedes marcar «Coincido».';
          return;
        }

        const ts = Date.now();
        const id = QA.questionId(text, ts);
        qNode.get(id).put({ text, ts }, (ack) => {
          if (!ack || !ack.err) return;
          // El servidor la rechazó (p. ej. se cerró la recepción justo ahora).
          rejected.add(id);
          store.set('qa:rejected', [...rejected].slice(-50));
          delete questions[id];
          notice.value = '';
          error.value = 'El servidor no aceptó la conclusión. Inténtalo de nuevo más tarde.';
        });
        mine.add(id);
        store.set('qa:mine', [...mine]);
        store.set('qa:last', ts);
        draft.value = '';
        notice.value = 'Conclusión publicada. Ya está en la pizarra.';
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { notice.value = ''; }, 4000);
      }

      function toggleVote(q) {
        voteNode.get(q.id).get(clientId).put(hasVoted(q.id) ? 0 : 1);
      }

      // ---- Acciones de moderación (requieren sesión con PIN; el servidor lo verifica)
      let toastTimer;
      const flash = (m) => {
        toast.value = m;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.value = ''; }, 3500);
      };
      async function modAction(action, id) {
        try {
          const r = await fetch('/api/mod', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, id }),
          });
          if (r.status === 401) { location.reload(); return; } // sesión caducada → pantalla de PIN
          if (!r.ok) flash((await r.json().catch(() => ({}))).error || 'No se pudo aplicar el cambio.');
        } catch {
          flash('Sin conexión con el servidor.');
        }
      }
      const feature = (q) => modAction('feature', q.id);
      const hide = (q) => { if (route !== 'projector' || confirm('¿Ocultar esta conclusión?')) modAction('hide', q.id); };
      const unhide = (q) => modAction('unhide', q.id);
      const toggleOpen = () => modAction(mod.open ? 'close' : 'open');
      async function logout() {
        await fetch('/api/logout', { method: 'POST' }).catch(() => {});
        location.href = '/';
      }

      let idleTimer;
      function pokeControls() {
        controlsVisible.value = true;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { controlsVisible.value = false; }, 3000);
      }

      function toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
      }
      window.addEventListener('keydown', (e) => {
        if (route !== 'projector') return;
        if (e.key === 'Escape' && openedId.value) { closeNote(); return; }
        if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) toggleFullscreen();
      });

      // ---- QR
      function renderQR() {
        nextTick(() => {
          const el = qrEl.value;
          if (!el || !window.QRCode) return;
          el.innerHTML = '';
          new QRCode(el, {
            text: audienceUrl,
            width: 512,
            height: 512,
            colorDark: '#0e0f11',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M,
          });
        });
      }

      onMounted(() => {
        if (route === 'projector') {
          renderQR();
          pokeControls();
          setInterval(() => {
            if (boardPages.value > 1 && !openedId.value) boardPage.value = (boardPage.value + 1) % boardPages.value;
          }, CONFIG.boardRotateMs);
        }
        setInterval(() => { now.value = Date.now(); }, 15000);
      });

      // ---- Utilidades de formato
      const pad = (n, w) => String(n).padStart(w, '0');
      const codeOf = (id) => codes.value[id] || 'Q-···';
      const ago = (ts) => {
        const s = Math.max(0, Math.round((now.value - ts) / 1000));
        if (s < 45) return 'ahora';
        const m = Math.round(s / 60);
        if (m < 60) return `hace ${m} min`;
        const h = Math.round(m / 60);
        if (h < 24) return `hace ${h} h`;
        return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
      };
      const clock = computed(() => new Date(now.value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }));
      const noteSize = (q) => (q.text.length > 180 ? 'sz-l' : q.text.length > 90 ? 'sz-m' : 'sz-s');
      const setSort = (s) => { sort.value = s; store.set('qa:sort', s); };

      return {
        route,
        maxLength: QA.LIMITS.maxLength,
        audienceUrl,
        audienceUrlShort: audienceUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        mod, conn, connLabel, draft, error, notice, toast, sort, modFilter, controlsVisible, qrEl, clock,
        visible, audienceList, hiddenCount, totalVotes, modCounts, modList,
        boardItems, boardPage, boardPages, spotlightId, openedNote, openNote, closeNote, openSize,
        draftFlagged, canSubmit, profanityMsg,
        submit, toggleVote, voteCount, hasVoted,
        feature, hide, unhide, toggleOpen, logout, pokeControls, toggleFullscreen,
        pad, codeOf, ago, noteSize, setSort,
        censor: QA.Profanity.censor,
      };
    },
  }).mount('#app');
})();
