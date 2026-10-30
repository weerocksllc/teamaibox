<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.it.md)
<!-- doc-navigation:end -->

# Team AI Box strumenti per pacchetti offline

Il programma di installazione originale ha la licenza MIT. I pacchetti includono la licenza root, l'inventario di terze parti e i testi delle licenze nel loro inventario degli hash dei file. Ciò non concede nuovamente la licenza a modelli, servizi Google, driver o dipendenze del contenitore come MIT. Leggere i [limiti della versione](../docs/open-source/RELEASING.it.md) prima della distribuzione; un pacchetto di test completo esistente non dispone automaticamente dell'autorizzazione alla ridistribuzione.

I clienti eseguono **`sudo ./install.sh` all'interno del pacchetto preparato**. I manutentori creano quel pacchetto con `build-package.sh`. I clienti offline non hanno bisogno di repository Git, Node, Go, pip o di pacchetti pubblici.

Per il download, la creazione e l'installazione automatici da un clone pubblico, esegui `sudo bash install/from-source.sh`. Le reti in Cina possono utilizzare `--region cn`. Consulta [SOURCE-INSTALL.md](SOURCE-INSTALL.it.md) per il funzionamento, la ripresa e il trasferimento offline. Il curriculum è supportato; solo il risultato finale di disponibilità stabilisce il completamento dell'installazione. Una verifica preliminare o un download riuscito non è sufficiente.

L'obiettivo è un nuovo DGX Spark con il suo sistema Ubuntu 24.04 ARM64 di fabbrica e Docker Engine, Compose v2, NVIDIA Container Toolkit/GPU e KVM funzionanti. Il programma di installazione non sostituisce Docker/NVIDIA, non riavvia Docker né copia gli account, il database, le chiavi o le macchine virtuali di un'appliance di sviluppo.

> I record di accettazione dell'installazione privata rimangono nel repository di sviluppo storico. Non sono né file di origine pubblici né input di build. Le prove esistenti di prima installazione, ripristino e ripristino di avvio non vengono rieseguite semplicemente per la pubblicazione dell'origine e non qualificano immagini arbitrarie di nuova creazione né garantiscono diritti di ridistribuzione per file binari di terze parti.

## Manutentori: preparano gli input di rilascio

**Per una nuova build pubblica di GitHub, inizia con [PUBLIC-BUILD.md](PUBLIC-BUILD.it.md).** Copre immagini pubbliche, tempi di esecuzione della fotocamera, download/quantizzazione di modelli e firmware senza richiedere immagini da un'appliance di sviluppo. Gli helper di immagini a livelli riportati di seguito supportano gli aggiornamenti incrementali degli artefatti verificati; non sono prerequisiti per una nuova build.

La preparazione può utilizzare Internet. L'installazione dal pacchetto consegnato non deve scaricare dipendenze. L'host del pacchetto richiede Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` e spazio di archiviazione sufficiente. I modelli e le immagini possono essere di grandi dimensioni; il packager conserva sia l'albero estratto che `.tar`, stimando lo spazio dagli input effettivi. Non esegue la scansione di un intero dispositivo di sviluppo né esporta livelli scrivibili da contenitori in esecuzione.

1. Preparare le immagini ARM64 da **una versione di rilascio** per tutti i ruoli richiesti. Utilizza i punti di ingresso della build in `deploy/images/`, `deploy/appliance/` e le directory guest/modello corrispondenti. L'API della piattaforma, l'agente del nodo, lo scheduler e il controller dell'agente devono supportare gli ID immagine locali; l'immagine PostgreSQL deve contenere il manifesto della migrazione corrente, inclusa la migrazione 116. Il creatore di pacchetti non compila una vecchia immagine arbitraria in una corrente. Con le immagini principali della stessa versione verificate, utilizza `build_runtime_images.py --bases … --node-agent-binary … --output …` per creare le cinque immagini successive. `--bases` è una mappa JSON da ruolo a ID immagine completo. Per prima cosa crea l'agente del nodo con `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Questo helper impedisce pull/creazioni di rete, registra identità padre/origine e crea nuove immagini senza distribuire o modificare tag attivi. Anche le ROM Android pulite necessitano dell'attuale adattatore di rete di controllo. Utilizza `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` per aggiungere `phone_network.py` a entrambi i livelli successivi della ROM senza accesso alla rete o modifiche ai dati ROM. Registra gli ID esatti delle immagini e i riassunti delle fonti. Associa il sidecar Android ad entrambi i nuovi ID, non a quelli precedenti. Crea il Web e nove app ufficiali utilizzando `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Per prima cosa costruisci il web come specificato da `apps/web/package.json`. L'helper utilizza i Dockerfile di produzione, corregge la directory web su `/opt/teamaibox/web` e confronta i file di immagine con gli attuali hash di input della build. Non dare per scontato che un'immagine del contenitore di sviluppo sia una build Web completa: potrebbe dipendere da variabili di directory statiche aggiuntive o contenere una vecchia directory. Questo helper offline non viene distribuito. Inserisci tutti e dieci i nuovi ID immagine negli input di rilascio.
2. Raccogli directory complete e pulite per sei modelli: configurazione, shard, tokenizer, codice richiesto e licenze. Prepara anche due immagini Android pulite, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` e gli script di runtime di disegno. Non raccogliere directory di istanze del telefono, dischi utente, stato di accesso di Google, ISO utente o credenziali globali. Le ROM Android sono già all'interno di `phone-runtime` / `phone-google-runtime`; non copiare un secondo disco. Le directory degli asset `android-standard` / `android-google` contengono solo provenienza, licenze e `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` e `runtimeImageId: "sha256:…"`. L'ID deve corrispondere all'immagine runtime esportata. La directory dei driver contiene solo `virtio.iso`; una directory di sviluppo contenente anche `windows.iso` viene rifiutata.
3. Costruisci i due strumenti host Linux ARM64 in bundle senza installarli sull'host di compilazione:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Su un host di build ARM64 connesso a Internet, raccogli le dipendenze dello strumento host utilizzando un'immagine Ubuntu 24.04 locale esplicita. Utilizza l'ID immagine verificato su quell'host, non un ID copiato da un'appliance di sviluppo:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Raccogli solo le dipendenze per cryptsetup, ext4, USB/fotocamere, strumenti di immagine QEMU, rete e piccole utilità di sistema. Sono vietati i pacchetti Docker, containerd, NVIDIA, CUDA e la sostituzione del kernel. L'installazione fornisce solo gli strumenti mancanti; apt legge il repository di file locale del pacchetto con `--no-download --no-remove`, senza fallback online.

5. Genera il manifest di input di rilascio e fornisci **percorsi espliciti degli artefatti e ID del contenuto dell'immagine locale**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Il modello include tutti i 41 ruoli immagine e 12 categorie di risorse esterne; un altro asset della fabbrica viene generato dagli strumenti. I segnaposto non possono inserire un pacchetto. `sourceCommit` deve corrispondere al checkout, `agentVersion` alla build effettiva dell'agente e `hostPackageCollection` al passaggio 4 `collection.json`. I percorsi build-host sono input di raccolta, non configurazioni di runtime del cliente. Utilizza il generatore di fabbrica corrente: i percorsi `drawing.automatic` / `drawing.fast` dell'interfaccia utente del disegno devono corrispondere alla configurazione del modello locale. La salute dei lavoratori o una chiamata diretta da parte di un modello da sole non stabiliscono la disponibilità della domanda. Il packaging rifiuta i modelli di fabbrica obsoleti privi di queste mappature.

Il contratto del ruolo immagine è segnalato da `python3 install/package.py --describe-contract`:

- Core, Web, unità del team, messaggistica, gateway, pianificazione, manutenzione, plug-in, sandbox di agenti dinamici e gateway di origine pacchetto.
- Nove plug-in dell'applicazione, sei lavoratori modello di ufficio e tempi di esecuzione ASR/altoparlante su richiesta.
- Android standard, Google Android, runtime del computer e gateway audio/visualizzazione Web.
- Ricevitore di casting, elaborazione multimediale e SFU.

Due ruoli possono condividere un ID contenuto immagine; il suo archivio viene esportato una sola volta. Vengono controllati anche gli indici dei frammenti del modello: gli hash dei file corrispondenti non giustificano un frammento mancante. Gli strumenti host devono essere effettivi binari ELF ARM64.

## Costruisci il pacchetto

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Gli output sono `teamaibox-<releaseId>-linux-arm64.tar`, il suo file `.sha256` e la directory estratta. La copia, l'esportazione delle immagini, l'hashing e l'archiviazione avvengono in una directory temporanea prima della pubblicazione del checksum finale. Gli output esistenti non vengono sovrascritti; una build interrotta non deve sembrare una release completa. Per modifiche riservate al solo installatore con identità di immagine invariate, utilizzare `--image-cache <previous-extracted-package>`. L'intero vecchio pacchetto viene verificato prima che i suoi archivi vengano riutilizzati dall'ID immagine effettivo e il nuovo pacchetto viene nuovamente verificato. Nessun dato viene prelevato da una vecchia installazione o da un livello scrivibile del contenitore. Ciò evita di esportare nuovamente centinaia di GB di immagini identiche.

Una versione normale richiede che i file sorgente in bundle appartengano al commit Git dichiarato. Un `--allow-working-tree` esplicito crea un candidato allo sviluppo; il suo manifest registra `candidate: true` e file modificati. Passare l'accettazione mirata non trasforma la fonte non vincolata in una versione pubblicata.

Disposizione del pacchetto:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Verifica in modo indipendente con `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Questo controlla l'integrità; non dimostra un avvio riuscito su nuovo hardware.

## Clienti: installazione offline e ripristino

Leggi la [guida all'installazione del pacchetto](PACKAGE-README.it.md). La radice predefinita è `/srv/teamaibox/installation`. LUKS/ext4 viene creato solo all'interno del nuovo `volume/data.img`, non sul disco di sistema o sui dischi esistenti. Il pool di dati utilizza lo spazio di archiviazione disponibile meno un margine di sicurezza fisica, non un limite fisso di 256 GiB. Modelli, file aziendali e dati degli ospiti risiedono nel volume crittografato; Docker esistente gestisce le immagini del contenitore.

Una nuova installazione crea l'amministratore `admin` con la password iniziale `admin`. Gli utenti ordinari vengono creati dall'amministratore. Modificare la password iniziale prima della consegna/utilizzo. Ciò si applica solo a un database di account vuoto: riprendere, eseguire nuovamente, riavviare e aggiornare non reimposta gli account o le password esistenti. L'identità del dispositivo, le credenziali del servizio, i certificati e i codici di ripristino dell'amministratore vengono generati in modo indipendente, non copiati da un altro dispositivo. La preparazione iniziale della cache del kernel della GPU viene eseguita sull'appliance utilizzando strumenti e modelli in bundle; le cache compatibili vengono conservate. Il ripristino dell'avvio ripristina prima i dati e i servizi del dispositivo, quindi i servizi principali e i singoli operatori AI. Il programma di installazione viene eseguito solo durante l'installazione; non aggiunge alcun gestore di installazione residente.

Dopo l'interruzione, ripetere il comando originale. I passaggi completati vengono verificati; non nascondere i conflitti eliminando dati o ricreando contenitori. La riesecuzione di un'installazione della stessa versione completata lo controlla solo; versioni diverse utilizzano il percorso di aggiornamento formale. I dettagli dell'errore si trovano in `install-state.json`, `readiness.json` e i record di fase nella root di installazione.

## Confini di verifica

I test specifici dell'installatore utilizzano piccoli artefatti strutturali, file temporanei e database offline/daemon Docker isolati. Non devono accedere ai database aziendali o montare dischi VM esistenti. Una vera nuova installazione richiede un DGX Spark compatibile esplicitamente designato a tale scopo; non cancellare un'appliance aziendale. L'accettazione copre l'avvio minimo, il curriculum e il ripristino dell'avvio per la nuova installazione, non test aziendali indipendenti. La preparazione del rilascio del codice sorgente in sé non cancella, reinstalla o distribuisce le apparecchiature esistenti.

Su un host di build, esegui `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` per importare il pacchetto completo in un daemon Docker separato con una cache vuota e senza rete pubblica. Non richiama lo script di nuova installazione, non utilizza una GPU, non monta le directory dei clienti né riavvia il sistema Docker. Il suo rapporto non afferma esplicitamente l'installazione completa dell'hardware. Le immagini di test rimangono nella directory di test dedicata, richiedono spazio su disco aggiuntivo e non entrano nell'archivio immagini del sistema Docker.
