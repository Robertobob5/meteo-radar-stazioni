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
     e, dove è denso, TAGLIA la risposta senza dirlo. Perciò una mattonella
     si spezza sia quando dentro ci sono tante stazioni, sia quando la
     risposta è grande (da 800 in su: potrebbe essere tagliata), scendendo
     fino a 0,25° nelle zone più fitte. E ogni stazione già pubblicata che
     stavolta non arriva (taglio, 503, tetto) si riporta com'era, con la
     SUA ora di lettura, finché ha meno di tre ore: l'app usa solo le
     letture fresche, quindi non mostra mai un numero stantio.
   · L'albero delle mattonelle si ricorda da un giro all'altro: chi era da
     spezzare non si richiede più, si va dritti alle sue foglie.
   · Il rettangolo dell'Italia contiene Svizzera, Francia, Austria, Croazia
     e Tunisia: le mattonelle che non toccano l'Italia (con 25 km di
     margine, il raggio della carta) non si chiedono affatto.

   PONTE 3 (8 settembre 2026): LA REPUTAZIONE DELLE STAZIONI. A ogni giro,
   per ogni stazione, si annota quanto legge rispetto alle vicine e quanto
   la sua zona sta sopra l'aeroporto, diviso per cielo (notte · velato ·
   sole, dall'altezza del sole calcolata e dalle nubi dei METAR). Non si
   conserva la cronologia, solo somme che invecchiano. Nascono i file
   "reputazione/<cella>.json" accanto ai dati: l'app di oggi non li guarda,
   li userà la v72.2 per correggere i sensori starati e scartare quelli
   che stanno al sole. Le letture pubblicate per l'app NON cambiano.

   PONTE 3.1 (9 settembre 2026): la differenza di zona si misura per FASCE
   di altezza del sole (cuore della notte · prima notte e alba · crepuscolo ·
   sole basso · sole alto), non più come una media unica. All'alba del 9
   settembre a Ozzano il paese stava quattro gradi sopra Borgo Panigale, a
   mezzanotte quasi zero: una media sola avrebbe sbagliato in tutte e due i
   momenti. La zona si annota anche nel crepuscolo, dove invece il sensore
   non insegna niente di suo.

   PONTE 3.2 (9 settembre 2026): SI CONTANO LE NOTTI, NON LE LETTURE. Una
   lettura ogni venti minuti fa cinque "osservazioni" in meno di due ore:
   l'errore fisso di un sensore usciva dopo una notte sola, e una notte
   può essere strana (vento, nebbia, un temporale). Ora per ogni stazione e
   per ogni classe si contano anche le NOTTI (o i giorni) distinte in cui è
   stata vista, e l'errore fisso, l'eccesso col sole e i verdetti escono
   solo da tre notti (o tre giorni) in su. I file restano leggibili dalle
   app v72.2 e v72.3 così come sono: chi non ha ancora tre notti
   semplicemente non ha il campo "f", e non viene corretto.
   ════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ITALIA = { latMin: 35.4, latMax: 47.2, lonMin: 6.5, lonMax: 18.7 };
export const MATTONELLA = 2;           /* gradi: la mattonella di partenza */
export const MATTONELLA_MIN = 0.2;     /* sotto, non si spezza più (0,25° è l'ultimo gradino) */
export const SOGLIA_DENTRO = 350;      /* stazioni DENTRO il rettangolo: da qui in su si spezza */
export const RISPOSTA_SOSPETTA = 800;  /* una risposta così grande può essere stata tagliata: si spezza */
export const TETTO_STAZIONI = SOGLIA_DENTRO;   /* nome vecchio, tenuto per chi lo importa */
export const TETTO_CHIAMATE = 160;     /* per giro, ritentativi compresi */
export const TENTATIVI = 3;            /* per mattonella */
export const PAUSE_MS = [3000, 10000]; /* fra un tentativo e l'altro */
export const TEMPO_MAX_MS = 25000;     /* per chiamata */
export const VUOTA_VALIDA_MS = 24 * 3600 * 1000;   /* una mattonella vuota si ricontrolla dopo un giorno */
export const RIPORTO_MAX_S = 3 * 3600;  /* una lettura del giro prima si riporta se ha meno di tre ore */
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

/** Le stazioni del giro prima che stavolta non sono arrivate (mattonella fallita, risposta
 *  tagliata, tetto raggiunto) si rimettono com'erano, con la LORO ora di lettura, purché
 *  abbiano meno di RIPORTO_MAX_S: l'app usa solo le letture fresche, e una stazione spenta
 *  sparisce da sola dopo tre ore. Torna quante ne ha riportate. */
export function riporta(stazioni, precedenti, adessoS = Date.now() / 1000, maxEtaS = RIPORTO_MAX_S) {
  if (!precedenti.size) return 0;
  const presenti = new Set(stazioni.map(s => s.id));
  let riportate = 0;
  for (const st of precedenti.values()) {
    if (presenti.has(st.id)) continue;
    const ts = Number(st.ts);
    if (!Number.isFinite(ts) || adessoS - ts > maxEtaS) continue;
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
      q: Number.isFinite(Number(m.elev)) ? Math.round(Number(m.elev)) : undefined,   /* ponte 3: la quota, se il servizio la manda */
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

/* ————————————————— la reputazione delle stazioni (ponte 3) —————————————————

   Il ponte vede quello che nessun telefono può vedere: tutte le stazioni
   d'Italia, ogni venti minuti, anche alle tre di notte. Da qui si impara,
   per ogni singola stazione, DUE cose diverse che non vanno confuse:

   1 · il DIFETTO PERSONALE del sensore. Si misura contro le vicine, non
       contro l'aeroporto: quanto legge questa stazione rispetto alla
       mediana delle altre entro 25 km, riportate alla sua quota. Se di
       notte legge sempre un grado più delle vicine, quel grado è suo (una
       parete che restituisce calore, un sensore starato); se legge come
       loro di notte ma tre gradi più col sole alto, quei tre gradi sono
       il sole che le batte addosso. Questo conto non ha bisogno di nessun
       aeroporto: funziona ovunque ci siano almeno quattro stazioni.

   2 · la DIFFERENZA DI ZONA, che è vera e NON va corretta: quanto tutta
       la zona sta sopra o sotto l'aeroporto di riferimento (collina contro
       pianura, città contro campagna). Ozzano non è Borgo Panigale, e se
       si misurasse il difetto dei sensori contro l'aeroporto si finirebbe
       per cancellare una differenza reale del territorio.

   Le osservazioni non si conservano una per una: si accumulano in somme,
   divise per cielo (notte · velato · sole), e ogni giorno le vecchie
   pesano un po' meno (metà dopo tre settimane), così una stazione spostata
   o riparata torna pulita da sola invece di restare marchiata per sempre.

   Questo blocco RACCOGLIE E BASTA: i file "reputazione/*.json" nascono
   accanto ai dati, l'app di oggi non li guarda nemmeno. Si accenderanno
   nella v72.2, quando i numeri saranno abbastanza.
   ———————————————————————————————————————————————————————————————————— */

export const REP_VERSIONE = 1;
export const REP_RAGGIO_KM = 25;        /* le vicine con cui ci si confronta: lo stesso raggio della carta dell'app */
export const REP_MIN_VICINE = 3;        /* sotto, di questa stazione non si impara niente in questo giro */
export const REP_AERO_KM = 60;          /* l'aeroporto di riferimento della zona (per la differenza di zona) */
export const REP_CIELO_KM = 120;        /* per sapere se c'è il sole o è coperto basta un aeroporto della regione */
export const REP_AERO_MAX_S = 90 * 60;  /* e la sua osservazione dev'essere di meno di un'ora e mezza fa */
export const REP_GRADIENTE = 0.0065;    /* °C per metro */
export const REP_QUOTA_MAX = 600;       /* oltre questo dislivello la quota dichiarata non è credibile: niente correzione */
export const REP_FRESCHE_S = 45 * 60;   /* solo letture fresche, come nell'app */
export const REP_SOLE_ALTO = 8;         /* gradi sopra l'orizzonte: sotto, il sole non scalda ancora i sensori */
export const REP_NOTTE = -4;            /* gradi sotto l'orizzonte: da qui in giù è notte piena */
export const REP_DIMEZZA_GIORNI = 21;   /* le osservazioni vecchie pesano metà dopo tre settimane */
export const REP_MIN_OSS = 5;           /* osservazioni in una classe, per dire qualcosa */
export const REP_MAX_SCARTO = 15;       /* oltre, non è una stazione al sole: è rotta, e non insegna niente */
export const REP_MIN_PERIODI = 3;       /* ponte 3.2: notti (o giorni) distinte in cui la stazione è stata vista, prima di giudicarla */
export const REP_LETTURE_PER_NOTTE = 24; /* ponte 3.2: per i file vecchi, senza il conto delle notti: una notte ≈ 24 letture (una ogni 20 minuti) */
export const REP_DIMENTICA_GIORNI = 30; /* non vista da un mese: si toglie dalla memoria */
export const REP_CLASSI = ['notte', 'velato', 'sole', 'giorno'];
/* ponte 3.1 · la differenza di zona non è una cosa sola: all'alba, quando l'aria dei campi
   aperti dell'aeroporto si è raffreddata per irraggiamento e i muri del paese restituiscono
   ancora il calore del giorno prima, il paese può stare tre gradi sopra; a mezzanotte mezzo
   grado; col sole alto quasi niente. Quindi si misura per fasce di altezza del sole. */
export const REP_BANDE = ['n2', 'n1', 'c', 'g1', 'g2'];
export function fasciaSole(h) {
  if (!Number.isFinite(h)) return null;
  if (h <= -15) return 'n2';          /* cuore della notte */
  if (h <= REP_NOTTE) return 'n1';    /* prima notte e fine notte */
  if (h < REP_SOLE_ALTO) return 'c';  /* crepuscolo: alba e tramonto */
  if (h <= 25) return 'g1';           /* sole basso */
  return 'g2';                        /* sole alto */
}

/** quota (m) degli aeroporti con METAR, per chi non la manda nell'osservazione */
export const QUOTE_AERO = { LIPE: 37, LIMC: 234, LIML: 103, LIRF: 3, LIRA: 130, LICC: 12, LIPZ: 2, LIRN: 88, LIMF: 301, LIME: 238,
  LIPX: 73, LIRP: 2, LIRQ: 38, LIBD: 54, LICJ: 20, LIEE: 4, LIEO: 11, LIPR: 13, LIPY: 15, LIBR: 15, LIRZ: 211, LICA: 12, LIBP: 15,
  LIPQ: 12, LIMJ: 3, LIPH: 18, LIPK: 30, LIPO: 109, LIMZ: 386, LIRJ: 31, LICT: 7, LICD: 21, LIBC: 158, LICR: 29, LIRL: 28, LIBG: 65,
  LIQS: 193, LIPU: 13, LIDT: 186, LIPB: 240, LIMW: 545, LIRV: 308, LIPA: 126, LIMP: 49, LIPC: 5, LIRE: 12, LIMG: 45, LIQW: 13,
  LIED: 28, LIEA: 27, LIBV: 350, LIRG: 89, LIPS: 45, LICZ: 24, LIBA: 57, LIPI: 53, LIBN: 48, LIMS: 212, LIPD: 53, LIPL: 109,
  LIRM: 6, LIRU: 74, LIQN: 13, LIRH: 145, LIMA: 18, LIMN: 169, LIMU: 12, LIMQ: 17, LIVT: 4 };

export function distanzaKm(la1, lo1, la2, lo2) {
  const r = 6371, g = Math.PI / 180;
  const dLa = (la2 - la1) * g, dLo = (lo2 - lo1) * g;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * g) * Math.cos(la2 * g) * Math.sin(dLo / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function medianaRep(valori) {
  const s = valori.filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
}

/** L'altezza del sole sull'orizzonte, in gradi (NOAA). Niente chiamate a nessuno: si calcola. */
export function altezzaSole(la, lo, quando = new Date()) {
  const d = quando instanceof Date ? quando : new Date(quando);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || isNaN(d.getTime())) return NaN;
  const rad = Math.PI / 180;
  const giorni = (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
  const g = 2 * Math.PI / 365 * giorni;
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
            - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));            /* minuti */
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
             + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);   /* radianti */
  const minutiUTC = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const oraSolare = minutiUTC + eqt + 4 * lo;                                       /* minuti, ora solare vera */
  const angolo = (oraSolare / 4 - 180) * rad;                                       /* angolo orario */
  const cosZ = Math.sin(la * rad) * Math.sin(decl) + Math.cos(la * rad) * Math.cos(decl) * Math.cos(angolo);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / rad;
}

/** Il cielo di quel momento: 'notte' · 'velato' (giorno coperto) · 'sole' · 'giorno' (cielo ignoto).
 *  Fra i −4° e gli +8° di altezza non si classifica niente: all'alba e al tramonto i sensori
 *  si stanno ancora scaldando o raffreddando e insegnerebbero il falso. */
export function classeCielo(altezza, nubi, aeroportoNoto = true) {
  if (!Number.isFinite(altezza)) return null;
  if (altezza <= REP_NOTTE) return 'notte';
  if (altezza < REP_SOLE_ALTO) return null;
  if (!aeroportoNoto) return 'giorno';
  const n = String(nubi || '').toUpperCase();
  return (n === 'BKN' || n === 'OVC') ? 'velato' : 'sole';
}

/** Un indice a caselle di 0,25°: trovare le vicine di 14.000 stazioni senza confrontarle tutte con tutte. */
export function indiceVicine(stazioni, lato = 0.25) {
  const caselle = new Map();
  const chiave = (a, b) => a + ':' + b;
  stazioni.forEach((s, i) => {
    const k = chiave(Math.floor(s.la / lato), Math.floor(s.lo / lato));
    let lista = caselle.get(k);
    if (!lista) { lista = []; caselle.set(k, lista); }
    lista.push(i);
  });
  return {
    attorno(la, lo) {
      const ca = Math.floor(la / lato), cb = Math.floor(lo / lato), fuori = [];
      for (let a = ca - 1; a <= ca + 1; a++) for (let b = cb - 1; b <= cb + 1; b++) {
        const lista = caselle.get(chiave(a, b));
        if (lista) fuori.push(...lista);
      }
      return fuori;
    }
  };
}

const vuotaP = () => [0, 0, -99, 0, 0]; /* [quante, somma, massimo, notti o giorni distinti (3.2), ultimo periodo contato (3.2)] */
/** ponte 3.2 · il "periodo" di una lettura: per la notte, la data della sera in cui è cominciata (da mezzogiorno a
 *  mezzogiorno), così le 23:30 e le 02:30 sono la stessa notte; per il giorno, la data. In giorni dal 1970. */
export function periodoDi(tsSecondi, classe) {
  const ms = Number(tsSecondi) * 1000;
  return Math.floor((classe === 'notte' ? ms - 12 * 3600000 : ms) / 86400000);
}
const vuotaZ = () => [0, 0];           /* [quante, somma] */
const giornoDi = ms => new Date(ms).toISOString().slice(0, 10);
const giorniFra = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/** Le osservazioni vecchie pesano meno: metà dopo tre settimane. Si applica una volta al giorno. */
export function invecchia(memoria, oggi) {
  if (!memoria.decaduto) { memoria.decaduto = oggi; return 0; }
  const giorni = giorniFra(memoria.decaduto, oggi);
  if (!Number.isFinite(giorni) || giorni <= 0) return 0;
  const k = Math.pow(0.5, giorni / REP_DIMEZZA_GIORNI);
  let tolte = 0;
  for (const id of Object.keys(memoria.st)) {
    const st = memoria.st[id];
    const eta = st.visto ? giorniFra(st.visto, oggi) : 999;
    if (eta > REP_DIMENTICA_GIORNI) { delete memoria.st[id]; tolte++; continue; }
    st.n = Number((st.n * k).toFixed(3));
    for (const c of REP_CLASSI) {
      /* ponte 3.2: il conto delle notti (o giorni) distinti NON invecchia: è una storia, non un peso; chi sparisce da un mese esce comunque */
      if (st.p[c]) { st.p[c][0] = Number((st.p[c][0] * k).toFixed(3)); st.p[c][1] = Number((st.p[c][1] * k).toFixed(3)); }
      if (st.z[c]) { st.z[c][0] = Number((st.z[c][0] * k).toFixed(3)); st.z[c][1] = Number((st.z[c][1] * k).toFixed(3)); }
    }
    for (const b of REP_BANDE) if (st.zb && st.zb[b]) { st.zb[b][0] = Number((st.zb[b][0] * k).toFixed(3)); st.zb[b][1] = Number((st.zb[b][1] * k).toFixed(3)); }
  }
  memoria.decaduto = oggi;
  return tolte;
}

/** Il giudizio su una stazione, dai suoi accumuli:
 *   f  = errore fisso (quanto legge sopra le vicine col buio)
 *   s  = eccesso col sole (quanto si scalda in più quando il sole batte, tolto l'errore fisso)
 *   zf = quanto sta sopra l'aeroporto la ZONA attorno a lei, di notte (differenza vera del territorio)
 *   q  = quanta fiducia meritano questi numeri, da 0 a 1
 *   v  = 'buona' · 'sole' · 'alta' · 'bassa' · 'poco' */
export function verdetto(st) {
  const media = a => a && a[0] >= 1 ? a[1] / a[0] : NaN;
  const periodi = a => a && a.length > 3 && Number.isFinite(a[3]) ? a[3] : 0;   /* ponte 3.2: notti o giorni distinti */
  const nNotte = st.p.notte ? st.p.notte[0] : 0, nSole = st.p.sole ? st.p.sole[0] : 0;
  const nGiorno = st.p.giorno ? st.p.giorno[0] : 0;
  const notti = periodi(st.p.notte);
  const f = nNotte >= REP_MIN_OSS && notti >= REP_MIN_PERIODI ? media(st.p.notte) : NaN;
  /* dove non c'è nessun aeroporto entro 120 km il cielo resta ignoto: allora, per l'eccesso col sole,
     valgono le ore di giorno (ci sono dentro anche le giornate coperte, quindi il conto viene più
     prudente e la fiducia più bassa) */
  const perSole = nSole >= REP_MIN_OSS && periodi(st.p.sole) >= REP_MIN_PERIODI ? st.p.sole
                : (nGiorno >= 2 * REP_MIN_OSS && periodi(st.p.giorno) >= REP_MIN_PERIODI ? st.p.giorno : null);
  const conSole = perSole ? media(perSole) : NaN;
  const nUsate = perSole ? perSole[0] : 0;
  const s = Number.isFinite(conSole) ? conSole - (Number.isFinite(f) ? f : 0) : NaN;
  const zf = st.z.notte && st.z.notte[0] >= REP_MIN_OSS ? media(st.z.notte) : NaN;
  let v = 'poco';
  if (Number.isFinite(s) && s >= 1.5) v = 'sole';
  else if (Number.isFinite(f) && f >= 1.2) v = 'alta';
  else if (Number.isFinite(f) && f <= -1.2) v = 'bassa';
  else if (Number.isFinite(f) && Number.isFinite(s) && Math.abs(f) < 0.8 && s < 1) v = 'buona';
  const q = Math.min(1, nNotte / 10) * 0.5 + Math.min(1, nUsate / 10) * (nSole >= REP_MIN_OSS ? 0.5 : 0.3);
  return { f, s, zf, q: Number(q.toFixed(2)), v, notti: Number(notti.toFixed(1)), giorni: Number(periodi(perSole).toFixed(1)) };
}

/** Un giro di osservazioni: aggiorna la memoria con le letture di adesso. Non tocca niente
 *  di quello che l'app usa; torna solo i conti di quello che ha imparato. */
export function osserva(stazioni, aerop, memoria, adessoMs = Date.now()) {
  const adessoS = adessoMs / 1000, oggi = giornoDi(adessoMs);
  const conti = { fresche: 0, imparate: 0, zone: 0, ripetute: 0, poche: 0, guaste: 0, conAeroporto: 0, conCielo: 0, nuove: 0, invecchiate: 0, periodi: 0 };
  if (!memoria.st) memoria.st = {};
  conti.invecchiate = invecchia(memoria, oggi);

  const fresche = (stazioni || []).filter(s => s && Number.isFinite(Number(s.t)) && Number.isFinite(Number(s.la))
    && Number.isFinite(Number(s.lo)) && Number.isFinite(Number(s.ts)) && adessoS - Number(s.ts) <= REP_FRESCHE_S);
  conti.fresche = fresche.length;
  if (fresche.length < REP_MIN_VICINE + 1) return conti;
  const indice = indiceVicine(fresche);
  const aerei = (aerop || []).filter(a => a && Number.isFinite(Number(a.t)) && Number.isFinite(Number(a.la))
    && Number.isFinite(Number(a.ts)) && adessoS - Number(a.ts) <= REP_AERO_MAX_S);

  for (const s of fresche) {
    const id = String(s.id || '');
    if (!id) continue;
    const st = memoria.st[id];
    if (st && Number(st.ts) === Number(s.ts)) { conti.ripetute++; continue; }   /* la stessa lettura di prima: non si conta due volte */

    /* le vicine, riportate alla quota di questa stazione */
    const alt = Number(s.alt);
    const attorno = [];
    for (const i of indice.attorno(Number(s.la), Number(s.lo))) {
      const v = fresche[i];
      if (v === s || String(v.id) === id) continue;
      if (distanzaKm(Number(s.la), Number(s.lo), Number(v.la), Number(v.lo)) > REP_RAGGIO_KM) continue;
      const av = Number(v.alt);
      const dq = Number.isFinite(av) && Number.isFinite(alt) && Math.abs(av - alt) <= REP_QUOTA_MAX ? av - alt : 0;
      attorno.push(Number(v.t) + REP_GRADIENTE * dq);
    }
    if (attorno.length < REP_MIN_VICINE) { conti.poche++; continue; }
    const medV = medianaRep(attorno);
    const p = Number(s.t) - medV;
    if (!Number.isFinite(p) || Math.abs(p) > REP_MAX_SCARTO) { conti.guaste++; continue; }

    /* l'aeroporto più vicino: entro 60 km serve da metro per la differenza di zona, entro 120 km
       basta comunque a dire se c'era il sole o era coperto (le nuvole sono una faccenda regionale) */
    let aero = null, dMin = Infinity;
    for (const a of aerei) {
      const d = distanzaKm(Number(s.la), Number(s.lo), Number(a.la), Number(a.lo));
      if (d < dMin && d <= REP_CIELO_KM) { dMin = d; aero = a; }
    }
    let z = NaN, nubi = '';
    if (aero) {
      nubi = aero.nubi || '';
      conti.conCielo++;
      if (dMin <= REP_AERO_KM) {
        const qa = Number.isFinite(Number(aero.q)) ? Number(aero.q) : QUOTE_AERO[String(aero.icao || '').toUpperCase()];
        const aeroT = Number(aero.t) - (Number.isFinite(qa) && Number.isFinite(alt) ? REP_GRADIENTE * (alt - qa) : 0);
        z = medV - aeroT;                     /* quanto la zona sta sopra l'aeroporto: differenza vera del territorio */
        conti.conAeroporto++;
      }
    }

    const altezza = altezzaSole(Number(s.la), Number(s.lo), new Date(Number(s.ts) * 1000));
    const classe = classeCielo(altezza, nubi, !!aero);
    const banda = fasciaSole(altezza);
    /* nel crepuscolo il sensore non insegna niente di suo (si sta scaldando o raffreddando), ma la
       differenza fra la zona e l'aeroporto è comunque una misura buona: quella si annota sempre */
    if (!classe && !(banda && Number.isFinite(z))) continue;

    let voce = memoria.st[id];
    if (!voce) {
      voce = memoria.st[id] = { n: 0, ts: 0, dal: oggi, visto: oggi, p: {}, z: {}, zb: {} };
      conti.nuove++;
    }
    if (!voce.zb) voce.zb = {};
    voce.citta = s.citta || voce.citta || '';
    voce.la = Number(s.la); voce.lo = Number(s.lo);
    if (Number.isFinite(alt)) voce.alt = alt;
    voce.ts = Number(s.ts); voce.visto = oggi;
    if (Number.isFinite(z) && banda) {
      const zb = voce.zb[banda] || (voce.zb[banda] = vuotaZ());
      zb[0] = Number((zb[0] + 1).toFixed(3)); zb[1] = Number((zb[1] + z).toFixed(3));
      conti.zone++;
    }
    if (!classe) continue;                    /* alba o tramonto: sul sensore non si impara */
    voce.n = Number((voce.n + 1).toFixed(3));
    const pc = voce.p[classe] || (voce.p[classe] = vuotaP());
    pc[0] = Number((pc[0] + 1).toFixed(3)); pc[1] = Number((pc[1] + p).toFixed(3)); pc[2] = Math.max(pc[2], Number(p.toFixed(2)));
    /* ponte 3.2 · una notte (o un giorno) nuova conta una volta sola, per quante letture porti */
    const periodo = periodoDi(s.ts, classe);
    if (pc.length < 5) { pc[3] = pc[3] || 0; pc[4] = pc[4] || 0; }
    if (pc[4] !== periodo) { pc[3] = Number((pc[3] + 1).toFixed(3)); pc[4] = periodo; conti.periodi++; }
    if (Number.isFinite(z)) {
      const zc = voce.z[classe] || (voce.z[classe] = vuotaZ());
      zc[0] = Number((zc[0] + 1).toFixed(3)); zc[1] = Number((zc[1] + z).toFixed(3));
    }
    conti.imparate++;
  }
  memoria.aggiornato = adessoMs;
  return conti;
}

/** La memoria pronta da scrivere, cella per cella, con i verdetti già calcolati. */
export function perCella(memoria, adessoMs = Date.now()) {
  const celle = {};
  const arr = (a, quanti) => a ? a.slice(0, quanti).map(v => Number(Number(v).toFixed(2))) : undefined;
  for (const id of Object.keys(memoria.st || {})) {
    const st = memoria.st[id];
    if (!Number.isFinite(st.la) || !Number.isFinite(st.lo)) continue;
    const k = Math.floor(st.la) + '_' + Math.floor(st.lo);
    const g = verdetto(st);
    const fuori = { n: Number(st.n.toFixed(1)), ts: st.ts, dal: st.dal, visto: st.visto,
                    la: Number(st.la.toFixed(4)), lo: Number(st.lo.toFixed(4)), p: {}, z: {}, q: g.q, v: g.v };
    if (st.citta) fuori.citta = st.citta;
    if (Number.isFinite(st.alt)) fuori.alt = st.alt;
    if (Number.isFinite(g.f)) fuori.f = Number(g.f.toFixed(2));
    if (Number.isFinite(g.s)) fuori.s = Number(g.s.toFixed(2));
    if (Number.isFinite(g.zf)) fuori.zf = Number(g.zf.toFixed(2));
    fuori.notti = g.notti;                                    /* ponte 3.2: notti distinte viste (e giorni, per il sole) */
    if (g.giorni > 0) fuori.giorni = g.giorni;
    for (const c of REP_CLASSI) {
      if (st.p[c] && st.p[c][0] > 0) fuori.p[c] = arr(st.p[c], 5);
      if (st.z[c] && st.z[c][0] > 0) fuori.z[c] = arr(st.z[c], 2);
    }
    fuori.zb = {};
    for (const b of REP_BANDE) if (st.zb && st.zb[b] && st.zb[b][0] > 0) fuori.zb[b] = arr(st.zb[b], 2);
    (celle[k] = celle[k] || {})[id] = fuori;
  }
  const fuori = {};
  for (const k of Object.keys(celle)) fuori[k] = { aggiornato: adessoMs, versione: REP_VERSIONE,
    decaduto: memoria.decaduto || '', stazioni: celle[k] };
  return fuori;
}

/** Il contrario: dai file per cella alla memoria unica del ponte. */
export function daCelle(file) {
  const memoria = { versione: REP_VERSIONE, decaduto: '', aggiornato: 0, st: {} };
  for (const contenuto of file) {
    if (!contenuto || Number(contenuto.versione) !== REP_VERSIONE || !contenuto.stazioni) continue;
    if (Number(contenuto.aggiornato) > memoria.aggiornato) memoria.aggiornato = Number(contenuto.aggiornato);
    if (contenuto.decaduto && contenuto.decaduto > memoria.decaduto) memoria.decaduto = contenuto.decaduto;
    for (const id of Object.keys(contenuto.stazioni)) {
      const v = contenuto.stazioni[id];
      const st = { n: Number(v.n) || 0, ts: Number(v.ts) || 0, dal: v.dal || '', visto: v.visto || '', citta: v.citta || '', p: {}, z: {}, zb: {} };
      if (Number.isFinite(Number(v.alt))) st.alt = Number(v.alt);
      if (Number.isFinite(Number(v.la))) st.la = Number(v.la);
      if (Number.isFinite(Number(v.lo))) st.lo = Number(v.lo);
      for (const c of REP_CLASSI) {
        if (Array.isArray(v.p && v.p[c])) {
          const a = v.p[c], n = Number(a[0]) || 0;
          /* ponte 3.2 · i file di prima non hanno il conto delle notti: si stima dalle letture (una notte ≈ 24), e da qui in poi si conta davvero */
          const periodi = a.length > 3 && Number.isFinite(Number(a[3])) ? Number(a[3]) : Math.floor(n / REP_LETTURE_PER_NOTTE);
          st.p[c] = [n, Number(a[1]) || 0, Number(a[2]) || -99, periodi, a.length > 4 ? Number(a[4]) || 0 : 0];
        }
        if (Array.isArray(v.z && v.z[c])) st.z[c] = [Number(v.z[c][0]) || 0, Number(v.z[c][1]) || 0];
      }
      st.zb = {};
      for (const b of REP_BANDE) if (Array.isArray(v.zb && v.zb[b])) st.zb[b] = [Number(v.zb[b][0]) || 0, Number(v.zb[b][1]) || 0];
      memoria.st[id] = st;
    }
  }
  return memoria;
}

/* ————— i file della reputazione: uno per cella, accanto ai dati ————— */

export function leggiReputazione(radice) {
  const cartella = dir(radice, 'reputazione');
  let nomi = [];
  try { nomi = fs.readdirSync(cartella).filter(n => n.endsWith('.json')); } catch (_) { return daCelle([]); }
  return daCelle(nomi.map(n => leggi(dir(cartella, n), null)));
}

export function scriviReputazione(radice, celle) {
  const cartella = dir(radice, 'reputazione');
  fs.rmSync(cartella, { recursive: true, force: true });
  const nomi = Object.keys(celle);
  for (const k of nomi) scrivi(dir(cartella, k + '.json'), celle[k]);
  return nomi.length;
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
  const riportate = riporta(r.stazioni, precedenti);
  if (riportate) registro.log('  ↻ riportate ' + riportate + ' letture del giro prima (mattonelle non lette o risposte tagliate' + (r.mattonelleFallite.length ? ', ' + r.mattonelleFallite.length + ' mattonelle non lette' : '') + ')');
  let a = await aeroporti(chiama, registro);
  if (a.length) registro.log('  ✔ aeroporti: ' + a.length + ' osservazioni');
  else {
    /* il servizio degli aeroporti non ha risposto: restano le osservazioni del giro
       prima, con la LORO ora (l'app la mostra, e sa quanto sono vecchie) */
    const prima = leggi(dir(radice, 'aeroporti.json'), null);
    a = prima && Array.isArray(prima.aeroporti) ? prima.aeroporti : [];
    registro.log(a.length ? '  ↻ aeroporti: servizio muto, riportate le ' + a.length + ' osservazioni del giro prima' : '  ⚠ aeroporti: nessuna osservazione');
  }
  /* ponte 3 · la reputazione: si impara e si scrive, ma non cambia niente di quello che l'app usa oggi */
  let rep = { imparate: 0, celle: 0 };
  try {
    const memoria = leggiReputazione(radice);
    const conti = osserva(r.stazioni, a, memoria, Date.now());
    rep.celle = scriviReputazione(radice, perCella(memoria, Date.now()));
    rep.imparate = conti.imparate;
    registro.log('  ✔ reputazione: ' + conti.imparate + ' letture nuove su ' + conti.fresche + ' fresche, ' + conti.periodi + ' notti/giorni nuovi, ' + conti.zone + ' con la differenza di zona ('
      + conti.nuove + ' stazioni mai viste, ' + conti.ripetute + ' letture già contate, ' + conti.poche + ' senza abbastanza vicine, '
      + conti.guaste + ' fuori da ogni scala, ' + conti.conCielo + ' con il cielo noto, ' + conti.conAeroporto + ' con un aeroporto entro ' + REP_AERO_KM + ' km'
      + (conti.invecchiate ? ', ' + conti.invecchiate + ' dimenticate perché sparite da un mese' : '') + ') → ' + rep.celle + ' celle');
  } catch (e) { registro.log('  ⚠ reputazione: ' + e.message + ' (i dati delle stazioni non ne risentono)'); }
  const conteggi = scriviTutto(radice, r.stazioni, a, { chiamate: r.chiamate, durataMs: Date.now() - t0, reputazione: rep.imparate });
  registro.log('  ✔ scritte ' + Object.keys(conteggi).length + ' celle in ' + Math.round((Date.now() - t0) / 1000) + ' s');
  return { stazioni: r.stazioni.length, aeroporti: a.length, celle: Object.keys(conteggi).length, chiamate: r.chiamate, imparate: rep.imparate };
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
