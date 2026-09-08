# Meteo Radar · stazioni vicine

Questo repository fa da **ponte** fra l'app Meteo Radar e le stazioni meteo
pubbliche: ogni ora un lavoro automatico (`.github/workflows/stazioni.yml`)
interroga Netatmo (stazioni domestiche pubbliche di tutta l'Italia) e gli
aeroporti italiani (osservazioni ufficiali METAR), e pubblica le letture sul
ramo **`dati`**, un file per cella di 1° di latitudine/longitudine.

L'app scarica soltanto la cella dove si trova l'utente: pochi KB, nessun
segreto, nessuna chiave. I codici Netatmo stanno nei *Secrets* di questo
repository e non escono mai da qui.

- `ponte_stazioni.mjs` — il programma (Node, senza dipendenze)
- ramo `dati` — le letture: `indice.json`, `aeroporti.json`, `celle/<lat>_<lon>.json`
  e la reputazione: `reputazione/<lat>_<lon>.json`

## La reputazione delle stazioni (ponte 3)

A ogni giro, per ogni stazione, si annotano due cose diverse che non vanno
confuse:

- il **difetto personale** del sensore: quanto legge rispetto alla mediana
  delle altre entro 25 km, riportate alla sua quota. Di notte quel numero è
  l'errore fisso del sensore; col sole alto la differenza in più è il sole che
  gli batte addosso. Non serve nessun aeroporto: basta avere quattro stazioni.
- la **differenza di zona**, che è vera e non va corretta: quanto la zona sta
  sopra o sotto l'aeroporto di riferimento (collina contro pianura, città
  contro campagna).

Il cielo (notte · velato · sole) si ricava dall'altezza del sole, calcolata, e
dalle nubi del METAR più vicino. Non si conserva nessuna cronologia: solo
somme, che ogni giorno pesano un po' meno (metà dopo tre settimane), così una
stazione spostata o riparata torna pulita da sola.

Ogni file contiene, per stazione: `f` (errore fisso), `s` (eccesso col sole),
`zf` (quanto la zona sta sopra l'aeroporto), `q` (quanta fiducia meritano,
da 0 a 1) e `v` (`buona` · `sole` · `alta` · `bassa` · `poco`), più le somme
grezze da cui vengono. Serviranno all'app dalla v72.2 in poi.

Le stazioni Netatmo sono centraline private: l'app usa la **mediana** delle
più vicine e scarta i valori fuori scala; l'aeroporto resta la misura ufficiale.
