<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.it.md)
<!-- doc-navigation:end -->

# Costruisci un'appliance dalla fonte pubblica

Il nuovo punto di ingresso dell'orchestrazione è documentato in [SOURCE-INSTALL.md](SOURCE-INSTALL.it.md). Automatizza le ricette seguenti; lì è indicato lo stato di verifica dell'apparecchio completo. Queste ricette manuali rimangono disponibili per i manutentori e per la diagnosi delle singole fasi.

Questo è il percorso dall'origine al pacchetto. Non importa un'installazione precedente di Team AI Box, i suoi contenitori, account, certificati, ospiti o database. La macchina di costruzione necessita dell'accesso a Internet; il pacchetto completo risultante viene installato offline. Il cliente fornisce i supporti di installazione Windows/Linux separatamente.

Utilizza Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 e spazio su disco sufficiente per i download dei sorgenti, i livelli di creazione e il bundle finale non compresso. La quantizzazione del modello richiede anche una GPU NVIDIA compatibile con memoria libera sufficiente. Non interrompere altri carichi di lavoro per ottenere quella memoria senza il permesso del proprietario della macchina. Docker e NVIDIA sono prerequisiti, non componenti sostituiti dal programma di installazione.

Esegui comandi da un nuovo checkout pubblico. Imposta `BUILD` su una nuova directory di build assoluta **esterna** al checkout. Risultati, modelli e relazioni non devono essere vincolati. Ogni aiutante rifiuta un'uscita occupata a meno che non documenti una specifica operazione di ripresa. Utilizza i riferimenti/ID del report riuscito, non i nomi delle immagini copiate dal computer di qualcun altro. Un ID contenuto Docker locale non è un riferimento al registro scaricabile; Gli argomenti principali del Dockerfile necessitano del tag locale corrispondente o di un digest upstream qualificato.

## 1. Servizi e applicazioni

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` influisce sulle **build** online, non sulla rete dei servizi installati. Le fasi di dipendenza del nodo consentono 2 secondi per tentativo di connessione invece del valore predefinito del nodo di 250 ms. Ciò mantiene i download npm ufficiali utilizzabili su collegamenti a latenza più elevata, comprese le VPN gestite dall'utente, senza cambiare registro, disabilitare IPv6 o indebolire i controlli di integrità TLS/pacchetto. L'impostazione è un argomento della fase di creazione, non una modifica dell'ambiente nell'applicazione installata. Per un collegamento più lento, le build Docker dirette possono sovrascrivere `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. L'immagine Web crea le proprie dipendenze e risorse bloccate. I servizi del nodo condividono la chiusura delle dipendenze API appena creata. OCR include il suo adattatore pubblico; non necessita di un pacchetto di lavoro non pubblicato da un altro progetto. La traduzione utilizza l'immagine vLLM pubblica NVIDIA bloccata. L'incorporamento, l'ASR batch e il casting media condividono deliberatamente le rispettive immagini di runtime pubbliche. L'immagine del computer crea QEMU 11.1.1 con firma verificata con supporto ARM TPM/PPI, KVM, VNC e PulseAudio, preservando le funzionalità del runtime Windows originale. Debian fornisce librerie runtime, ma il suo vecchio pacchetto QEMU non deve sostituire questo eseguibile. L'immagine finale controlla sia la proprietà ARM TIS `ppi` che il backend PulseAudio e include la ROM framebuffer RAM corrispondente. Consulta [la guida al runtime del computer virtuale](../deploy/windows-computer/README.it.md) per il test di runtime limitato e i requisiti di aggiornamento per la conservazione dei dati.

Ogni ruolo ha un registro. Un report non riuscito conserva gli output del ruolo riusciti; crea solo il ruolo non riuscito e unisci i report riusciti in un secondo momento. Non sostituire un contenitore di sviluppo in esecuzione come immagine mancante.

## 2. Autonomia Android e fotocamera senza account

I blocchi bloccano la build AOSP di Google, il pacchetto host, gli input del kernel e le revisioni dei sorgenti. I download vengono controllati prima dell'uso. Nessun ospite viene avviato durante l'assemblaggio.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Per la patch APK della fotocamera, installa gli strumenti da riga di comando Android pubblici di Google, la piattaforma `android-36.1`, gli strumenti di compilazione `36.1.0` e un JDK che supporta la versione Java
8. Imposta `ANDROID_SDK_ROOT` and `JDK_HOME` su quelle directory degli strumenti. Gli strumenti sono dipendenze di creazione, non profili utente Android esportati. Su ARM64 Linux, il pacchetto `zipalign` di Google potrebbe essere solo x86: installa il pacchetto ARM64 `zipalign` di Ubuntu e passa `--zipalign /usr/bin/zipalign` di seguito. D8 e apksigner sono programmi Java. In alternativa, la build APK può essere eseguita su un host SDK supportato separato; trasferisce solo i suoi due file di output (`Camera2.apk`, `camera-preview.json`), mai le impostazioni Android o il profilo utente dell'host.

Estrai l'APK stock dalla build AOSP pulita (la directory di output deve esistere ed essere scrivibile dal contenitore di build):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

L'APK conserva il **firmatario pubblico del test AOSP** noto, non un codice Product Key privato. L'assistente verifica il certificato originale e risultante e le risorse APK invariate e rimuove il materiale di firma temporaneo. Questo non è un account o l'identità del dispositivo Google.

L'attuale contratto di installazione completo include anche una variante sperimentale di Google Android. Il blocco pubblico dell'input e il controllo della firma **non** garantiscono a Google la certificazione o i diritti di ridistribuzione. Costruirlo/utilizzarlo solo entro i termini applicabili di terze parti; non pubblicare il pacchetto completo risultante come download MIT senza restrizioni.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. File modello dell'editore e ricetta di quantizzazione pubblica

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Tutti i download dei modelli utilizzano le revisioni immutabili in `deploy/compute/*profile*` e gli hash Git/LFS dell'editore. Il facoltativo `--cache <directory>` è di sola lettura e accetta file solo quando i relativi byte corrispondono all'editore. Non è un modo per importare indiscriminatamente la directory del modello installato. Il testo autonomo di ASR MIT è aggiunto alla versione originale di Whisper perché lo snapshot del modello convertito dichiara solo la licenza. OCR mantiene la propria licenza, non MIT. Le schede modello di traduzione e incorporamento fissate dichiarano Apache-2.0 senza inviare il testo autonomo; i loro aiutanti includono la licenza Apache con checksum e un record di provenienza dopo aver controllato tale dichiarazione.

Un download corrispondente interrotto supporta `--resume`. `--transfer ranges` utilizza intervalli HTTP ripristinabili limitati; `--transfer huggingface` richiede i pacchetti ufficiali `huggingface_hub`/`hf_xet` e disabilita l'uso dei token. I partial e le cache dei download rimangono al di fuori delle directory dei modelli pubblicabili. I checksum sono obbligatori per ogni trasporto. Non indebolirli per pagine di accesso/prova HTML o download troncati.

La quantizzazione viene eseguita offline in un contenitore di build separato utilizzando i dati di calibrazione sintetici pubblici di ModelOpt, mai le cronologie delle chat. Solo le uscite il cui `build.json` dice `quantized` possono fornire `assistant-model` and `translation-model`; seleziona le loro sottodirectory `model/`, non i sorgenti grezzi o l'intero spazio di lavoro di compilazione. Dopo aver convalidato gli input, le build di Linux avvisano il kernel di rilasciare le pagine memorizzate nella cache di quei file specifici. Ciò evita letture fuorvianti di memoria GPU immediatamente libera sulla memoria condivisa di GB10; non elimina i pesi, cancella le cache a livello di host o interrompe i carichi di lavoro. Per una GPU da 10 GB, l'assistente utilizza Linux `MemAvailable` e riserva la capacità per la calibrazione e l'host. Rifiuta una capacità insufficiente piuttosto che accettare silenziosamente una build composta principalmente da CPU. Quando il modello completo si adatta, i budget ModelOpt espliciti evitano il percorso di esportazione di scarico della CPU non necessario di Accelerate. Il contenitore di build imposta inoltre una memoria bloccata illimitata e uno stack da 64 MiB, seguendo i requisiti di lancio della quantizzazione di [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Queste impostazioni hanno come ambito il contenitore di build, non i limiti a livello di host.

## 4. Completa gli input del pacchetto

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

La fusione dovrà riportare **41 ruoli e nessun ruolo mancante**. Verifica l'architettura dell'immagine/gli ID contenuto e rifiuta gli output in conflitto. Le risorse contengono solo firmware UEFI upstream (incluso un nuovo modello di archivio variabili), un ISO del driver virtio bloccato con checksum, runtime di disegno sorgente e avvisi Android associati alle immagini appena create. L'ISO non è il supporto di installazione di Windows. Il suo mirror Microsoft OpenVMM identico al checksum evita di fare affidamento su una pagina di download interattiva di Fedora.

Raccogli i pacchetti host con `collect_host_packages.py` come descritto in [README.md](README.it.md), quindi genera il modello con `prepare-release.py --template`. Riempi la sua mappa immagine da `images.json`; riempire tutti i 12 ruoli delle risorse dagli output del modello, `resources/assets.json` and `guest-tools`. Imposta `sourceCommit` sul checkout e sulla versione effettiva dell'agente. Non sono accettabili segnaposto o configurazioni di installazione precedenti.

Esegui `prepare-release.py --inputs … --output …`, quindi `build-package.sh` utilizzando la versione preparata. Le fonti modificate/non confermate richiedono il flag candidato esplicito `--allow-working-tree`; non sono un commit rilasciato. Vedi [PACKAGE-README.md](PACKAGE-README.it.md) per l'installazione. Un nuovo database di account vuoto ottiene `admin/admin`; tutte le credenziali del servizio e l'identità del dispositivo vengono generate in modo indipendente. Le build da sole non dimostrano che l'installazione è riuscita.

## Ricette storiche stratificate e controlli di pubblicazione

I Dockerfile diagnostici/a più livelli precedenti vengono conservati per la manutenzione del codice sorgente e non vengono utilizzati da questa pipeline. I loro argomenti `BUILD_PARENT_N` non hanno intenzionalmente alcuna immagine privata predefinita. Fornisci un genitore compatibile che hai creato o utilizza la pipeline pubblica sopra; non indovinare un digest di sviluppo non disponibile.

Prima della pubblicazione, esegui la protezione del codice sorgente e lo scanner segreto, rivedi la cronologia separatamente ed escludi tutte le directory di build, i pacchetti, i dischi guest, i dati dell'account e il sito Web privato. I report contenenti percorsi locali appartengono all'esterno dell'albero pubblico. La verifica per questo lavoro è limitata alla chiusura dell'input, all'identità dell'artefatto, all'installazione e ai percorsi minimi di servizio appena installati; non esegue nuovamente l'accettazione commerciale non correlata.
