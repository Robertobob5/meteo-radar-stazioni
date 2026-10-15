/* ════════════════════════════════════════════════════════════════
   Meteo Radar · l'ALLARME del ponte (ponte 3.4 · 15 ottobre 2026)

   Il lavoro resta verde anche quando le stazioni non si aggiornano: un
   giro fallito dice "si riprova al prossimo" e si va avanti, ed è giusto
   così (un lavoro rosso ogni ora manderebbe una mail ogni ora). Ma allora
   qualcuno se ne deve accorgere. Alla fine di ogni giro lungo questo
   programma guarda il ramo dati COSÌ COM'È PUBBLICATO (quello che vede
   l'app) e:
     1. scrive nel riassunto del lavoro quando sono state aggiornate le
        stazioni e gli aeroporti, in ora italiana;
     2. se le stazioni sono ferme da più di 2 ore apre UNA issue
        «Ponte stazioni fermo» (GitHub manda una mail a chi segue il
        repository) con l'ultima riga d'errore del giro, senza segreti;
        se ce n'è già una aperta non fa niente;
     3. quando le stazioni tornano fresche la chiude, con un commento.
   "Ferme" vuol dire: indice.json più vecchio di 2 ore, oppure nessuna
   lettura di stazione più giovane di 2 ore in tutte le celle (il giro va,
   ma Netatmo non manda più niente).
   Risponde sempre 0: non fa mai diventare rosso il lavoro.

   Uso: node ponte_allarme.mjs <cartella con indice.json, aeroporti.json, celle/>
   Variabili: GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER (menzionato nella
              issue, così la mail arriva), GH_TOKEN (permesso issues: write),
              PONTE_ERRORE (il file con le righe d'errore del giro),
              GITHUB_STEP_SUMMARY, GITHUB_SERVER_URL, GITHUB_RUN_ID.
   ════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { stessoFile, senzaSegreti, oraItaliana } from './ponte_stazioni.mjs';

export const TITOLO = 'Ponte stazioni fermo';
export const FERME_DOPO_MS = 2 * 3600 * 1000;

const leggi = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const numero = v => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

/** Lo stato delle stazioni come lo vede l'app: { aggiornato, lettura, aeroporti, ferme } (millisecondi). */
export function statoStazioni(cartella, adesso = Date.now()) {
  const indice = leggi(path.join(cartella, 'indice.json'));
  const aerei = leggi(path.join(cartella, 'aeroporti.json'));
  let lettura = 0;
  let nomi = [];
  try { nomi = fs.readdirSync(path.join(cartella, 'celle')).filter(n => n.endsWith('.json')); } catch (_) { nomi = []; }
  for (const n of nomi) {
    const c = leggi(path.join(cartella, 'celle', n));
    for (const s of (c && Array.isArray(c.stazioni) ? c.stazioni : [])) {
      const ts = Number(s && s.ts);
      if (Number.isFinite(ts) && ts > lettura) lettura = ts;
    }
  }
  const aggiornato = indice ? numero(indice.aggiornato) : null;
  const letturaMs = lettura ? lettura * 1000 : null;
  const ferme = aggiornato === null || adesso - aggiornato > FERME_DOPO_MS
             || letturaMs === null || adesso - letturaMs > FERME_DOPO_MS;
  return { aggiornato, lettura: letturaMs, aeroporti: aerei ? numero(aerei.aggiornato) : null, ferme };
}

const minutiFa = (ms, adesso) => Math.max(0, Math.round((adesso - ms) / 60000));

/** «Stazioni: ultimo aggiornamento 15/10 07:56 (6 min fa) · Aeroporti: 15/10 07:29» */
export function rigaRiassunto(s, adesso = Date.now()) {
  const staz = s.aggiornato === null ? 'Stazioni: indice.json manca sul ramo dati'
             : 'Stazioni: ultimo aggiornamento ' + oraItaliana(s.aggiornato) + ' (' + minutiFa(s.aggiornato, adesso) + ' min fa)';
  const aer = s.aeroporti === null ? 'Aeroporti: aeroporti.json manca sul ramo dati' : 'Aeroporti: ' + oraItaliana(s.aeroporti);
  return staz + ' · ' + aer;
}

function rigaLettura(s, adesso) {
  return s.lettura === null ? 'nessuna lettura di stazione nelle celle'
       : 'lettura di stazione più recente: ' + oraItaliana(s.lettura) + ' (' + minutiFa(s.lettura, adesso) + ' min fa)';
}

function testoIssue(s, adesso, errore, collegamento, menziona) {
  return [
    (menziona ? '@' + menziona + ' ' : '') + 'le stazioni Netatmo non si aggiornano da più di 2 ore: la carta «Stazioni vicine» nell\'app sparisce dopo 3.',
    '',
    '- ' + rigaRiassunto(s, adesso),
    '- ' + rigaLettura(s, adesso),
    '',
    'Ultima riga d\'errore del lavoro (senza segreti):',
    '',
    '```',
    errore || 'nessun errore registrato in questo giro',
    '```',
    '',
    collegamento ? 'Il giro: ' + collegamento : '',
    '',
    'Che cosa vuol dire:',
    '- se dice `invalid_grant` o «serve un gettone nuovo nei Secrets», Netatmo ha rifiutato il gettone: '
      + 'bisogna generarne uno nuovo (istruzioni nel README, «Se serve un gettone nuovo»);',
    '- se dice `HTTP 403` con una pagina HTML, oppure `HTTP 5xx`, il gettone non c\'entra: di solito passa da solo;',
    '- se dice «spinta sul ramo dati non riuscita», il problema è su GitHub.',
    '',
    'Questa issue si chiude da sola quando le stazioni tornano fresche.'
  ].join('\n');
}

/**
 * Riassunto e allarme. Torna { aggiornato, lettura, aeroporti, ferme, riga, azione }
 * con azione: 'aperta' | 'già aperta' | 'chiusa' | 'nessuna' | 'errore'.
 */
export async function sorveglia({ cartella, adesso = Date.now(), repo = '', token = '', chiama = fetch, registro = console,
                                  errore = '', collegamento = '', riassunto = '', menziona = '' } = {}) {
  const s = statoStazioni(cartella, adesso);
  const riga = rigaRiassunto(s, adesso);
  registro.log(riga);
  registro.log('  ' + rigaLettura(s, adesso) + (s.ferme ? ' → FERME da più di 2 ore' : ''));
  if (riassunto) {
    try { fs.appendFileSync(riassunto, riga + '\n\n' + rigaLettura(s, adesso) + (s.ferme ? ' · **ferme da più di 2 ore**' : '') + '\n'); }
    catch (_) { /* il riassunto è un di più */ }
  }
  const fuori = { ...s, riga, azione: 'nessuna' };
  if (!repo || !token) { registro.log('  · manca GITHUB_REPOSITORY o GH_TOKEN: le issue non le guardo'); return fuori; }

  const api = async (metodo, percorso, corpo) => {
    const r = await chiama('https://api.github.com/repos/' + repo + percorso, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'meteo-radar-ponte', 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(metodo + ' ' + percorso.split('?')[0] + ': HTTP ' + r.status);
    return r.json();
  };
  try {
    const aperte = (await api('GET', '/issues?state=open&per_page=100')).filter(i => i && !i.pull_request && i.title === TITOLO);
    if (s.ferme && !aperte.length) {
      const nuova = await api('POST', '/issues', { title: TITOLO, body: testoIssue(s, adesso, senzaSegreti(errore), collegamento, menziona) });
      fuori.azione = 'aperta';
      registro.log('  ✘ stazioni ferme: aperta la issue #' + nuova.number + ' «' + TITOLO + '»');
    } else if (s.ferme) {
      fuori.azione = 'già aperta';
      registro.log('  · stazioni ferme: la issue #' + aperte[0].number + ' è già aperta');
    } else if (aperte.length) {
      for (const i of aperte) {
        await api('POST', '/issues/' + i.number + '/comments', { body: 'Le stazioni sono di nuovo fresche.\n\n- ' + riga + '\n- ' + rigaLettura(s, adesso)
          + (collegamento ? '\n\nIl giro: ' + collegamento : '') + '\n\nChiudo la issue.' });
        await api('PATCH', '/issues/' + i.number, { state: 'closed', state_reason: 'completed' });
        registro.log('  ✔ stazioni di nuovo fresche: chiusa la issue #' + i.number);
      }
      fuori.azione = 'chiusa';
    }
  } catch (e) {
    fuori.azione = 'errore';
    registro.log('::warning::allarme del ponte: ' + senzaSegreti(e.message, [token]));
  }
  return fuori;
}

/** L'ultima riga non vuota del file degli errori del giro (o ''). */
export function ultimoErrore(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').map(x => x.trim()).filter(Boolean).pop() || ''; } catch (_) { return ''; }
}

if (stessoFile(import.meta.url, process.argv[1])) {
  const amb = process.env;
  const collegamento = amb.GITHUB_RUN_ID && amb.GITHUB_REPOSITORY
    ? (amb.GITHUB_SERVER_URL || 'https://github.com') + '/' + amb.GITHUB_REPOSITORY + '/actions/runs/' + amb.GITHUB_RUN_ID : '';
  sorveglia({ cartella: process.argv[2] || '.', repo: amb.GITHUB_REPOSITORY || '', token: amb.GH_TOKEN || '',
              errore: ultimoErrore(amb.PONTE_ERRORE), collegamento, riassunto: amb.GITHUB_STEP_SUMMARY || '',
              menziona: amb.GITHUB_REPOSITORY_OWNER || '' })   /* la menzione fa arrivare la mail anche a chi non segue il repository */
    .then(r => console.log('Allarme: ' + r.azione))
    .catch(e => console.log('⚠ allarme: ' + senzaSegreti(e.message)))
    .finally(() => process.exit(0));
}
