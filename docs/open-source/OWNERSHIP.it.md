<!-- doc-navigation:start -->
[English](OWNERSHIP.md) · [简体中文](OWNERSHIP.zh-CN.md) · [繁體中文](OWNERSHIP.zh-TW.md) · [日本語](OWNERSHIP.ja.md) · [한국어](OWNERSHIP.ko.md) · [Français](OWNERSHIP.fr.md) · [Deutsch](OWNERSHIP.de.md) · [Español](OWNERSHIP.es.md) · [Português](OWNERSHIP.pt-BR.md) · [Русский](OWNERSHIP.ru.md) · [العربية](OWNERSHIP.ar.md) · [हिन्दी](OWNERSHIP.hi.md) · [Bahasa Indonesia](OWNERSHIP.id.md) · [Italiano](OWNERSHIP.it.md) · [Türkçe](OWNERSHIP.tr.md) · [Tiếng Việt](OWNERSHIP.vi.md) · [ไทย](OWNERSHIP.th.md)

[Team AI Box — README](../../README.it.md)
<!-- doc-navigation:end -->

# Ambito di copyright e provenienza

MIT viene applicato su istruzione del proprietario del progetto ai contributi originali Team AI Box attribuiti a Weerocks LLC. I nomi degli autori Git rappresentano una provenienza utile, non una prova di impiego, incarico o autorità di concedere in licenza lavoro di terze parti. La storia locale esaminata ha 20 commit raggiungibili e due identità di autore; i dettagli di contatto personali dell'autore e i record di sviluppo privati ​​non vengono copiati nell'esportazione della fonte. Da tale cronologia non si deduce alcun incarico firmato o ulteriore autorizzazione del fornitore.

| Materiale | Trattamento della licenza | Evidenze e limiti |
| --- | --- | --- |
| Applicazione/servizi/pacchetti originali e codice installatore | MIT | Istruzioni del proprietario del progetto; LICENZA root e metadati del pacchetto; le intestazioni di terze parti esistenti sovrascrivono questa impostazione predefinita |
| Modifiche UxPlay e materiale di costruzione accompagnatorio | GPL-3.0-only | Licenza upstream esistente, commit bloccato e avvisi sulla fonte corrispondente in `deploy/legal/`; non concesso in licenza come MIT |
| Modifiche GStreamer WebRTC | MPL-2.0 | Licenza upstream a livello di file e record di patch/build aggiunti |
| Librerie di testo in bundle e dipendenze normali | Licenze originali | Inventario dei lockfile, avvisi conservati e metadati del registro della versione esatta; i metadati sono un indice, non un sostituto dei testi di licenza |
| Dipendenza OCR PDF PyMuPDF | AGPL-3.0-or-later o licenza commerciale | Versione 1.26.4 e termini di doppia licenza upstream; MIT non concede eccezioni commerciali né risolve obblighi di servizio combinato |
| Pesi dei modelli, guest Android, firmware e tempi di esecuzione della GPU | Specifico del componente | Vedi `components.json`; i diritti sulla fonte originale non consentono automaticamente la ridistribuzione di tutti i pesi o le combinazioni binarie |
| Google Play/GMS | Proprietario; non nell'artefatto di origine pubblica | Il codice di integrazione è distinto dalle immagini runtime proprietarie; l'uso di prova privato esistente non è un permesso di ridistribuzione |
| SDK ViKey ritirato e manuale/intestazione del fornitore | Escluso; diritti originali riservati | Rimosso dall'albero dei sorgenti corrente; conservato privatamente, senza nuova licenza |
| Registri privati, dati dell'account, dischi VM, certificati e vecchia cronologia Git | Escluso | Nessun contributo pubblico ridistributivo; l'esportazione dell'origine non contiene cronologia privata |
| Sito web di marketing, modelli di articoli, contenuto del sito web e configurazione di distribuzione (`website/`) | Escluso dalla distribuzione pubblica del prodotto sorgente | Mantenuto separatamente nel repository del sito web privato; GitLab è un archivio storico; distinto dall'interfaccia utente dell'appliance in `apps/` |

Non rimuovere le dichiarazioni di copyright originali, non attribuire lavoro esterno a Weerocks o dare per scontato che tutte le varianti di modello con nomi simili abbiano gli stessi termini. Un contributore deve avere l'autorità per inviare il proprio lavoro; non viene introdotto alcun nuovo CLA obbligatorio. Consulta gli [avvisi di terze parti](../../THIRD_PARTY_NOTICES.it.md) per le origini dei componenti e i [limiti della versione](RELEASING.it.md) per la distinzione origine/binario.
