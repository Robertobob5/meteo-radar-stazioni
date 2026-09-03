/* ════════════════════════════════════════════════════════════════
   Meteo Radar · il PONTE delle stazioni vicine (v65)

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
   ════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ITALIA = { latMin: 35.4, latMax: 47.2, lonMin: 6.5, lonMax: 18.7 };
export const MATTONELLA = 2;           /* gradi: la mattonella di partenza */
export const MATTONELLA_MIN = 0.5;     /* sotto, non si spezza più */
export const TETTO_STAZIONI = 700;     /* tante in una mattonella: sospetto taglio → si spezza */
export const TETTO_CHIAMATE = 150;     /* per giro */
export const VUOTA_VALIDA_MS = 24 * 3600 * 1000;   /* una mattonella vuota si ricontrolla dopo un giorno */
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

async function mattonella(tok, m, chiama) {
  const u = new URL('https://api.netatmo.com/api/getpublicdata');
  u.searchParams.set('lat_ne', m.latMax.toFixed(3)); u.searchParams.set('lon_ne', m.lonMax.toFixed(3));
  u.searchParams.set('lat_sw', m.latMin.toFixed(3)); u.searchParams.set('lon_sw', m.lonMin.toFixed(3));
  u.searchParams.set('required_data', 'temperature');
  u.searchParams.set('filter', 'false');
  const r = await chiama(u.toString(), { headers: { Authorization: 'Bearer ' + tok } });
  if (r.status === 429) { const e = new Error('Netatmo: troppe richieste (429)'); e.stop = true; throw e; }
  if (!r.ok) throw new Error('getpublicdata HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j.body) ? j.body : [];
}

const chiaveM = m => [m.latMin, m.lonMin, m.latMax - m.latMin].map(v => v.toFixed(2)).join('_');

/** Tutte le stazioni d'Italia, a mattonelle adattive e con un tetto di chiamate. */
export async function raccogli(tok, radice, chiama, adesso = Date.now(), registro = console) {
  const fileMatt = dir(radice, 'mattonelle.json');
  const memoria = leggi(fileMatt, {});
  const coda = [];
  for (let la = ITALIA.latMin; la < ITALIA.latMax; la += MATTONELLA)
    for (let lo = ITALIA.lonMin; lo < ITALIA.lonMax; lo += MATTONELLA)
      coda.push({ latMin: la, lonMin: lo, latMax: Math.min(la + MATTONELLA, ITALIA.latMax), lonMax: Math.min(lo + MATTONELLA, ITALIA.lonMax) });

  const stazioni = new Map();
  let chiamate = 0, spezzate = 0, saltate = 0;
  while (coda.length) {
    const m = coda.shift();
    const k = chiaveM(m);
    const nota = memoria[k];
    if (nota && nota.n === 0 && adesso - nota.ts < VUOTA_VALIDA_MS) { saltate++; continue; }   /* mare, o montagna deserta */
    if (chiamate >= TETTO_CHIAMATE) { registro.log('  · tetto di ' + TETTO_CHIAMATE + ' chiamate raggiunto: il resto al prossimo giro'); break; }
    let grezze;
    try { chiamate++; grezze = await mattonella(tok, m, chiama); }
    catch (e) { if (e.stop) { registro.log('  ✘ ' + e.message + ': mi fermo qui'); break; } registro.log('  ⚠ ' + k + ': ' + e.message); continue; }
    const lato = m.latMax - m.latMin;
    if (grezze.length >= TETTO_STAZIONI && lato > MATTONELLA_MIN) {
      /* troppe: Netatmo potrebbe averne tagliate — si spezza in quattro e si rifà */
      spezzate++;
      const mezzoLa = (m.latMin + m.latMax) / 2, mezzoLo = (m.lonMin + m.lonMax) / 2;
      coda.unshift(
        { latMin: m.latMin, lonMin: m.lonMin, latMax: mezzoLa, lonMax: mezzoLo },
        { latMin: m.latMin, lonMin: mezzoLo, latMax: mezzoLa, lonMax: m.lonMax },
        { latMin: mezzoLa, lonMin: m.lonMin, latMax: m.latMax, lonMax: mezzoLo },
        { latMin: mezzoLa, lonMin: mezzoLo, latMax: m.latMax, lonMax: m.lonMax });
      memoria[k] = { n: grezze.length, ts: adesso, spezzata: 1 };
      continue;
    }
    memoria[k] = { n: grezze.length, ts: adesso };
    for (const g of grezze) {
      const s = snellisci(g);
      if (s && s.id) stazioni.set(s.id, s);
    }
  }
  scrivi(fileMatt, memoria);
  return { stazioni: [...stazioni.values()], chiamate, spezzate, saltate };
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

export async function giro(amb = process.env, radice = process.cwd(), chiama = fetch, registro = console) {
  const t0 = Date.now();
  registro.log('Ponte stazioni · ' + new Date().toISOString());
  const tok = await gettone(amb, radice, chiama);
  registro.log('  ✔ gettone Netatmo rinnovato');
  const r = await raccogli(tok, radice, chiama, Date.now(), registro);
  registro.log('  ✔ Netatmo: ' + r.stazioni.length + ' stazioni con ' + r.chiamate + ' chiamate (' + r.spezzate + ' mattonelle spezzate, ' + r.saltate + ' saltate perché vuote)');
  const a = await aeroporti(chiama, registro);
  registro.log('  ✔ aeroporti: ' + a.length + ' osservazioni');
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
