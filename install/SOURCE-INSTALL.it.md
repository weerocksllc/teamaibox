<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.it.md)
<!-- doc-navigation:end -->

# Installa da un clone pubblico

Questo punto di ingresso prepara gli input pubblici richiesti, crea le immagini dell'applicazione e produce un pacchetto completo prima di installarlo. Il progresso della creazione è ripristinabile; solo il risultato finale di disponibilità dell'installazione indica un apparecchio installato. Il download o il successo del preflight da solo non bastano.

Mantieni i modelli generati, le immagini del contenitore, i pacchetti di installazione, i record di test e le credenziali all'esterno del repository. La disponibilità dei mirror di terze parti non è garantita; le cache portatili verificate e i pacchetti offline sono descritti di seguito.

Su un nuovo DGX Spark con Ubuntu 24.04, funzionante con Docker/Compose, NVIDIA e KVM, clona il repository pubblico ed esegui dalla sua radice:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Per una rete della Cina continentale in cui non è possibile raggiungere gli endpoint del modello/immagine upstream, utilizzare lo stesso punto di ingresso con le origini di download regionali:

```sh
sudo bash install/from-source.sh --region cn
```

Questa è una **build di origine online seguita da un'installazione offline**, non una build di origine offline. Prepara automaticamente gli strumenti di creazione mancanti, scarica i sei input del modello, crea e assembla Android e tutte le immagini delle applicazioni, quantizza i due modelli sorgente, raccoglie pacchetti firmware/host, crea il pacchetto offline completo ed esegue il programma di installazione esistente. Non sostituisce Docker/NVIDIA, non riavvia il demone Docker, non cancella un'installazione esistente né modifica il routing dell'host, le impostazioni DNS o VPN. I modelli, gli stati di accesso ospite e il sito Web di marketing privato non provengono da un'altra installazione.

L'area di lavoro predefinita è `/var/tmp/teamaibox-source-build`; le cache di download e i registri per fase risiedono lì, all'esterno del clone. L'installazione predefinita è `/srv/teamaibox/installation`. Aspettatevi download di grandi dimensioni e diverse centinaia di GB di utilizzo temporaneo del disco. Il caricamento del modello e la quantizzazione della GPU possono richiedere molto tempo; non è promesso alcun tempo di completamento fisso.

## Riprendere l’installazione e verificarne lo stato

Se interrotto, **rieseguire esattamente lo stesso comando**. Mantieni lo spazio di lavoro. Una build in esecuzione esclude un altro scrittore; i file e le immagini della fase completati vengono verificati prima del riutilizzo. I tentativi falliti rimangono disponibili per la diagnosi, mentre il tentativo successivo esegue solo la fase fallita. Gli intervalli di byte del modello e i file verificati vengono conservati. `state.json` identifica la fase corrente e la relativa directory di registro. I download dei modelli ufficiali utilizzano la concorrenza limitata di file/intervallo; le fonti regionali utilizzano la concorrenza conservativa per ridurre la limitazione della velocità. I rapporti sull'avanzamento dei byte per file trasferiti o riutilizzati variano separatamente dalla verifica finale dell'hash dell'editore. La compilazione dello strumento guest funziona anche con un servizio di sistema senza home di accesso: crea cache di build isolate al di fuori delle risorse di installazione risultanti.

Le modifiche all'origine richiedono un nuovo `--work-dir`; riutilizza la cache dei download con `--cache-dir /path/to/public-cache`. L'impronta digitale di origine impedisce la combinazione silenziosa degli output di codici diversi. Un'installazione esistente non è un invito a reimpostarla: solo l'installazione dello stesso pacchetto di questo spazio di lavoro può riprendere; le altre installazioni devono utilizzare il processo di aggiornamento.

Modalità utili:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` è di sola lettura e non garantisce il successo dei download. Solo download e solo compilazione non dichiarano esplicitamente la disponibilità dell'installazione.

## Fonti regionali e integrità

La modalità Cina utilizza `https://hf-mirror.com` per il trasferimento del modello e `https://docker.m.daocloud.io` per gli input dell'hub Docker bloccati digest. Si tratta di mirror di terze parti, non di servizi gestiti da Weerocks o dagli editori di modelli. Il modello Git commit è bloccato dal profilo del prodotto; il suo albero Git verificato e i puntatori LFS stabiliscono le dimensioni dei file e gli hash previsti. La risposta API del mirror da sola non può stabilire la fiducia. Docker verifica i digest di manifest/strati bloccati. I tag sbloccati non vengono reindirizzati automaticamente (lo strumento di compilazione Go ha un blocco digest esplicito). NVIDIA immagini rimangono nel registro dell'editore. La verifica TLS rimane abilitata e nessun token di account viene inviato ai mirror del modello.

Puoi selezionare le tue origini HTTPS utilizzando `--model-endpoint` and `--registry-mirror`. I valori degli endpoint non devono includere credenziali o parametri di query. Il wrapper Docker con ambito si applica solo a questo processo di compilazione, non al daemon di sistema o ad altri progetti. I metadati dell'SDK e gli archivi delle licenze provengono ancora dai loro autorevoli editori HTTPS; uno specchio non può inventare hash.

I mirror possono avere una velocità limitata o non disponibili. I download dei modelli vengono eseguiti con concorrenza limitata e rispettano i tempi di recupero. Nessuno script può garantire la connettività a tutti gli upstream su ogni rete. Se entrambi i percorsi non sono disponibili, prepara i download o il pacchetto completo su un computer compatibile accessibile e copiali su:

- `--download-models-only --cache-dir <public-cache>` prepara file di modello verificati e cache ripristinabili. Copia quella directory, quindi passala con `--cache-dir` sulla destinazione. Ogni modello riutilizzato viene controllato rispetto alla sua identità fissata. Questa cache **non** è un pacchetto di installazione offline completo.
- `--build-only` prepara il pacchetto completo per l'installazione offline. Copia il suo tar e il checksum, verifica e decomprimi, quindi esegui `sudo ./install.sh` al suo interno. Questo è il percorso affidabile dell'host disconnesso; non richiede una VPN sul target né l'accesso a un box di sviluppo.

Non copiare mai una directory di dati Docker live, dischi guest, profili browser, database di account, credenziali o cache private in sostituzione di input pubblici. Non disabilitare i checksum né accettare una pagina di accesso/prova come file modello.

## Licenza e primo utilizzo

Consulta `THIRD_PARTY_NOTICES.md`, i termini dell'SDK Android e le licenze dei singoli modelli prima di creare. Il download di componenti di terze parti non li trasforma in risorse MIT né concede diritti di certificazione/ridistribuzione a Google. I supporti ISO Windows/Linux vengono ancora forniti dall'utente. Il login di fabbrica rimane `admin/admin`; cambiarlo prima di esporre l'apparecchio. Il programma di installazione esistente genera credenziali di servizio indipendenti e segnala l'effettiva disponibilità.

Al termine, apri `https://<BOX_LAN_IP>/` sulla stessa LAN; sostituire l'attuale indirizzo di rete fisica di Spark, non un bridge Docker o un indirizzo VPN. I record `state.json` dell'area di lavoro di origine registrano l'avanzamento della creazione. Il `/srv/teamaibox/installation/readiness.json` installato registra i controlli di installazione. Né una compilazione riuscita né un controllo dello stato del contenitore in ascolto sostituiscono l'operazione end-to-end visibile di un'applicazione.

Il runtime di casting deve contenere il ricevitore UxPlay, gli eseguibili di rilevamento D-Bus e Avahi privati, nonché i relativi plug-in multimediali. La build finale dell'immagine pubblica controlla questi eseguibili; una libreria client da sola non è sufficiente. Una nuova installazione registra il proxy desktop e il gateway con gli altri dipendenti dello spazio dei nomi di rete API in modo che gli aggiornamenti API raggruppati possano mantenere il percorso di connessione desktop. Non ricreare solo un sottoinsieme di quel gruppo durante la manutenzione.
