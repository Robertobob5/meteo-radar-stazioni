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
- `ponte_aeroporti.mjs` — il rinfresco dei soli METAR fra un giro e l'altro
- `ponte_allarme.mjs` — il riassunto di fine lavoro e l'allarme (ponte 3.4)
- `pubblica.sh` — la pubblicazione sul ramo `dati` (ponte 3.4)
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

## Se il ponte si ferma (ponte 3.4)

Il lavoro resta verde anche quando un giro fallisce (si riprova al giro dopo),
quindi un errore non si vede dal colore. Per questo, alla fine di ogni giro
lungo, `ponte_allarme.mjs`:

- scrive nel riassunto del lavoro una riga come
  «Stazioni: ultimo aggiornamento 15/10 07:56 (6 min fa) · Aeroporti: 15/10 07:59»;
- se le stazioni sono ferme da più di 2 ore apre **una** issue
  «Ponte stazioni fermo», con l'ultima riga d'errore (senza segreti): GitHub
  manda una mail;
- quando le stazioni tornano fresche la chiude da sola, con un commento.

All'inizio di ogni lavoro il ramo `dati` si prende **intero** in una cartella
a parte; i programmi lavorano lì dentro e `pubblica.sh` ripubblica la cartella
intera. Quello che un giro non rifà (`indice.json` quando il giro fallisce, la
reputazione, lo stato) resta com'era. Se il ramo c'è ma non si legge, il lavoro
non fa giri: un ramo vuoto pubblicato sopra cancellerebbe la reputazione.

Il gettone di rinnovo Netatmo vive cifrato in `stato/netatmo.enc` sul ramo
`dati`, quello d'accesso (dura 3 ore) in `stato/accesso.enc`: il rinnovo si
chiede solo quando quello d'accesso sta per scadere, e un gettone di rinnovo
nuovo si pubblica subito, prima di raccogliere. Se Netatmo rifiuta il gettone
salvato, il lavoro prova da solo il segreto `NETATMO_REFRESH_TOKEN`.

### Se serve un gettone nuovo

Solo se la issue dice `invalid_grant` o «serve un gettone nuovo nei Secrets».
Il gettone non va mai incollato in una chat, in una issue o in un file.

1. Apri **dev.netatmo.com** ed entra col tuo account.
2. In alto: **My apps** → la tua app.
3. Scendi a **Token generator**: scegli lo scope **read_station** e premi
   **Generate token** (Netatmo chiede di autorizzare: conferma).
4. Copia il **refresh token** (non l'access token).
5. Su GitHub, repository **meteo-radar-stazioni** → **Settings** →
   **Secrets and variables** → **Actions** → **NETATMO_REFRESH_TOKEN** →
   **Update** → incolla → **Save**.

Al giro dopo il lavoro vede che il gettone salvato non vale più, usa questo,
lo salva cifrato e la issue si chiude da sola quando le stazioni tornano fresche.

## Orari fissi, rete di sicurezza e prova dell'allarme (ponte 3.5)

Netatmo concede 500 richieste l'ora per utente (e 50 ogni 10 secondi). Le
raccolte partivano a 23 minuti l'una dall'altra dentro un lavoro e a 5 minuti a
cavallo fra due lavori: dal 12 al 15 ottobre l'ora mobile è arrivata a 631.

Ora le raccolte cadono a **orari fissi, tre l'ora: ai minuti :05, :25 e :45**.
Ogni giro aspetta il suo prossimo orario libero (nell'attesa, ogni 6 minuti, si
rinfrescano i METAR); l'ultimo orario fatto si segna in `stato/orario.json` e si
pubblica *prima* di raccogliere, così due raccolte non cadono mai nello stesso
orario, neanche fra un lavoro e il successivo. Un orario saltato non si recupera.
Un lavoro fa le raccolte che cominciano entro 50 minuti dalla sua partenza (di
solito due) e dura una quarantina di minuti; gli orari dopo li fa il lavoro dopo,
già prenotato.

Ogni richiesta a Netatmo (gettone e ritentativi compresi) si annota in
`stato/chiamate.json`. Prima di ogni mattonella una **rete di sicurezza** guarda
l'ora mobile: se si andrebbe oltre **480**, la raccolta si ferma lì e il resto passa
al giro dopo. Con gli orari fissi non scatta mai (sui giri dal 12 al 15 ottobre il
picco sarebbe stato 464). Se scatta, la raccolta dopo comincia dalla mattonella
dove si era fermato il taglio, così il taglio gira per tutta Italia invece di
cadere sempre sul Nord; le raccolte normali partono sempre dalla prima.

Per provare l'allarme senza aspettare un guasto: **Actions** → **Stazioni
vicine** → **Run workflow** → accendi **prova_allarme** → **Run workflow**. Il
lavoro apre la issue «Prova allarme ponte» (dallo stesso account dell'allarme
vero, con la stessa menzione) e la chiude dopo 2 minuti, senza toccare le
stazioni né il ramo `dati`. I giri che si prenotano da soli non la accendono mai.
