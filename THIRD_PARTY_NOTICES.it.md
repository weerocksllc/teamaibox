<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.it.md)
<!-- doc-navigation:end -->

# Ambito della licenza e avvisi di terze parti

Copyright © 2026 Weerocks LLC. La [MIT licenza](LICENSE) copre il codice originale Team AI Box e la documentazione autorizzata dal suo proprietario. Non concede in licenza codice di terze parti, file originali copiati/modificati, dipendenze, modelli, firmware, sistemi operativi, caratteri o immagini. I file di copyright, LICENZA e AVVISO esistenti hanno la precedenza per il rispettivo materiale. I metadati del pacchetto `license: MIT` si riferiscono al codice originale del pacchetto, non a tutto ciò che è incluso in un'immagine distribuita. `private: true` viene conservato per evitare la pubblicazione accidentale del registro dei pacchetti; non revoca la concessione di MIT.

## Inventario

L'[inventario dei componenti](docs/open-source/components.json) leggibile dalla macchina registra le versioni o le fonti delle versioni, le prove di licenza, l'ambito di ridistribuzione e gli obblighi binari non risolti. [L'inventario delle dipendenze](docs/open-source/dependencies.json) viene generato dal file di blocco, dai metadati delle dipendenze installati, dai moduli Go e dai file dei requisiti Python. I metadati della licenza mancanti sono esplicitamente sconosciuti, non presupposti MIT. Rigeneralo con `python3 tools/open_source_inventory.py`.

| Componente/materiale | Limite della licenza | Requisiti di distribuzione |
| --- | --- | --- |
| Ricevitore UxPlay e `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Conserva la GPL, gli avvisi, l'esatto sorgente upstream, le patch e crea script con qualsiasi binario del ricevitore; il semplice collegamento all'upstream non è sufficiente per una versione binaria. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Conservare gli avvisi e rendere disponibili i file sorgente coperti modificati. |
| GStreamer | LGPL e licenze plugin individuali | Ispezionare il set di plugin effettivo e adempiere agli obblighi corrispondenti. |
| SDK del server/browser LiveKit | Apache-2.0 | Conservare il copyright, la licenza e l'AVVISO applicabile. |
| Seppie/AOSP | Apache-2.0 e licenze per file, incluso kernel GPL | Conservare gli avvisi a monte e la fonte corrispondente applicabile. AOSP non include una licenza per i servizi Google. |
| Driver QEMU/Linux/EDK II/virtio | Licenze per progetto e per file | Controllare la build binaria, il firmware e i driver effettivi; non applicare l'etichetta generale MIT. |
| Guacamole | Apache-2.0 | Conservare la LICENZA e l'AVVISO copiati dal plug-in del computer Dockerfile. |
| Albero delle dipendenze Node/React/Vite e JS | Licenze per pacchetto | Conserva gli avvisi sulle dipendenze durante la distribuzione dell'output in bundle. |
| Pacchetti PostgreSQL e sistema operativo contenitore | PostgreSQL / per pacchetto | Includere i record di licenza del pacchetto installato in una versione binaria. |
| PyMuPDF / MuPDF utilizzato dall'OCR | AGPL-3.0-or-later o licenza commerciale | La distribuzione/servizio combinato del lavoratore OCR non è generale MIT; rispettare gli obblighi AGPL o ottenere diritti commerciali. Il codice originale potrebbe mantenere la sua concessione MIT. |
| Risorse del modello Qwen / LMT / Whisper / FLUX | Termini esatti del modello | I modelli sono separati dalla concessione della fonte MIT. I termini FLUX **4B** non devono essere sostituiti con un altro modello FLUX. |
| Pesi HunyuanOCR | Licenza comunitaria Tencent Hunyuan | Licenza modello condizionale; rivedere i termini di destinatario, territorio, utilizzo, attribuzione e ridistribuzione per ciascuna versione. |
| Software NVIDIA | NVIDIA e termini di terze parti inclusi | L'installazione dell'host Docker/NVIDIA esistente non è ridistribuita da questo pacchetto sorgente. Le librerie CUDA/container in bundle necessitano ancora di una propria revisione. |
| Servizi mobili Google/Play Store | Proprietario | Non fa parte del candidato di origine pubblica. Il codice di integrazione runtime non concede i diritti per distribuire le immagini GMS. |
| Supporti di installazione di Windows, dischi guest, account | Non coperto | Gli utenti forniscono supporti e licenze ISO autorizzati. Non spedire mai dischi VM di prova o stato ospite con accesso. |
| SDK ViKey ritirato | Sovvenzione privata / non pubblica istituita | SDK rimosso dall'origine funzionante; I commit storici privati ​​e le copie conservate dell'SDK non devono essere pubblicati. Non è necessaria alcuna chiave USB. |

Gli esatti avvisi di casting rimangono in [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Gli avvisi di trasporto ADB rimangono accanto al client telefonico. Non rimuoverli durante la minimizzazione o l'imballaggio. L'isolamento del contenitore di per sé non annulla gli obblighi di copyleft. L'analisi della distribuzione dipende dall'effettivo artefatto combinato.

## Marchio e collaboratori

MIT concede l'autorizzazione al copyright, non i diritti o l'approvazione dei marchi. I nomi/loghi Team AI Box e Weerocks non devono implicare il supporto ufficiale per un prodotto modificato. NVIDIA, DGX Spark, Android, Google Play, Windows e Apple/AirPlay appartengono ai rispettivi proprietari. La compatibilità non è una certificazione.

I metadati dell'autore locale sono un inventario, non una prova dell'assegnazione del copyright. Le categorie di proprietà esaminate sono registrate in [OWNERSHIP.md](docs/open-source/OWNERSHIP.it.md). L'autorizzazione del proprietario del progetto si applica ai suoi contributi originali; i contributori devono inviare solo il lavoro per cui hanno diritto a ottenere la licenza. Attribuzione sospetta mancante: teamaibox@weerocks.llc.
