// Servidor: sirve el frontend, actúa como relay Gun.js (WebSocket en /gun) y protege la moderación.
// - Las preguntas y votos viajan por Gun, pero el relay valida cada escritura (firewall).
// - Destacar / responder / ocultar / cerrar recepción solo se hace vía API con PIN de moderador.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Gun = require('gun');
const QA = require('./public/shared.js');

const PORT = process.env.PORT || 8765;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const MOD_FILE = path.join(DATA_DIR, 'moderation.json');
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ PIN
let MOD_PIN = (process.env.MOD_PIN || '').trim();
if (MOD_PIN.length < 4) {
  MOD_PIN = String(crypto.randomInt(100000, 1000000));
  console.warn(`\n⚠  MOD_PIN no está definido. PIN temporal de esta ejecución: ${MOD_PIN}\n`);
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const pinTag = crypto.createHash('sha256').update(MOD_PIN).digest('hex').slice(0, 16); // cambiar el PIN invalida sesiones

const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const makeToken = () => {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${sign(`mod|${exp}|${pinTag}`)}`;
};
const validToken = (t) => {
  const [exp, sig] = String(t || '').split('.');
  return Number(exp) > Date.now() && !!sig && safeEqual(sig, sign(`mod|${exp}|${pinTag}`));
};
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
const isMod = (req) => validToken(readCookie(req, 'qa_mod'));
const cookieAttrs = (req) => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

// ----------------------------------------------------- Estado de moderación
const modState = { open: true, closedAt: 0, items: {} }; // items[id] = { featured, answered, hidden }
try { Object.assign(modState, JSON.parse(fs.readFileSync(MOD_FILE, 'utf8'))); } catch { /* primera ejecución */ }

let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(MOD_FILE, JSON.stringify(modState), (e) => e && console.error('No se pudo guardar moderación:', e.message));
  }, 300);
};

const sseClients = new Set();
const broadcast = () => {
  const payload = `data: ${JSON.stringify(modState)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
};

function applyAction(action, id) {
  if (action === 'open') { modState.open = true; modState.closedAt = 0; return true; }
  if (action === 'close') { modState.open = false; modState.closedAt = Date.now(); return true; }
  if (!QA.isValidId(id)) return false;
  const it = modState.items[id] || { featured: 0, answered: false, hidden: false };
  switch (action) {
    case 'feature': it.featured = it.featured ? 0 : Date.now(); it.answered = false; break;
    case 'answer': it.answered = !it.answered; it.featured = 0; break;
    case 'hide': it.hidden = true; it.featured = 0; break;
    case 'unhide': it.hidden = false; break;
    default: return false;
  }
  modState.items[id] = it;
  return true;
}

// ------------------------------------------------------- Firewall de Gun
// Solo se aceptan escrituras que respetan el esquema de la app. Todo lo demás se descarta.
const NS = QA.NAMESPACE;
const Q_SOUL = NS + '/questions';
const V_SOUL = NS + '/votes';
const isLink = (v, soul) => !!v && typeof v === 'object' && v['#'] === soul;
let rejected = 0;

function allowPut(soul, key, val) {
  if (typeof soul !== 'string' || typeof key !== 'string') return false;
  if (soul === NS) return (key === 'questions' && isLink(val, Q_SOUL)) || (key === 'votes' && isLink(val, V_SOUL));
  if (soul === Q_SOUL) return QA.isValidId(key) && isLink(val, `${Q_SOUL}/${key}`);
  if (soul === V_SOUL) return QA.isValidId(key) && isLink(val, `${V_SOUL}/${key}`);

  if (soul.startsWith(Q_SOUL + '/')) {
    const id = soul.slice(Q_SOUL.length + 1);
    if (!QA.isValidId(id)) return false;
    const ts = QA.tsFromId(id);
    if (ts > Date.now() + 2 * 60 * 1000) return false;           // fechas futuras
    if (key === 'ts') return val === ts;
    if (key === 'text') {
      if (!modState.open && ts >= modState.closedAt) return false; // recepción cerrada
      return QA.isValidText(val) && QA.textMatchesId(id, val);    // sin groserías y sin reescrituras
    }
    return false;
  }
  if (soul.startsWith(V_SOUL + '/')) {
    const id = soul.slice(V_SOUL.length + 1);
    return QA.isValidId(id) && QA.VOTER_RE.test(key) && (val === 0 || val === 1);
  }
  return false; // el relay no almacena datos ajenos a la app
}

Gun.on('opt', function (at) {
  if (!at.qaFirewall) {
    at.qaFirewall = true;
    at.on('put', function (msg) {
      const p = msg.put || {};
      if (allowPut(p['#'], p['.'], p[':'])) return this.to.next(msg);
      rejected++;
      if (process.env.QA_DEBUG) console.log('Escritura rechazada:', JSON.stringify(p).slice(0, 200));
      at.on('in', { '@': msg['#'], err: 'Escritura rechazada por el servidor.' });
    });
  }
  this.to.next(at);
});

// ------------------------------------------------------------------ HTTP
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use(Gun.serve);
app.use(express.json({ limit: '2kb' }));

// Rechaza peticiones de otros orígenes a la API (CSRF).
const sameOrigin = (req, res, next) => {
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido.' });
  next();
};
const requireMod = (req, res, next) => (isMod(req) ? next() : res.status(401).json({ error: 'Sesión de moderador requerida.' }));

// Vistas protegidas: sin sesión se muestra el formulario de PIN.
app.get(['/proyector', '/moderar'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, isMod(req) ? 'index.html' : 'login.html'));
});

// Login con bloqueo progresivo por IP.
const attempts = new Map();
app.post('/api/login', sameOrigin, (req, res) => {
  const ip = req.ip;
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  if (rec.until > Date.now()) {
    return res.status(429).json({ error: `Demasiados intentos. Espera ${Math.ceil((rec.until - Date.now()) / 60000)} min.` });
  }
  const pin = String((req.body && req.body.pin) || '');
  if (!safeEqual(pin, MOD_PIN)) {
    rec.fails += 1;
    if (rec.fails >= MAX_FAILS) { rec.until = Date.now() + LOCK_MS; rec.fails = 0; }
    attempts.set(ip, rec);
    const left = rec.until > Date.now() ? 0 : MAX_FAILS - rec.fails;
    return setTimeout(() => res.status(401).json({
      error: left ? `PIN incorrecto. Te quedan ${left} intentos.` : 'Demasiados intentos. Acceso bloqueado 10 min.',
    }), 600);
  }
  attempts.delete(ip);
  res.set('Set-Cookie', `qa_mod=${makeToken()}; Max-Age=${SESSION_HOURS * 3600}; ${cookieAttrs(req)}`);
  res.json({ ok: true });
});

app.post('/api/logout', sameOrigin, (req, res) => {
  res.set('Set-Cookie', `qa_mod=; Max-Age=0; ${cookieAttrs(req)}`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => res.json({ mod: isMod(req) }));

// Estado de moderación (público, solo lectura) + tiempo real por Server-Sent Events.
app.get('/api/state', (_req, res) => res.json(modState));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(modState)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
setInterval(() => sseClients.forEach((res) => res.write(': ping\n\n')), 25000);

app.post('/api/mod', sameOrigin, requireMod, (req, res) => {
  const { action, id } = req.body || {};
  if (!applyAction(action, id)) return res.status(400).json({ error: 'Acción no válida.' });
  save();
  broadcast();
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, rejected }));

app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

const server = app.listen(PORT, () => {
  console.log(`Q&A en http://localhost:${PORT}  ·  Proyector: /proyector  ·  Moderación: /moderar`);
});

// multicast desactivado: si no, el relay se mezcla con otras instancias de Gun de la red local.
Gun({ web: server, file: path.join(DATA_DIR, 'radata'), multicast: false });
