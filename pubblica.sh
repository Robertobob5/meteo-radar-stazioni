#!/usr/bin/env bash
# Meteo Radar · pubblica lo stato di adesso sul ramo "dati" (ponte 3.4)
#
# Il ramo "dati" contiene SEMPRE un solo commit: si costruisce da zero in una
# cartella a parte e si spinge con --force (niente cronologia che cresce).
#
# Si pubblica la cartella PONTE_DATI INTERA: il workflow ci mette dentro tutto
# il ramo dati all'inizio del lavoro, e i programmi ci riscrivono solo quello
# che rifanno. Così quello che un giro non rifà (indice.json quando il giro
# fallisce, la reputazione, lo stato, un file nuovo) resta com'era: prima si
# copiava un elenco di file, e il 15 ottobre indice.json non c'era.
#
# La usa il workflow dopo ogni giro e ponte_stazioni.mjs appena ha salvato un
# gettone di rinnovo nuovo, PRIMA di cominciare a raccogliere: così un giro
# interrotto non può più perderlo.
#
# Risponde sempre 0: una spinta mancata si riprova al giro dopo.
# Variabili: PONTE_DATI (la cartella), GH_TOKEN e GITHUB_REPOSITORY (dal
# workflow), PONTE_ERRORE (il file dove annotare una spinta non riuscita, per
# l'allarme); PONTE_REMOTO e PONTE_PAUSA_SPINTA servono solo alle prove.

dati="${PONTE_DATI:-${RUNNER_TEMP:-/tmp}/dati}"
remoto="${PONTE_REMOTO:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
pub="${RUNNER_TEMP:-/tmp}/pub"

if [ -z "$(ls -A "$dati" 2>/dev/null)" ]; then
  echo "NON pubblicato: la cartella del ramo dati ($dati) è vuota"
  exit 0
fi
rm -rf "$pub" && mkdir -p "$pub"
cp -a "$dati/." "$pub/"
rm -rf "$pub/.git"

cd "$pub" || exit 0
git init -q -b dati
git config user.name "Meteo Radar"
git config user.email "stazioni@meteoradar.local"
git add .
git commit -q -m "Letture del $(TZ=Europe/Rome date '+%d/%m/%Y %H:%M')"
# la spinta su GitHub può cadere per un attimo di rete: si riprova
for tentativo in 1 2 3; do
  if git push -q --force "$remoto" dati; then
    echo "pubblicato"
    exit 0
  fi
  echo "spinta su GitHub non riuscita (tentativo $tentativo)"
  sleep "${PONTE_PAUSA_SPINTA:-15}"
done
echo "NON pubblicato: si riprova al prossimo giro"
[ -n "$PONTE_ERRORE" ] && echo "spinta sul ramo dati non riuscita dopo 3 tentativi" >> "$PONTE_ERRORE"
exit 0
