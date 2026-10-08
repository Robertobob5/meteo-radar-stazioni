/* ════════════════════════════════════════════════════════════════
   Meteo Radar · il RINFRESCO degli aeroporti (ponte 3.3 · 8 ottobre 2026)

   Fra un giro lungo e l'altro (Netatmo ogni ~23 minuti: più spesso non
   si può, 500 chiamate l'ora) il METAR invecchiava in mano all'app: il
   bollettino nasce ogni 30 minuti (a Bologna alle :20 e alle :50), il
   giro lo leggeva anche 25 minuti dopo, poi 5 minuti di cache di GitHub
   e 4 di ciclo dell'app. L'8 ottobre alle 12:39, con la pioggia addosso,
   l'app ha smesso di credere all'aeroporto perché il bollettino in mano
   le era "scaduto" e quello nuovo non era ancora arrivato.

   Questo programma chiede SOLO i METAR (una chiamata, nessun segreto,
   nessuna chiamata a Netatmo) e, se almeno un'osservazione è cambiata,
   riscrive aeroporti.json. Il workflow lo lancia ogni 6 minuti durante
   la pausa fra un giro e l'altro e pubblica soltanto quando questo
   risponde "cambiato" (uscita 0). Uscita 3 = niente di nuovo, o servizio
   muto: non si pubblica niente e resta il file di prima.
   Le stazioni, le celle, la reputazione: non le tocca.

   Uso: node ponte_aeroporti.mjs   (dalla cartella del repository)
   ════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { aeroporti, stessoFile } from './ponte_stazioni.mjs';

export const USCITA_CAMBIATO = 0;
export const USCITA_UGUALE = 3;
export const TEMPO_MAX_METAR_MS = 20000;   /* il servizio degli aeroporti ha 20 secondi: se tace, resta il file di prima */

/** la firma di una lista di osservazioni: quali aeroporti, e l'ora di ciascuna */
export function firma(lista) {
  return (Array.isArray(lista) ? lista : []).map(a => String(a && a.icao) + '@' + String(a && a.ts)).sort().join(' ');
}

/** la chiamata con un tempo massimo: una fetch senza limite potrebbe mangiarsi i minuti del workflow */
export const conTempo = (chiama, ms = TEMPO_MAX_METAR_MS) => (indirizzo, opzioni) =>
  chiama(indirizzo, Object.assign({}, opzioni || {}, typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {}));

/**
 * Legge i METAR e riscrive aeroporti.json solo se c'è almeno un'osservazione nuova.
 * Risponde { cambiato, motivo, osservazioni, nuove }.
 */
export async function rinfresca(radice = process.cwd(), chiama = fetch, registro = console, adesso = Date.now()) {
  const file = path.join(radice, 'aeroporti.json');
  let prima = null;
  try { prima = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { prima = null; }
  const vecchie = prima && Array.isArray(prima.aeroporti) ? prima.aeroporti : [];
  const nuove = await aeroporti(conTempo(chiama), registro);
  if (!nuove.length) {
    registro.log('  ↻ aeroporti: servizio muto, resta il file di prima (' + vecchie.length + ' osservazioni)');
    return { cambiato: false, motivo: 'muto', osservazioni: vecchie.length, nuove: 0 };
  }
  if (firma(nuove) === firma(vecchie)) {
    registro.log('  = aeroporti: nessuna osservazione nuova (' + nuove.length + ')');
    return { cambiato: false, motivo: 'uguale', osservazioni: nuove.length, nuove: 0 };
  }
  const primaTs = new Map(vecchie.map(a => [String(a && a.icao), String(a && a.ts)]));
  const quante = nuove.filter(a => primaTs.get(String(a.icao)) !== String(a.ts)).length;
  fs.writeFileSync(file, JSON.stringify({ aggiornato: adesso, aeroporti: nuove }));
  registro.log('  ✔ aeroporti: ' + quante + ' osservazioni nuove su ' + nuove.length + ' → aeroporti.json riscritto');
  return { cambiato: true, motivo: 'nuove', osservazioni: nuove.length, nuove: quante };
}

if (stessoFile(import.meta.url, process.argv[1])) {
  rinfresca().then(r => { console.log('Fatto:', JSON.stringify(r)); process.exit(r.cambiato ? USCITA_CAMBIATO : USCITA_UGUALE); })
             .catch(e => { console.log('✘ ' + e.message); process.exit(USCITA_UGUALE); });
}
