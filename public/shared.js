/* Código compartido entre navegador y servidor: filtro de lenguaje, límites e IDs.
   El servidor usa exactamente las mismas reglas para validar lo que llega por Gun. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QAShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Cambia el namespace para "limpiar" la pizarra entre eventos o sesiones.
  const NAMESPACE = 'arq-conf-2026-qa-v2';
  const LIMITS = { minLength: 8, maxLength: 280 };

  // ---------------------------------------------------- Filtro de lenguaje
  const Profanity = (() => {
    const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
    const normalize = (s) => s
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[013457@$]/g, (c) => LEET[c])
      .replace(/[^a-z]/g, '')
      .replace(/(.)\1+/g, '$1'); // "mieeerda" -> "mierda"

    // Palabras completas (se comparan por palabra para no bloquear "computadora" o "disputa").
    const WORDS = [
      'puta', 'puto', 'putas', 'putos', 'mierda', 'carajo', 'cojudo', 'cojuda', 'huevon', 'huevona',
      'weon', 'webon', 'gueon', 'chucha', 'conchatumadre', 'conchasumadre', 'ctm', 'csm', 'ptm', 'mrd', 'hdp',
      'pendejo', 'pendeja', 'cabron', 'cabrona', 'joder', 'jodete', 'gilipollas', 'cono', 'verga', 'pinga',
      'culo', 'culero', 'culera', 'maricon', 'marica', 'chingar', 'chingada', 'chingado', 'chingatumadre',
      'imbecil', 'idiota', 'estupido', 'estupida', 'malparido', 'malparida', 'hijueputa', 'hijodeputa',
      'pajero', 'pajera', 'zorra', 'mamaguevo', 'mamahuevo', 'cagada', 'cagon', 'mongolico', 'retrasado',
      'fuck', 'fucking', 'shit', 'bitch', 'asshole', 'dick', 'cunt', 'bastard', 'motherfucker', 'whore', 'slut',
    ];
    // Raíces inequívocas: se buscan también dentro de palabras y con separadores ("m.i.e.r.d.a").
    const ROOTS = ['mierd', 'fuck', 'conchatu', 'conchasu', 'hijueput', 'hijodeput', 'gilipol', 'malparid',
      'pendej', 'huevon', 'cojud', 'maricon', 'chingatu', 'motherf'];

    const EXACT = new Set(WORDS.map(normalize));
    const isBadWord = (token) => {
      const n = normalize(token);
      if (!n) return false;
      if (EXACT.has(n) || EXACT.has(n.replace(/(es|s)$/, ''))) return true;
      return ROOTS.some((r) => n.includes(r));
    };
    const TOKEN = /[\p{L}\p{N}@$]+/gu;

    return {
      has(text) {
        const tokens = text.match(TOKEN) || [];
        if (tokens.some(isBadWord)) return true;
        const joined = normalize(text);
        return ROOTS.some((r) => joined.includes(r));
      },
      // Para mostrar: reemplaza palabras prohibidas por asteriscos (defensa extra).
      censor(text) {
        return text.replace(TOKEN, (w) => (isBadWord(w) ? '*'.repeat(w.length) : w));
      },
    };
  })();

  // ------------------------------------------------ IDs ligados al contenido
  // El ID de cada pregunta incluye su fecha y un hash de su texto: así el servidor
  // puede rechazar cualquier intento de reescribir una pregunta ajena.
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  const ID_RE = /^([0-9a-z]{6,10})-([0-9a-z]{1,12})$/;
  const VOTER_RE = /^[0-9a-z]{8,24}$/;

  const questionId = (text, ts) => ts.toString(36) + '-' + cyrb53(ts + '|' + text).toString(36);
  const tsFromId = (id) => {
    const m = ID_RE.exec(id);
    return m ? parseInt(m[1], 36) : NaN;
  };
  const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
  const textMatchesId = (id, text) => {
    const ts = tsFromId(id);
    return Number.isFinite(ts) && typeof text === 'string' && questionId(text, ts) === id;
  };

  const cleanText = (s) => String(s).replace(/\s+/g, ' ').trim();
  const isValidText = (text) =>
    typeof text === 'string' &&
    text === cleanText(text) &&
    text.length >= LIMITS.minLength &&
    text.length <= LIMITS.maxLength &&
    !Profanity.has(text);

  return { NAMESPACE, LIMITS, Profanity, questionId, tsFromId, isValidId, textMatchesId, cleanText, isValidText, VOTER_RE };
});
