<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.it.md)
<!-- doc-navigation:end -->

# Contribuire

Grazie per aver contribuito a migliorare Team AI Box. Diamo il benvenuto a chi contribuisce per la prima volta: segnalazioni di bug, traduzioni, documentazione, accessibilità, integrazioni di applicazioni e modifiche mirate al codice contano. Non è necessario un DGX Spark per migliorare documenti o componenti che possono essere controllati in modo indipendente.

## Dall'idea alla pull request

1. Cerca [problemi esistenti](https://github.com/weerocksllc/teamaibox/issues). Descrivere il problema dell'utente, il comportamento previsto, il comportamento effettivo e la versione pertinente. Discutere cambiamenti più ampi prima di investire in un'implementazione.
2. Effettua il fork del repository pubblico e clona il tuo fork. Creare un ramo focalizzato; non includono il sito Web di marketing privato, i dati di runtime o i modelli scaricati.
3. Segui [BUILDING](docs/open-source/BUILDING.it.md) per le build di nodi, pnpm e componenti locali. Il programma di installazione del nuovo dispositivo prevede un flusso di lavoro diverso: non eseguirlo mai su un computer contenente dati aziendali solo per sviluppare l'interfaccia utente.
4. Apportare la più piccola modifica coerente, aggiornare la documentazione interessata ed eseguire i controlli pertinenti. Spiegare eventuali controlli dipendenti dall'hardware che non è stato possibile eseguire.
5. Aprire una richiesta pull descrivendo il problema, la soluzione, l'impatto sulla compatibilità e le verifiche. Includi screenshot ripuliti per modifiche visibili. Rispondere al feedback delle recensioni; i manutentori esaminano prima della fusione.

Uno spazio di lavoro OpenSpec locale è facoltativo e non è pubblicato in questo repository. I contributori pubblici possono inserire una proposta e criteri di accettazione direttamente in un numero o in una PR; per partecipare non è richiesta alcuna specifica privata mancante.

## Traduzioni e screenshot

Per l'elenco dettagliato delle funzionalità, modifica `docs/readme-features/<locale>.json`; mantieni gli ID e l'ordine di gruppi e voci allineati alla versione inglese e aggiorna i riferimenti al codice sorgente in `docs/readme-features/evidence.json`.

Tutte le 17 lingue del prodotto hanno un file README. Modifica `docs/readme-locales/<locale>.json`, quindi esegui `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. Non modificare manualmente i README generati. L'elenco delle impostazioni locali proviene da `packages/ui-system/src/locale-registry.mjs`. Le guide collegate all'installazione, alla creazione, alla contribuzione, alla sicurezza e alla licenza utilizzano le stesse 17 lingue. Il loro elenco di documenti è in `docs/document-locales/manifest.json`. Modifica la pagina nella lingua di partenza e le traduzioni dei paragrafi in `docs/document-locales/<locale>.json`, quindi esegui `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. Le chiavi di traduzione sono hash SHA-256 dei paragrafi di origine; una modifica all'origine fallisce il renderer finché le traduzioni corrispondenti non vengono aggiornate. Gli esempi di codice vengono condivisi parola per parola e i collegamenti ai documenti vengono generati per la lingua selezionata. Le nuove traduzioni sono bozze assistite da macchina con codice e collegamenti protetti; è gradita la revisione linguistica e terminologica. La generazione e i controlli vengono eseguiti localmente, senza servizio di traduzione, chiave API o accesso a un'appliance. Consulta [la politica sugli screenshot](docs/assets/screenshots/README.it.md) prima di aggiungere immagini pubbliche. Le traduzioni, inclusa la terminologia e il fraseggio naturale, sono contributi di revisione benvenuti.

## Regole di contribuzione

- I contributi originali vengono inviati con la licenza MIT del repository. Conserva le intestazioni di terze parti e indica la fonte/licenza del materiale copiato. Non è richiesto alcun CLA obbligatorio separato o autorizzazione di collaboratore a pagamento.
- Utilizza il Nodo 24 e la versione pnpm bloccata in `package.json`. I requisiti di Python e Go sono descritti in [BUILDING](docs/open-source/BUILDING.it.md).
- Esegui solo i test rilevanti per la tua modifica e segnala esattamente cosa è stato eseguito. Un dispositivo locale non costituisce una pretesa di reale accettazione del dispositivo. Non ripetere o cancellare i risultati storici dell'accettazione semplicemente per chiudere una modifica alla documentazione.
- Non testare mai l'eliminazione, la reinstallazione o il ripristino dei dati di un utente. Utilizzare strutture sintetiche o risorse temporanee esplicitamente designate.
- Nessuna chiave privata, token, cookie, richieste/file del cliente, immagini di ospiti che hanno effettuato l'accesso, istantanee di distribuzione privata o screenshot personali in problemi/PR. Consulta [SICUREZZA](SECURITY.it.md) per la segnalazione privata.
- Mantieni `private: true` sui pacchetti Workspace. Non riscrivere mai la cronologia Git condivisa, spostare i tag di consegna o pubblicare artefatti di build privati ​​come parte di una PR.

Documenta test, migrazioni e cambiamenti di comportamento rilevanti nel tuo contributo. I controlli dipendenti dall'hardware devono identificare la configurazione e i limiti effettivi.
