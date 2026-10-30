<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.it.md)
<!-- doc-navigation:end -->

# Costruisci la fonte

L'elemento pubblico è l'origine, non un'immagine dell'appliance offline predefinita. Una build di origine può scaricare dipendenze; l'installazione utilizzando un pacchetto completo preparato rimane offline. Nessuno dei due processi necessita di un ViKey SDK o di una chiave USB.

Per un'installazione completa dell'appliance, inizia con il root [avvio rapido](../../README.it.md#install) e il [programma di installazione sorgente](../../install/SOURCE-INSTALL.it.md): `sudo bash install/from-source.sh` scarica, crea, crea pacchetti e installa su un nuovo Spark compatibile. La build web di sviluppo riportata di seguito non è il programma di installazione e non avvia il prodotto completo.

## Sviluppo

Utilizza Node.js 24, pnpm 11.1.3 (vedi root `package.json`), Python 3.10+ e la versione Go dichiarata in ogni `go.mod` (node-agent attualmente 1.26). Su una macchina di costruzione:

Un'esportazione di origine deliberatamente non ha una cronologia Git privata. Prima di eseguire gli strumenti di origine sull'albero esportato, inizializza il tuo repository e conferma l'albero revisionato (`git init`, `git add .`, `git commit`). Un normale clone Git pubblico non necessita di questo passaggio. Usa quel nuovo commit come identità di build; non rivendicare che un albero esportato e modificato sia il vecchio commit di consegna.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

La creazione web è un controllo della compilazione, non l'accettazione del prodotto. I servizi runtime utilizzano i Dockerfile in `deploy/`. L'esecuzione di DGX Spark richiede Linux ARM64 e l'ambiente NVIDIA/Docker esistente. Un checkout di origine desktop non sostituisce tale hardware. Non utilizzare script di laboratorio storici come programmi di installazione.

Gli aiutanti per la compilazione di fabbrica di Python richiedono inoltre PyYAML; vedere il preflight sulle dipendenze del programma di installazione. Non è richiesto alcun disco del sistema operativo installato o account sviluppatore.

## Ingressi compilati esclusi

L'esportatore omette i file binari, anche quando la loro estensione sembra innocua:

- Crea `services/node-agent` e il suo helper `cmd/factory-worker-spec` dal sorgente Go; l'eseguibile repository-root `node-agent` non è un input di origine.
- Gli APK dei dispositivi Android e i file di firma non vengono spediti. La loro origine e i manifest in `tools/fixtures/` rimangono disponibili per le build di test locali.
- L'attuale build di casting dell'appliance utilizza `deploy/appliance/wireless-casting-plugin.Dockerfile`. Non necessita dei vecchi archivi del pacchetto Alpine. Se utilizzi invece il plug-in autonomo Dockerfile, ottieni i pacchetti esatti identificati nel [suo manifest di checksum upstream](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) e verifica i loro valori SHA-256 prima della creazione. Non sostituire mai un pacchetto arbitrario quando l'artefatto upstream bloccato non è disponibile.
- Il modulo del browser LiveKit e la sua licenza rimangono nella directory pubblica dei sorgenti del plugin; l'archivio ridondante npm `.tgz` non viene spedito.

Si tratta di esclusioni della distribuzione di origine, non di modifiche all'appliance in esecuzione.

## Pacchetto offline completo

Inizia con [la pipeline di origine pubblica](../../install/PUBLIC-BUILD.it.md). Fornisce le immagini principali pubbliche e le dipendenze di runtime create dal codice sorgente; non è richiesta una precedente installazione da parte dello sviluppatore. Le ricette di immagini a livelli storici non sono il punto di ingresso per la nuova installazione.

Segui [install/README.md](../../install/README.it.md) per build di immagini dell'applicazione, strumenti host guest, pacchetti host offline, raccolta di risorse e confezionamento finale. L'appliance di destinazione non recupera le dipendenze né sostituisce Docker/NVIDIA. Imposta gli input di compilazione sul commit di origine effettivo, sugli ID contenuto OCI ARM64 e sui percorsi delle risorse pulite. Non è richiesto alcun IP, account, certificato o volume dell'host di sviluppo. I pesi dei modelli e le risorse guest/runtime vengono ottenuti separatamente dalle esatte origini upstream identificate in [components.json](components.json) e dai blocchi del repository. Conservare le licenze e gli avvisi sulla fonte richiesti.

**La disponibilità del codice sorgente non è un'autorizzazione alla ridistribuzione binaria.** L'attuale contratto completo del pacchetto offline include un runtime di Google Android; la prova dell'installazione privata non costituisce l'autorizzazione a distribuire GMS. Il packager esistente viene mantenuto invariato, ma tale pacchetto non è un download pubblico approvato a meno che non vengano ottenuti tali diritti. Un'edizione binaria pubblica solo AOSP rappresenterebbe una modifica al pacchetto con ambito separato, non sostituita silenziosamente qui. I file ISO Windows/Linux vengono forniti da ciascun utente; nessun guest di prova installato o stato dell'account è input di build pubblica.
