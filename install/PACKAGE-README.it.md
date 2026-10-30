<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.it.md)
<!-- doc-navigation:end -->

# pacchetto di installazione offline Team AI Box

La licenza per il codice originale è inclusa nel pacchetto `LICENSE`. I componenti di terze parti mantengono le licenze originali; vedi `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT non concede ulteriori diritti di ridistribuzione per servizi Google, Windows, pesi dei modelli o marchi di terze parti. Il superamento dei controlli di integrità del pacchetto non stabilisce l'autorizzazione di ridistribuzione per ogni componente.

Questo pacchetto è per un nuovo DGX Spark che mantiene un sistema Linux di fabbrica compatibile. Utilizza l'ambiente GPU Docker, Compose e NVIDIA esistente senza sostituirli o formattare il disco di sistema.

## Installazione

Verifica l'archivio utilizzando il file `.sha256` allegato, quindi estrailo:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

L'installazione normale non richiede né l'accesso pubblico a Internet né modifiche manuali delle variabili di ambiente. Il programma di installazione fornisce gli strumenti richiesti in bundle, genera una configurazione locale indipendente, inizializza un nuovo database e avvia i servizi. Il caricamento iniziale del modello può richiedere tempo; un indicatore di caricamento non è una conferma dell'installazione riuscita.

Esegui `sudo ./install.sh --check` per controllare l'ambiente e il pacchetto senza eseguire l'installazione. `./install.sh --verify-package` controlla solo il contenuto del pacchetto e può anche essere eseguito sulla workstation di creazione del pacchetto. Utilizza `--installation-root /dedicated/path/installation` per specificare una nuova root di installazione; non puntarlo mai verso dati esistenti.

## Interruzioni e dati esistenti

Dopo un guasto o un'interruzione, risolvere il problema segnalato e ripetere il comando originale. Non eliminare la directory di installazione. Il programma di installazione conserva l'identità e i dati generati. La riesecuzione di un'installazione completa della stessa versione ne controlla solo lo stato. Altre versioni utilizzano il percorso di aggiornamento formale, non la cancellazione e la reinstallazione. Non esiste un'opzione di sovrascrittura forzata.

## Primo utilizzo

Apri l'indirizzo HTTPS sull'IP corrente dell'appliance e accedi:

- Nome utente amministratore: `admin`
- Password iniziale: `admin`

Il programma di installazione crea automaticamente questo amministratore; non è necessaria l'estrazione del token di configurazione o la registrazione manuale. La password iniziale è pubblica e semplice: modificala nella gestione utenti prima della consegna/utilizzo. Gli utenti ordinari non hanno un account predefinito e vengono creati dall'amministratore. Ciò si applica solo a un database di account vuoto; riprendere, eseguire nuovamente, riavviare e aggiornare non reimpostare mai gli account o le password esistenti sui valori predefiniti. Il codice di ripristino dell'amministratore generato in modo indipendente è archiviato nella root di installazione su `secrets/initial-owner-recovery.json`, leggibile solo da root. Non inviare mai codici di recupero a chat, ticket o registri pubblici. Le installazioni esistenti non generano né sostituiscono i codici di ripristino. Per il certificato HTTPS emesso localmente, configurare l'attendibilità del browser secondo le istruzioni della CA dell'amministratore. Un nome in un certificato non garantisce la risoluzione LAN DNS/mDNS. Il certificato pubblico della CA locale si trova normalmente in `/srv/teamaibox/installation/https/ca.crt`. Distribuisci solo quel certificato pubblico, mai la chiave privata accanto ad esso.

L'installazione non include le macchine virtuali esistenti, lo stato di accesso di Google o i file utente. Gli utenti caricano gli ISO di Windows/Linux o li selezionano dal drive del team, quindi installano autonomamente i sistemi guest. Google Play e le API esterne richiedono l'accesso a Internet e non sono incluse nella promessa di disponibilità offline.

I testi delle licenze dei componenti vengono conservati con le relative risorse di rilascio. Diritto d'autore © Weerocks LLC. Contatto: teamaibox@weerocks.llc.
