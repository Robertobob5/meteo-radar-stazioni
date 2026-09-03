/* ════════════════════════════════════════════════════════════════
   Meteo Radar · il PONTE delle stazioni vicine (v65 · ponte 2)

   Gira su GitHub, non nell'app. Ogni giro:
     1. rinnova il gettone Netatmo coi codici segreti (che restano su
        GitHub: nell'app non entra nessun segreto);
     2. chiede a Netatmo le stazioni pubbliche di tutta l'Italia, a
        mattonelle: dove ce ne sono tante la mattonella si spezza in
        quattro, dove non ce n'è nessuna la si salta per un giorno;
     3. chiede agli aeroporti italiani l'ultima osservazione ufficiale
        (METAR, dal servizio pubblico dell'aeronautica americana);
     4. scrive file di sole letture, per cella di 1°: l'app scarica solo
        la cella dove sta, pochi KB.

   Uso: node ponte_stazioni.mjs   (dalla cartella del repository)
   Variabili: NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET,
              NETATMO_REFRESH_TOKEN (solo la prima volta: poi il gettone
              rinnovato vive cifrato in stato/netatmo.enc)

   Limiti rispettati: Netatmo concede ~500 richieste l'ora per account.
   Qui il tetto è 150 chiamate a giro, con tre giri l'ora al massimo.

   PONTE 2 (3 settembre 2026), imparato dal primo giro vero:
   · Netatmo risponde 503 a sprazzi: ogni mattonella si ritenta fino a
     tre volte con una pausa crescente, e ogni chiamata ha un tempo massimo.
   · Netatmo restituisce stazioni anche ben fuori dal rettangolo chiesto
     e, dove è denso, TAGLIA la risposta. Perciò si spezza una mattonella
     contando le stazioni DENTRO il suo rettangolo (non quante ne arrivano),
     e si scende fino a 0,25° nelle zone più fitte.
   · L'albero delle mattonelle si ricorda da un giro all'altro: chi era da
     spezzare non si richiede più, si va dritti alle sue foglie.
   · Il rettangolo dell'Italia contiene Svizzera, Francia, Austria, Croazia
     e Tunisia: le mattonelle che non toccano l'Italia (con 25 km di
     margine, il raggio della carta) non si chiedono affatto.
   ════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ITALIA = { latMin: 35.4, latMax: 47.2, lonMin: 6.5, lonMax: 18.7 };
export const MATTONELLA = 2;           /* gradi: la mattonella di partenza */
export const MATTONELLA_MIN = 0.2;     /* sotto, non si spezza più (0,25° è l'ultimo gradino) */
export const SOGLIA_DENTRO = 350;      /* stazioni DENTRO il rettangolo: da qui in su si spezza */
export const RISPOSTA_SOSPETTA = 1500; /* una risposta così grande può essere stata tagliata: si spezza */
export const TETTO_STAZIONI = SOGLIA_DENTRO;   /* nome vecchio, tenuto per chi lo importa */
export const TETTO_CHIAMATE = 150;     /* per giro, ritentativi compresi */
export const TENTATIVI = 3;            /* per mattonella */
export const PAUSE_MS = [3000, 10000]; /* fra un tentativo e l'altro */
export const TEMPO_MAX_MS = 25000;     /* per chiamata */
export const VUOTA_VALIDA_MS = 24 * 3600 * 1000;   /* una mattonella vuota si ricontrolla dopo un giorno */
export const VERSIONE_MEMORIA = 2;     /* cambia → mattonelle.json vecchio si butta e si ricomincia */
export const MARGINE_ITALIA = 0.35;    /* gradi oltre coste e confini: ~25 km, il raggio della carta */

/* ————————————————— l'Italia, a grandi linee ————————————————— */
/* Poligoni grossolani, [lat, lon]: terraferma, Sicilia, Sardegna e le isole
   minori come quadratini. Servono solo a dire se una mattonella tocca
   l'Italia (allargata del margine): la precisione del chilometro non conta. */
export const ITALIA_POLIGONI = [
  [[43.78, 7.53], [44.42, 6.90], [44.93, 6.73], [45.25, 6.90], [45.68, 6.88], [45.83, 6.86], [45.87, 7.17],
   [45.98, 7.66], [45.93, 7.87], [46.25, 8.03], [46.30, 8.45], [46.05, 8.70], [45.83, 9.03], [46.05, 9.30],
   [46.50, 9.45], [46.35, 10.05], [46.60, 10.20], [46.85, 10.45], [46.95, 11.00], [47.00, 11.50], [47.09, 12.19],
   [46.80, 12.50], [46.65, 13.40], [46.55, 13.70], [46.20, 13.65], [45.75, 13.60], [45.60, 13.90], [45.45, 12.35],
   [44.95, 12.55], [44.30, 12.35], [44.06, 12.57], [43.62, 13.52], [42.46, 14.21], [42.00, 15.00], [41.90, 16.20],
   [41.60, 15.90], [41.13, 16.87], [40.64, 17.95], [40.15, 18.50], [39.80, 18.36], [40.05, 17.98], [40.47, 17.24],
   [40.37, 16.80], [39.75, 16.50], [39.08, 17.13], [38.90, 17.10], [38.70, 16.55], [37.92, 16.06], [38.10, 15.65],
   [38.25, 15.70], [38.62, 15.83], [38.90, 16.20], [39.36, 16.04], [39.99, 15.70], [40.03, 15.28], [40.68, 14.77],
   [40.55, 14.20], [40.84, 14.25], [41.20, 13.57], [41.22, 13.05], [41.45, 12.62], [41.77, 12.23], [42.09, 11.79],
   [42.40, 11.10], [42.93, 10.50], [43.55, 10.30], [44.10, 9.80], [44.40, 8.90], [44.30, 8.48], [43.88, 8.03]],
  [[38.20, 15.55], [38.27, 15.24], [38.04, 14.02], [38.12, 13.36], [38.02, 12.50], [37.80, 12.43], [37.65, 12.60],
   [37.50, 13.08], [37.29, 13.58], [37.10, 13.94], [37.07, 14.25], [36.72, 14.85], [36.68, 15.13], [37.07, 15.28],
   [37.50, 15.09], [37.85, 15.29]],
  [[41.24, 9.19], [40.92, 9.50], [40.50, 9.83], [39.94, 9.70], [39.10, 9.52], [39.20, 9.10], [38.87, 8.65],
   [39.15, 8.30], [39.90, 8.50], [40.56, 8.16], [40.95, 8.22], [40.84, 8.40], [40.91, 8.71]],
  [[38.55, 14.80], [38.55, 15.10], [38.35, 15.10], [38.35, 14.80]],      /* Eolie */
  [[36.85, 11.90], [36.85, 12.05], [36.72, 12.05], [36.72, 11.90]],      /* Pantelleria */
  [[35.55, 12.50], [35.55, 12.70], [35.45, 12.70], [35.45, 12.50]],      /* Lampedusa */
  [[42.16, 15.45], [42.16, 15.55], [42.08, 15.55], [42.08, 15.45]],      /* Tremiti */
  [[38.75, 13.15], [38.75, 13.22], [38.68, 13.22], [38.68, 13.15]],      /* Ustica */
  [[42.85, 10.05], [42.85, 10.45], [42.70, 10.45], [42.70, 10.05]]       /* Elba */
];

function dentroPoligono(la, lo, poligono) {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [la1, lo1] = poligono[i], [la2, lo2] = poligono[j];
    if ((lo1 > lo) !== (lo2 > lo) && la < (la2 - la1) * (lo - lo1) / (lo2 - lo1) + la1) dentro = !dentro;
  }
  return dentro;
}
function segmentiSiIncrociano(a, b, c, d) {
  const or = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
  return or(a, b, c) !== or(a, b, d) && or(c, d, a) !== or(c, d, b);
}
/** Il rettangolo (allargato del margine) tocca l'Italia? */
export function toccaItalia(m, margine = MARGINE_ITALIA, poligoni = ITALIA_POLIGONI) {
  const r = { latMin: m.latMin - margine, latMax: m.latMax + margine, lonMin: m.lonMin - margine, lonMax: m.lonMax + margine };
  const angoli = [[r.latMin, r.lonMin], [r.latMin, r.lonMax], [r.latMax, r.lonMax], [r.latMax, r.lonMin]];
  const lati = [[angoli[0], angoli[1]], [angoli[1], angoli[2]], [angoli[2], angoli[3]], [angoli[3], angoli[0]]];
  for (const p of poligoni) {
    for (const [la, lo] of p)
      if (la >= r.latMin && la <= r.latMax && lo >= r.lonMin && lo <= r.lonMax) return true;   /* un vertice dentro */
    for (const a of angoli) if (dentroPoligono(a[0], a[1], p)) return true;                 /* un angolo dentro l'Italia */
    for (let i = 0, j = p.length - 1; i < p.length; j = i++)
      for (const [s1, s2] of lati) if (segmentiSiIncrociano(p[i], p[j], s1, s2)) return true; /* i bordi si incrociano */
  }
  return false;
}
export const AEROPORTI = [
  'LIBR','LIBN','LIBG','LIBD','LIBV','LIBA','LIBP','LIBC','LICA','LICR','LICC','LICJ','LICT','LICD','LICG','LICB','LICZ',
  'LIEE','LIEO','LIEA','LIEB','LIRN','LIRI','LIRA','LIRF','LIRU','LIRQ','LIRP','LIRJ','LIRZ','LIRL','LIRM','LIRE','LIRV',
  'LIPE','LIPX','LIPZ','LIPH','LIPQ','LIPY','LIPR','LIPO','LIPB','LIPK','LIPU','LIPA','LIPS','LIPL','LIPI','LIPD',
  'LIML','LIMC','LIME','LIMF','LIMJ','LIMZ','LIMW','LIMP','LIMG'
];

/* ————————————————— attrezzi ————————————————— */

const dir = (radice, ...p) => path.join(radice, ...p);
const scrivi = (file, dati) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(dati)); };
const leggi = (file, altrimenti) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return altrimenti; } };
const arrotonda = (v, d) => Number.isFinite(v) ? Number(v.toFixed(d)) : null;

/* il gettone di rinnovo si conserva cifrato: la chiave è il client secret,
   che sta solo nei segreti di GitHub. Il file può stare in un repository
   pubblico senza che nessuno ci legga dentro. */
export function cifra(testo, segreto) {
  const chiave = crypto.createHash('sha256').update(String(segreto)).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chiave, iv);
  const dati = Buffer.concat([c.update(String(testo), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dati]).toString('base64');
}
export function decifra(b64, segreto) {
  const chiave = crypto.createHash('sha256').update(String(segreto)).digest();
  const tutto = Buffer.from(String(b64), 'base64');
  const iv = tutto.subarray(0, 12), tag = tutto.subarray(12, 28), dati = tutto.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', chiave, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(dati), d.final()]).toString('utf8');
}

/* ————————————————— Netatmo: il gettone ————————————————— */

export async function gettone(amb, radice, chiama) {
  const id = amb.NETATMO_CLIENT_ID, segreto = amb.NETATMO_CLIENT_SECRET;
  if (!id || !segreto) throw new Error('mancano NETATMO_CLIENT_ID / NETATMO_CLIENT_SECRET');
  const fileStato = dir(radice, 'stato', 'netatmo.enc');
  let rinnovo = null;
  try { rinnovo = decifra(fs.readFileSync(fileStato, 'utf8'), segreto); } catch (_) { rinnovo = null; }
  if (!rinnovo) rinnovo = amb.NETATMO_REFRESH_TOKEN || null;
  if (!rinnovo) throw new Error('manca il refresh token (NETATMO_REFRESH_TOKEN, o stato/netatmo.enc)');

  const corpo = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rinnovo, client_id: id, client_secret: segreto });
  const r = await chiama('https://api.netatmo.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo.toString() });
  if (!r.ok) throw new Error('Netatmo non rinnova il gettone: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  if (!j.access_token) throw new Error('risposta senza access_token');
  /* Netatmo può restituire un refresh token NUOVO e invalidare il vecchio:
     va conservato subito, altrimenti al giro dopo si resta chiusi fuori */
  if (j.refresh_token && j.refresh_token !== rinnovo) {
    fs.mkdirSync(path.dirname(fileStato), { recursive: true });
    fs.writeFileSync(fileStato, cifra(j.refresh_token, segreto));
  } else if (!fs.existsSync(fileStato)) {
    fs.mkdirSync(path.dirname(fileStato), { recursive: true });
    fs.writeFileSync(fileStato, cifra(rinnovo, segreto));
  }
  return j.access_token;
}

/* ————————————————— Netatmo: le stazioni ————————————————— */

/** Da una stazione come la manda Netatmo a una riga snella per l'app. */
export function snellisci(s) {
  try {
    const loc = s.place && s.place.location;
    if (!Array.isArray(loc) || loc.length < 2) return null;
    const lo = Number(loc[0]), la = Number(loc[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    const fuori = { id: String(s._id || ''), la: arrotonda(la, 4), lo: arrotonda(lo, 4),
                    alt: arrotonda(Number(s.place.altitude), 0), citta: s.place.city || '' };
    const misure = s.measures || {};
    for (const k of Object.keys(misure)) {
      const m = misure[k] || {};
      if (m.res && Array.isArray(m.type)) {
        /* modulo con serie: res = { "<ts>": [v1, v2…] } — si prende l'ultimo */
        const tss = Object.keys(m.res).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
        if (!tss.length) continue;
        const valori = m.res[String(tss[0])] || [];
        m.type.forEach((tipo, i) => {
          const v = Number(valori[i]);
          if (!Number.isFinite(v)) return;
          if (tipo === 'temperature' && fuori.t === undefined) { fuori.t = arrotonda(v, 1); fuori.ts = tss[0]; }
          if (tipo === 'humidity' && fuori.um === undefined) fuori.um = Math.round(v);
          if (tipo === 'pressure' && fuori.p === undefined) fuori.p = arrotonda(v, 1);
        });
      }
      if (m.rain_60min !== undefined || m.rain_live !== undefined) {
        const r1 = Number(m.rain_60min), rl = Number(m.rain_live);
        if (Number.isFinite(r1)) fuori.pio = arrotonda(r1, 1);
        else if (Number.isFinite(rl)) fuori.pio = arrotonda(rl, 1);
        if (Number.isFinite(Number(m.rain_timeutc))) fuori.tsp = Number(m.rain_timeutc);
      }
      if (m.wind_strength !== undefined) {
        const w = Number(m.wind_strength), g = Number(m.gust_strength), a = Number(m.wind_angle);
        if (Number.isFinite(w)) fuori.vento = Math.round(w);
        if (Number.isFinite(g)) fuori.raff = Math.round(g);
        if (Number.isFinite(a)) fuori.dir = Math.round(a);
        if (Number.isFinite(Number(m.wind_timeutc))) fuori.tsv = Number(m.wind_timeutc);
      }
    }
    if (fuori.t === undefined) return null;          /* senza temperatura non serve a niente */
    return fuori;
  } catch (_) { return null; }
}

export const attendi = ms => new Promise(r => setTimeout(r, ms));

/** Una mattonella: fino a TENTATIVI chiamate, con pausa crescente sui 5xx,
 *  sulla rete che cade e sul tempo scaduto. Un 4xx non si ritenta; 401/403/429
 *  fermano il giro (gettone o quota: insistere peggiora le cose).
 *  Restituisce { grezze, tentativi }; l'errore lanciato porta e.tentativi. */
async function mattonella(tok, m, chiama, pausa = attendi) {
  const u = new URL('https://api.netatmo.com/api/getpublicdata');
  u.searchParams.set('lat_ne', m.latMax.toFixed(3)); u.searchParams.set('lon_ne', m.lonMax.toFixed(3));
  u.searchParams.set('lat_sw', m.latMin.toFixed(3)); u.searchParams.set('lon_sw', m.lonMin.toFixed(3));
  u.searchParams.set('required_data', 'temperature');
  u.searchParams.set('filter', 'false');
  let ultimo = null;
  for (let tentativo = 1; tentativo <= TENTATIVI; tentativo++) {
    let r;
    try {
      r = await chiama(u.toString(), { headers: { Authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(TEMPO_MAX_MS) });
    } catch (e) {
      ultimo = new Error(/abort|timeout/i.test(String(e && e.name) + String(e && e.message)) ? 'tempo scaduto' : 'rete: ' + (e && e.message));
      ultimo.tentativi = tentativo;
      if (tentativo < TENTATIVI) await pausa(PAUSE_MS[tentativo - 1]);
      continue;
    }
    if (r.status === 429 || r.status === 403 || r.status === 401) {
      const e = new Error(r.status === 429 ? 'Netatmo: troppe richieste (429)' : 'Netatmo: accesso negato (' + r.status + ')');
      e.stop = true; e.tentativi = tentativo; throw e;
    }
    if (r.ok) {
      const j = await r.json();
      return { grezze: Array.isArray(j.body) ? j.body : [], tentativi: tentativo };
    }
    ultimo = new Error('getpublicdata HTTP ' + r.status);
    ultimo.tentativi = tentativo;
    if (r.status < 500) break;                                   /* 4xx: ritentare non serve */
    if (tentativo < TENTATIVI) await pausa(PAUSE_MS[tentativo - 1]);
  }
  throw ultimo;
}

const chiaveM = m => [m.latMin, m.lonMin, m.latMax - m.latMin].map(v => v.toFixed(2)).join('_');
const figli = m => {
  const mezzoLa = (m.latMin + m.latMax) / 2, mezzoLo = (m.lonMin + m.lonMax) / 2;
  return [
    { latMin: m.latMin, lonMin: m.lonMin, latMax: mezzoLa, lonMax: mezzoLo },
    { latMin: m.latMin, lonMin: mezzoLo, latMax: mezzoLa, lonMax: m.lonMax },
    { latMin: mezzoLa, lonMin: m.lonMin, latMax: m.latMax, lonMax: mezzoLo },
    { latMin: mezzoLa, lonMin: mezzoLo, latMax: m.latMax, lonMax: m.lonMax }];
};
const dentroRettangolo = (g, m) => {
  const loc = g && g.place && g.place.location;
  if (!Array.isArray(loc) || loc.length < 2) return false;
  const lo = Number(loc[0]), la = Number(loc[1]);
  return la >= m.latMin && la < m.latMax && lo >= m.lonMin && lo < m.lonMax;
};
export const mattonelleDiPartenza = () => {
  const fuori = [];
  for (let la = ITALIA.latMin; la < ITALIA.latMax; la += MATTONELLA)
    for (let lo = ITALIA.lonMin; lo < ITALIA.lonMax; lo += MATTONELLA)
      fuori.push({ latMin: la, lonMin: lo, latMax: Math.min(la + MATTONELLA, ITALIA.latMax), lonMax: Math.min(lo + MATTONELLA, ITALIA.lonMax) });
  return fuori;
};

/** Tutte le stazioni d'Italia, a mattonelle adattive e con un tetto di chiamate.
 *  L'albero delle mattonelle vive in mattonelle.json: le spezzate non si
 *  richiedono (si scende ai figli), le vuote si saltano per un giorno, quelle
 *  che non toccano l'Italia non si guardano nemmeno. */
export async function raccogli(tok, radice, chiama, adesso = Date.now(), registro = console, pausa = attendi) {
  const fileMatt = dir(radice, 'mattonelle.json');
  let memoria = leggi(fileMatt, {});
  if (!memoria || memoria._versione !== VERSIONE_MEMORIA) memoria = { _versione: VERSIONE_MEMORIA };

  const coda = [];
  let fuori = 0;
  const scendi = m => {
    if (!toccaItalia(m)) { fuori++; return; }
    const nota = memoria[chiaveM(m)];
    if (nota && nota.spezzata) { figli(m).forEach(scendi); return; }      /* già imparato: dritti alle foglie */
    coda.push(m);
  };
  mattonelleDiPartenza().forEach(scendi);

  const stazioni = new Map();
  const mattonelleFallite = [];
  let chiamate = 0, spezzate = 0, saltate = 0, ritentate = 0, fallite = 0;
  while (coda.length) {
    const m = coda.shift();
    const k = chiaveM(m);
    const nota = memoria[k];
    if (nota && nota.dentro === 0 && adesso - nota.ts < VUOTA_VALIDA_MS) { saltate++; continue; }   /* mare, o montagna deserta */
    if (chiamate >= TETTO_CHIAMATE) { registro.log('  · tetto di ' + TETTO_CHIAMATE + ' chiamate raggiunto: il resto al prossimo giro'); break; }
    let esito;
    try { esito = await mattonella(tok, m, chiama, pausa); }
    catch (e) {
      chiamate += e.tentativi || 1;
      if (e.stop) { mattonelleFallite.push(m); registro.log('  ✘ ' + e.message + ': mi fermo qui'); break; }
      fallite++;
      mattonelleFallite.push(m);
      registro.log('  ⚠ ' + k + ': ' + e.message + (e.tentativi > 1 ? ' (dopo ' + e.tentativi + ' tentativi)' : ''));
      continue;
    }
    chiamate += esito.tentativi;
    if (esito.tentativi > 1) ritentate++;
    const grezze = esito.grezze;
    const dentro = grezze.filter(g => dentroRettangolo(g, m)).length;
    const lato = m.latMax - m.latMin;
    if ((dentro >= SOGLIA_DENTRO || grezze.length >= RISPOSTA_SOSPETTA) && lato / 2 >= MATTONELLA_MIN) {
      /* fitta (o risposta sospetta di taglio): si spezza in quattro e si rifà subito */
      spezzate++;
      coda.unshift(...figli(m).filter(f => toccaItalia(f) || (fuori++, false)));
      memoria[k] = { n: grezze.length, dentro, ts: adesso, spezzata: 1 };
    } else {
      memoria[k] = { n: grezze.length, dentro, ts: adesso };
    }
    /* le stazioni arrivate si tengono sempre, anche da una mattonella che si spezza:
       sono letture vere, e i figli aggiungeranno quelle che il taglio ha lasciato fuori */
    for (const g of grezze) {
      const s = snellisci(g);
      if (s && s.id) stazioni.set(s.id, s);
    }
  }
  scrivi(fileMatt, memoria);
  /* chi è rimasto in coda per il tetto o per lo stop non è stato letto: vale come fallito,
     così le sue letture del giro prima vengono riportate */
  for (const m of coda) mattonelleFallite.push(m);
  return { stazioni: [...stazioni.values()], chiamate, spezzate, saltate, fuori, ritentate, fallite, mattonelleFallite };
}

/* ————————————————— il riporto delle letture del giro prima ————————————————— */

/** Le stazioni già pubblicate (celle/*.json nella cartella): mappa id → stazione. */
export function lettureprecedenti(radice) {
  const fuori = new Map();
  const cartella = dir(radice, 'celle');
  let nomi = [];
  try { nomi = fs.readdirSync(cartella).filter(n => n.endsWith('.json')); } catch (_) { return fuori; }
  for (const n of nomi) {
    const c = leggi(dir(cartella, n), null);
    for (const st of (c && Array.isArray(c.stazioni) ? c.stazioni : [])) if (st && st.id) fuori.set(st.id, st);
  }
  return fuori;
}

/** Dentro le mattonelle fallite si rimettono le stazioni del giro prima (con la LORO ora
 *  di lettura: se è vecchia, l'app la scarta da sola). Torna quante ne ha riportate. */
export function riporta(stazioni, mattonelleFallite, precedenti) {
  if (!mattonelleFallite.length || !precedenti.size) return 0;
  const presenti = new Set(stazioni.map(s => s.id));
  let riportate = 0;
  for (const st of precedenti.values()) {
    if (presenti.has(st.id)) continue;
    const la = Number(st.la), lo = Number(st.lo);
    if (!mattonelleFallite.some(m => la >= m.latMin && la < m.latMax && lo >= m.lonMin && lo < m.lonMax)) continue;
    stazioni.push(st); presenti.add(st.id); riportate++;
  }
  return riportate;
}

/* ————————————————— gli aeroporti (METAR) ————————————————— */

export function snellisciMetar(m) {
  try {
    const la = Number(m.lat), lo = Number(m.lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    const nodi = v => Number.isFinite(Number(v)) ? Math.round(Number(v) * 1.852) : null;   /* nodi → km/h */
    const ts = Number.isFinite(Number(m.obsTime)) ? Number(m.obsTime)
             : (m.reportTime ? Math.round(Date.parse(String(m.reportTime).replace(' ', 'T') + 'Z') / 1000) : null);
    return {
      icao: String(m.icaoId || ''), nome: String(m.name || m.icaoId || '').replace(/,.*$/, '').trim(),
      la: arrotonda(la, 4), lo: arrotonda(lo, 4),
      t: Number.isFinite(Number(m.temp)) ? arrotonda(Number(m.temp), 1) : null,
      td: Number.isFinite(Number(m.dewp)) ? arrotonda(Number(m.dewp), 1) : null,
      dir: Number.isFinite(Number(m.wdir)) ? Math.round(Number(m.wdir)) : null,
      vento: nodi(m.wspd), raff: nodi(m.wgst),
      vis: m.visib !== undefined && m.visib !== null ? String(m.visib) : null,
      wx: m.wxString ? String(m.wxString) : '',
      nubi: Array.isArray(m.clouds) && m.clouds.length ? String(m.clouds[0].cover || '') : '',
      ts, grezzo: m.rawOb ? String(m.rawOb).slice(0, 160) : ''
    };
  } catch (_) { return null; }
}

export async function aeroporti(chiama, registro = console) {
  const u = 'https://aviationweather.gov/api/data/metar?ids=' + AEROPORTI.join(',') + '&format=json';
  try {
    const r = await chiama(u, { headers: { 'User-Agent': 'MeteoRadar-ponte/65 (videopromo2000@gmail.com)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map(snellisciMetar).filter(Boolean);
  } catch (e) { registro.log('  ⚠ aeroporti: ' + e.message); return []; }
}

/* ————————————————— la scrittura ————————————————— */

export function scriviTutto(radice, stazioni, aerop, meta, adesso = Date.now()) {
  const celle = {};
  for (const s of stazioni) {
    const k = Math.floor(s.la) + '_' + Math.floor(s.lo);
    (celle[k] = celle[k] || []).push(s);
  }
  /* si azzera la cartella, così una cella svuotata non resta con dati vecchi */
  const cartella = dir(radice, 'celle');
  fs.rmSync(cartella, { recursive: true, force: true });
  const conteggi = {};
  for (const k of Object.keys(celle)) { scrivi(dir(cartella, k + '.json'), { aggiornato: adesso, stazioni: celle[k] }); conteggi[k] = celle[k].length; }
  if (aerop.length) scrivi(dir(radice, 'aeroporti.json'), { aggiornato: adesso, aeroporti: aerop });
  scrivi(dir(radice, 'indice.json'), Object.assign({ aggiornato: adesso, stazioni: stazioni.length, aeroporti: aerop.length, celle: conteggi }, meta));
  return conteggi;
}

/* ————————————————— il giro completo ————————————————— */

export async function giro(amb = process.env, radice = process.cwd(), chiama = fetch, registro = console, pausa = attendi) {
  const t0 = Date.now();
  registro.log('Ponte stazioni · ' + new Date().toISOString());
  const tok = await gettone(amb, radice, chiama);
  registro.log('  ✔ gettone Netatmo rinnovato');
  const precedenti = lettureprecedenti(radice);          /* prima che scriviTutto le cancelli */
  const r = await raccogli(tok, radice, chiama, Date.now(), registro, pausa);
  registro.log('  ✔ Netatmo: ' + r.stazioni.length + ' stazioni con ' + r.chiamate + ' chiamate (' + r.spezzate + ' mattonelle spezzate, '
             + r.saltate + ' saltate perché vuote, ' + r.fuori + ' fuori dall\'Italia, ' + r.ritentate + ' ritentate, ' + r.fallite + ' fallite)');
  const riportate = riporta(r.stazioni, r.mattonelleFallite, precedenti);
  if (riportate) registro.log('  ↻ riportate ' + riportate + ' letture del giro prima nelle ' + r.mattonelleFallite.length + ' mattonelle non lette');
  let a = await aeroporti(chiama, registro);
  if (a.length) registro.log('  ✔ aeroporti: ' + a.length + ' osservazioni');
  else {
    /* il servizio degli aeroporti non ha risposto: restano le osservazioni del giro
       prima, con la LORO ora (l'app la mostra, e sa quanto sono vecchie) */
    const prima = leggi(dir(radice, 'aeroporti.json'), null);
    a = prima && Array.isArray(prima.aeroporti) ? prima.aeroporti : [];
    registro.log(a.length ? '  ↻ aeroporti: servizio muto, riportate le ' + a.length + ' osservazioni del giro prima' : '  ⚠ aeroporti: nessuna osservazione');
  }
  const conteggi = scriviTutto(radice, r.stazioni, a, { chiamate: r.chiamate, durataMs: Date.now() - t0 });
  registro.log('  ✔ scritte ' + Object.keys(conteggi).length + ' celle in ' + Math.round((Date.now() - t0) / 1000) + ' s');
  return { stazioni: r.stazioni.length, aeroporti: a.length, celle: Object.keys(conteggi).length, chiamate: r.chiamate };
}

export function stessoFile(indirizzoModulo, lanciato, piattaforma = process.platform) {
  if (!lanciato) return false;
  const vincee = piattaforma === 'win32' ? path.win32 : path.posix;
  let io; try { io = fileURLToPath(indirizzoModulo); } catch (_) { io = indirizzoModulo; }
  const chiamato = vincee.isAbsolute(lanciato) ? lanciato : vincee.resolve(lanciato);
  const pari = (a, b) => piattaforma === 'win32' ? a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase() : a === b;
  return pari(io, chiamato) || vincee.basename(chiamato).toLowerCase() === vincee.basename(io).toLowerCase();
}

if (stessoFile(import.meta.url, process.argv[1])) {
  giro().then(r => { console.log('Fatto:', JSON.stringify(r)); })
        .catch(e => { console.log('✘ ' + e.message); process.exit(1); });
}
