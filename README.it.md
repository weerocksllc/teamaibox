<!-- Generated from docs/readme-locales/ and docs/readme-features/it.json by tools/render-readmes.mjs. -->
# Team AI Box — Software open source per NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Trasforma NVIDIA DGX Spark nello spazio di lavoro IA del tuo team.** Esegui IA locale, generazione di immagini e strumenti per documenti su NVIDIA DGX Spark. Team AI Box riunisce file, messaggistica e dispositivi virtuali in uno spazio open source nel browser.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Elenco completo delle funzionalità](#features) · [Installazione su un DGX Spark nuovo](#install) · [Costruiamolo insieme](#contribute)

## Perché Team AI Box?

- **Uno spazio integrato:** interfaccia e account coerenti per IA, collaborazione e dispositivi.
- **AI locale al primo posto.** Esegui l’inferenza sul tuo Spark e collega API di modelli esterni quando ti servono.
- **Progettato per DGX Spark.** Installa su Ubuntu ARM64 con container GPU NVIDIA e virtualizzazione KVM.
- **Aperto ai contributi:** codice originale MIT, 17 lingue, temi chiaro/scuro e scelte manuali salvate. La lingua iniziale è inglese.

## Lo spazio di lavoro reale

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/it/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/it/workbench-light.jpg">
  <img src="docs/assets/screenshots/it/workbench-light.jpg" alt="Spazio Team AI Box per NVIDIA DGX Spark con app IA e strumenti per team — Italiano" width="1280">
</picture>

[Tema chiaro](docs/assets/screenshots/it/workbench-light.jpg) · [Tema scuro](docs/assets/screenshots/it/workbench-dark.jpg)

<a id="features"></a>

## Elenco completo delle funzionalità

**Vai a un modulo**

- [Spazio di lavoro e navigazione quotidiana](#feature-workspace)
- [Assistente AI e flussi Agent controllati](#feature-assistant)
- [Generazione di immagini con AI](#feature-drawing)
- [Riconoscimento e correzione del testo](#feature-ocr)
- [Trascrizione di registrazioni e voce dal vivo](#feature-transcription)
- [Traduzione di testi, file e contenuti multimediali](#feature-translation)
- [Messaggistica del team](#feature-messaging)
- [Unità del team e collaborazione sui file](#feature-drive)
- [Proiezione wireless compatibile con AirPlay](#feature-casting)
- [Telefoni Android virtuali persistenti](#feature-phones)
- [Computer virtuali Windows e Linux](#feature-computers)
- [Amministrazione, permessi e sicurezza](#feature-administration)
- [Installazione dal sorgente e manutenzione](#feature-installation)
- [Sviluppo open source ed estensioni](#feature-developers)

<a id="feature-workspace"></a>

### Spazio di lavoro e navigazione quotidiana

- Usa un unico spazio di lavoro nel browser per AI locale, collaborazione del team e dispositivi virtuali su un solo DGX Spark.
- Esplora le applicazioni per categoria, cerca nel catalogo e apri un'app dalla barra laterale.
- Visualizza il caricamento, la disponibilità e lo stato del servizio di ogni applicazione.
- Segui le attività in coda, in esecuzione, completate, non riuscite e annullate nel centro attività e apri i risultati disponibili.
- Visualizza gli inviti alla proiezione in attesa nel menu delle notifiche e apri l'app di proiezione per rispondere.
- Scegli fra 17 lingue dell'interfaccia, incluso l'arabo con scrittura da destra a sinistra; l'inglese resta la lingua predefinita finché non ne scegli un'altra.
- Usa il tema chiaro, scuro o di sistema; le scelte manuali di lingua e tema vengono mantenute dopo aggiornamenti della pagina, nuovi accessi e passaggi fra applicazioni.

<a id="feature-assistant"></a>

### Assistente AI e flussi Agent controllati

- Avvia conversazioni, salvane la cronologia e riapri le discussioni precedenti.
- Scegli la modalità Automatica, Risposta o Agent per la richiesta corrente.
- Allega più file a una richiesta e rimuovi gli allegati prima dell'invio.
- Leggi le risposte in streaming, interrompi un'esecuzione attiva e riprendine il flusso di eventi dopo la riconnessione.
- Esamina i dettagli del modello, le attività degli strumenti, le fonti e i dati di utilizzo restituiti; scarica i file prodotti quando l'esecuzione ne genera.
- Esamina l'ambito di un'azione Agent che richiede conferma, quindi approva o rifiuta l'azione.
- Esegui le attività Agent in una sandbox per utente con uno spazio di lavoro persistente; strumenti e accesso alla rete seguono le regole dell'amministratore.

<a id="feature-drawing"></a>

### Generazione di immagini con AI

- Genera un'immagine da una descrizione testuale con il modello di immagini disponibile; l'app attuale non è un editor per la modifica di immagini o l'inpainting.
- Scegli la generazione Automatica o Rapida quando la configurazione del modello disponibile lo supporta.
- Seleziona proporzioni quadrate, orizzontali o verticali, dimensioni di uscita supportate e un seed casuale o fisso.
- Richiedi un'immagine in formato PNG, WebP o JPEG, visualizzane l'anteprima e scaricala.
- Segui la coda e l'avanzamento della generazione, annulla l'attività e recupera quella corrente dopo aver riaperto la pagina.
- Consulta il modello effettivamente utilizzato e i parametri di generazione registrati insieme al risultato.

<a id="feature-ocr"></a>

### Riconoscimento e correzione del testo

- Carica un file PNG, JPEG, WebP o PDF oppure scegli un file esistente dall'unità del team.
- Indica la lingua e riconosci testo, tabelle Markdown o formule LaTeX nei limiti delle capacità del modello selezionato.
- Esamina i risultati per pagina e blocco di testo, quindi correggi manualmente il testo riconosciuto.
- Esporta il contenuto revisionato come testo, Markdown o JSON.
- Invia un risultato di riconoscimento salvato a Traduzione senza caricare ed elaborare di nuovo la sorgente.
- Segui e annulla le attività di riconoscimento. Il modello attuale non fornisce coordinate dei riquadri di delimitazione né punteggi di confidenza.

<a id="feature-transcription"></a>

### Trascrizione di registrazioni e voce dal vivo

- Scegli un file audio/video locale o dall'unità del team: WAV, FLAC, OGG, WebM, MP3, M4A, AIFF o MP4.
- Riproduci un'anteprima del contenuto originale e usa il rilevamento automatico della lingua oppure indica una lingua supportata.
- Esamina i segmenti della trascrizione con riferimenti temporali e modificane il testo.
- Esporta testo, JSON o sottotitoli SRT e WebVTT.
- Passa una trascrizione salvata a Traduzione e segui o annulla l'attività di trascrizione corrente.
- Trascrivi dal vivo l'audio del microfono quando sono disponibili HTTPS, il permesso del browser, MediaRecorder e il servizio in tempo reale.
- Usa i riferimenti temporali per parola o la separazione dei parlanti solo con profili compatibili; il percorso sperimentale di separazione dei parlanti richiede un file WAV.

<a id="feature-translation"></a>

### Traduzione di testi, file e contenuti multimediali

- Scegli dal catalogo di 60 lingue supportate dal modello, rileva automaticamente la lingua di origine oppure seleziona e scambia le lingue di origine e destinazione. La qualità non è garantita uguale per tutte le coppie linguistiche.
- Traduci testo digitato o incollato e confronta i segmenti originali con quelli tradotti.
- Carica un'immagine o un PDF oppure selezionalo dall'unità del team; quando OCR è pronto, riconosci il testo prima di tradurlo.
- Traduci audio/video supportati tramite trascrizione, mantenendo i riferimenti temporali dei segmenti quando il servizio di trascrizione è pronto.
- Riutilizza risultati OCR o trascrizioni salvati e scarica i risultati intermedi disponibili.
- Modifica il testo tradotto ed esportalo come testo, Markdown o JSON; i risultati audio/video supportano anche SRT e WebVTT.
- Segui le fasi di estrazione, trascrizione e traduzione, annulla l'attività e recupera quella corrente dopo aver riaperto la pagina.
- Le lingue di traduzione sono distinte da quelle dell'interfaccia e dalla copertura OCR/ASR. La traduzione PDF opera sul testo: non ricrea l'impaginazione originale né offre un editor generico DOCX/XLSX.

<a id="feature-messaging"></a>

### Messaggistica del team

- Trova i colleghi, avvia conversazioni dirette e crea chat di gruppo con nome e membri selezionati.
- Filtra tutte le chat, quelle non lette o quelle di gruppo e cerca nelle conversazioni e nei messaggi a cui hai accesso.
- Invia testo e file allegati; scarica la versione originale di un file allegato.
- Ricevi messaggi in tempo reale, ritrova la cronologia alla riconnessione, segui i punti di lettura e i messaggi non letti e visualizza la presenza dei membri.
- Invia con Invio, inserisci una nuova riga con Maiusc+Invio e passa dall'elenco delle conversazioni alla chat sugli schermi stretti.
- Elimina un messaggio dalla tua vista o cancella la tua cronologia di chat; i messaggi conservati dagli altri partecipanti non vengono eliminati.
- Elimina una chat dal tuo elenco delle conversazioni senza uscire dal gruppo; un nuovo messaggio può farla ricomparire.

<a id="feature-drive"></a>

### Unità del team e collaborazione sui file

- Organizza spazi personali e del team con cartelle e navigazione tramite percorso.
- Passa dalla vista elenco alla griglia, consulta i dettagli dei file, cerca file/cartelle e visualizza le modifiche recenti.
- Carica più file, segui l'avanzamento e annulla un caricamento.
- Riprendi il caricamento multipart di un file grande selezionando di nuovo lo stesso file; le parti già caricate vengono verificate dal server.
- Crea cartelle e rinomina, sposta o copia file e cartelle.
- Visualizza anteprime di immagini, audio, video, testi e PDF supportati e scarica i file; la riproduzione multimediale dipende dal browser.
- Carica una nuova versione di un file, consulta la cronologia delle versioni e scarica quelle precedenti.
- Sposta gli elementi nel cestino e ripristinali.
- Condividi internamente con membri o team concedendo permessi di visualizzazione/modifica e una scadenza facoltativa; non si tratta di condivisione tramite link pubblico anonimo.
- Sfoglia file e cartelle condivisi con te; l'accesso viene ricontrollato in base ai permessi e all'appartenenza attuali.

<a id="feature-casting"></a>

### Proiezione wireless compatibile con AirPlay

- Avvia e arresta un ricevitore temporaneo per dispositivi Apple compatibili sulla stessa LAN, con nome e PIN dedicati.
- Scegli una durata del ricevitore di 15, 30, 60 o 120 minuti; l'arresto o la scadenza terminano la trasmissione e l'accesso alla visione.
- Limita la visione a te stesso, a membri selezionati o a un team; invita spettatori che possono accettare o rifiutare.
- Guarda lo schermo e ascolta l'audio nel browser; le regole di riproduzione automatica possono richiedere un clic per attivare il suono.
- Visualizza e rimuovi gli spettatori connessi; un amministratore può interrompere una sessione senza ottenere il permesso di vedere contenuti privati.
- Visualizza gli stati di disconnessione/riconnessione; il permesso di visione viene ricontrollato quando si accede di nuovo.
- Richiede un runtime multimediale pronto, il rilevamento raggiungibile sulla LAN e versioni compatibili di browser e dispositivi. La visione nel browser non offre uscita HDMI, riproduzione DRM/FairPlay né certificazione Apple.

<a id="feature-phones"></a>

### Telefoni Android virtuali persistenti

- Crea telefoni Android indipendenti dai profili di sistema installati, mantenendo app e dati di ciascun telefono fra le sessioni.
- Avvia, spegni, riavvia, rinomina ed elimina esplicitamente i singoli telefoni.
- Controlla Android con tastiera e puntatore e con i pulsanti Indietro, Home, App recenti e volume.
- Usa audio e schermo intero, riconnettiti o sposta la connessione attiva del telefono su un'altra pagina.
- Carica file su un telefono e scarica quelli contenuti nella sua cartella di trasferimento Team AI Box.
- Installa i tuoi file APK dopo conferma; i permessi delle app Android non vengono concessi silenziosamente.
- Fornisci alla fotocamera virtuale un'immagine, un video o la videocamera del browser quando supportati; le videocamere USB fisiche e gli ingressi di rete richiedono inoltre configurazione e permessi dell'amministratore.
- Autorizza temporaneamente il debug ADB per uno specifico dispositivo tramite un relay di breve durata, usando gli strumenti ADB standard e il client relay Node.js.
- Consulta su richiesta frame rate, perdita di pacchetti e statistiche del tempo di andata e ritorno della connessione; non costituiscono una garanzia di latenza end-to-end.
- Scegli un profilo di sistema Google Play solo quando le relative risorse sono disponibili; tale disponibilità non equivale alla certificazione Play Protect né garantisce il funzionamento di ogni app Android.

<a id="feature-computers"></a>

### Computer virtuali Windows e Linux

- Crea computer Windows/Linux ARM64 indipendenti scegliendo CPU, memoria e dimensioni del disco.
- Avvia un computer, spegnilo normalmente ed elimina un computer spento dopo una conferma esplicita.
- Apri un monitor virtuale nel browser per vedere firmware, avvio, installazione e schermate del sistema operativo senza dover prima accedere al desktop remoto.
- Usa tastiera, puntatore, audio, schermo intero e comandi di riconnessione.
- Apri lo stesso computer virtuale in più schede o finestre del browser.
- Invita i colleghi a vedere o controllare un monitor e revoca il loro accesso.
- Passa il controllo a un altro partecipante, rilascialo o riprendilo come proprietario; scegli fra controllo esclusivo e condiviso.
- Carica un ISO di installazione con comandi di pausa, ripresa e annullamento oppure scegli un ISO esistente dall'unità personale o del team.
- Monta o espelli il supporto ottico virtuale e scegli l'avvio da disco una sola volta; cambiare supporto non riavvia automaticamente il computer.
- Installa un sistema operativo ARM64 che sei autorizzato a usare e accedi separatamente al desktop remoto facoltativo. La licenza Windows resta tua responsabilità; non sono inclusi Windows preattivato né supporto generico per sistemi guest x86.

<a id="feature-administration"></a>

### Amministrazione, permessi e sicurezza

- Crea membri locali, gestisci lo stato degli account e reimposta le password quando il tuo ruolo lo consente.
- Assegna ruoli predefiniti, consulta i permessi e gestisci l'appartenenza ai team, con protezioni specifiche per le operazioni del proprietario.
- Filtra gli eventi di audit per dominio o ID di correlazione, consulta i dettagli e richiedi la verifica dell'integrità della cronologia.
- Consulta lo stato del dispositivo, delle applicazioni, dello storage e dei servizi di esecuzione nello spazio di amministrazione.
- Configura fornitori AI esterni e associazioni fra modelli e operazioni, ruota le credenziali e abilita o disabilita i fornitori.
- Imposta le regole consentite di instradamento locale/esterno con approvazione esplicita per l'elaborazione esterna; l'AI locale non richiede una chiave API esterna.
- Consulta i profili dei modelli installati, le versioni dei runtime, la disponibilità e i dettagli di validazione.
- Importa pacchetti plugin verificati e gestisci installazione, aggiornamento, abilitazione, disabilitazione e rimozione dei plugin ammessi; i plugin ufficiali protetti hanno restrizioni.
- Consulta code e attività di esecuzione, modifica le regole di pianificazione consentite e annulla le attività idonee.
- Consulta le impostazioni dello storage cifrato e della protezione all'avvio. Lo sblocco automatico usa una chiave locale; abilitare una passphrase all'avvio richiede la verifica del recupero e una conferma.

<a id="feature-installation"></a>

### Installazione dal sorgente e manutenzione

- Installa da un clone Git pubblico con un unico comando documentato su un DGX Spark compatibile e non ancora configurato con il prodotto.
- Prepara gli strumenti di compilazione, scarica modelli e componenti runtime, costruisci le immagini applicative, crea il pacchetto e installalo riutilizzando l'ambiente Docker/NVIDIA esistente.
- Riprendi una preparazione interrotta con lo stesso comando e la stessa directory di lavoro, riutilizzando i download verificati e le fasi completate.
- Esegui controlli dei prerequisiti, la sola preparazione dei download oppure la sola costruzione del pacchetto.
- Prepara un pacchetto portatile completo da installare su un dispositivo offline; la preparazione dal sorgente richiede invece accesso alla rete.
- Verifica gli input fissati a versioni precise e usa le fonti alternative documentate o cache portatili verificate quando necessario; nessun mirror di terze parti è garantito.
- Inizializza credenziali nuove specifiche del dispositivo e l'account documentato admin/admin, quindi cambiagli la password; non copiare account o dischi guest di un altro dispositivo.
- Esamina i candidati di manutenzione, i risultati di compatibilità, i piani espliciti di esecuzione e la loro cronologia, con istruzioni mirate di rollback e recupero: non si tratta di aggiornamenti automatici arbitrari di sistema operativo o driver.

<a id="feature-developers"></a>

### Sviluppo open source ed estensioni

- Leggi, modifica e ridistribuisci il codice originale del prodotto e la documentazione con licenza MIT; i componenti di terze parti mantengono le proprie licenze.
- Crea estensioni ApplicationPlugin o ComputePlugin usando i contratti SDK pubblici e i plugin di esempio inclusi.
- Usa manifest di pacchetto firmati e controlli di integrità e permessi per importare plugin; ciò non implica l'esistenza di un marketplace pubblico di plugin.
- Contribuisci con correzioni, traduzioni, documentazione e integrazioni tramite issue e pull request; segnala le vulnerabilità attraverso il canale di sicurezza privato.

## Che cos’è NVIDIA DGX Spark?

NVIDIA DGX Spark è un sistema IA desktop compatto basato sul superchip GB10 Grace Blackwell. La configurazione da 128 GB combina una CPU Arm a 20 core, una GPU Blackwell e 128 GB di memoria di sistema unificata con banda di 273 GB/s. NVIDIA dichiara fino a 1 PFLOP di calcolo IA teorico con precisione FP4 e sparsità.

La memoria unificata è memoria di sistema condivisa, non VRAM dedicata. Le specifiche variano in base alla configurazione; il calcolo teorico non garantisce velocità delle applicazioni o utenti simultanei.

DGX Spark fornisce il calcolo. Team AI Box aggiunge un’interfaccia comune per inferenza locale, generazione di immagini, OCR, trascrizione, traduzione e collaborazione. La prima installazione dai sorgenti scarica le dipendenze e costruisce l’ambiente di esecuzione prima della configurazione.

[Specifiche hardware ufficiali di NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box è un progetto indipendente di Weerocks LLC, non un prodotto, una certificazione o un’approvazione di NVIDIA. L’hardware supportato è definito dai requisiti di installazione seguenti.

<a id="install"></a>

## Installazione su un DGX Spark nuovo

Serve un **DGX Spark senza installazioni precedenti con Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, driver e container NVIDIA funzionanti, KVM, Git e Python 3.10+. Riserva diverse centinaia di GB temporanei per modelli, build e pacchetto. Non installare da zero sopra dati esistenti.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Esegui i comandi **sullo Spark**. Lo script scarica input e modelli, costruisce immagini, prepara un pacchetto offline completo e installa. La prima build richiede Internet e tempo; clonare non equivale a installare. Riutilizza Docker/NVIDIA.

### Controlli e ripresa

`--check` verifica i prerequisiti. In caso di interruzione conserva `/var/tmp/teamaibox-source-build` e ripeti **lo stesso comando**, riutilizzando download verificati e fasi completate. Non cancellare la cache né avviare build concorrenti. Le fonti ufficiali sono predefinite. Se irraggiungibili, usa [la guida](install/SOURCE-INSTALL.it.md) per alternative o trasferire cache/pacchetti verificati; i mirror non sono garantiti. Codice modificato richiede un nuovo `--work-dir`, senza aggirare i controlli.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Dopo l'installazione

1. Apri `https://<BOX_LAN_IP>/` all'indirizzo LAN corrente e verifica che il certificato HTTPS locale appartenga al tuo dispositivo.
2. Accedi con `admin` / `admin`, **cambia la password iniziale** e crea account normali. Non esporre le credenziali iniziali su Internet.
3. Attendi le app pronte e scegli lingua/tema nel profilo.
4. Fornisci ISO ARM64 Windows/Linux autorizzate e licenze. Per una destinazione offline prepara il pacchetto completo e segui [la guida](install/README.it.md); la preparazione sorgente è online.

## Licenza e limiti

Codice originale e documentazione sono MIT, **non tutti i binari installati**. Terze parti, modelli, NVIDIA, firmware, Google e Windows conservano i propri termini. Git non include pesi, dischi ospiti installati, sessioni, ISO o pacchetti. Compatibilità Google non significa certificazione Play Protect; casting non include DRM o certificazione Apple. Non si dichiara supporto Windows 10 ARM64. Prestazioni e concorrenza dipendono dal carico e dall'hardware.

<a id="contribute"></a>

## Costruiamolo insieme

Sono benvenuti bug, documentazione, traduzioni, accessibilità, integrazioni e codice. Descrivi il problema in una issue, crea fork e branch mirato, invia una PR con controlli e immagini pertinenti. Spark non è necessario per documentazione o componenti isolati; dichiara le verifiche hardware reali. Non pubblicare segreti, file personali o immagini con accesso effettuato. Segnala vulnerabilità privatamente secondo SECURITY.md. Nessun CLA obbligatorio o permesso a pagamento.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.it.md) · [SECURITY](SECURITY.it.md)

## Approfondimenti

- [Installazione sorgente e ripristino](install/SOURCE-INSTALL.it.md)
- [Pacchetto offline](install/README.it.md)
- [Ambiente di sviluppo](docs/open-source/BUILDING.it.md)
- [Come contribuire](CONTRIBUTING.it.md)
- [Segnalazione privata di sicurezza](SECURITY.it.md)
- [Licenze terze e ambito di distribuzione](THIRD_PARTY_NOTICES.it.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Licenze terze e ambito di distribuzione](docs/open-source/RELEASING.it.md)
