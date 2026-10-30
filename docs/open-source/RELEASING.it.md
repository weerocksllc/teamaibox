<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.it.md)
<!-- doc-navigation:end -->

# Rilascia i confini

## Artefatti separati

1. **MIT candidato sorgente**: codice originale, specifiche attuali, strumenti di build/test revisionati e avvisi; nessuna cronologia Git o prove di laboratorio privato.
2. **Materiale di terze parti**: sorgente/binari/modelli upstream esatti con la propria licenza e attribuzione. Gli obblighi di fonte copyleft viaggiano con i binari.
3. **Pacchetto completo di dispositivi offline**: realizzato da `install/`; non concesso automaticamente in licenza per la ridistribuzione pubblica. I componenti GMS, HunyuanOCR, NVIDIA e le licenze guest/firmware richiedono una revisione specifica dell'elemento. Non pubblicare il pacchetto privato, i bundle di modelli o le immagini a cui hai effettuato l'accesso sotto l'etichetta MIT.
4. **Sito web di marketing**: `website/`, inclusi i modelli di articoli, i contenuti, le risorse di progettazione, l'analisi e la configurazione di distribuzione, rimangono nel repository GitHub privato `weerocksllc/teamaibox.com`. GitLab è un archivio storico, non il repository di sviluppo del sito web. Il sito Web non fa parte della distribuzione pubblica del prodotto. L'interfaccia utente del browser dell'appliance in `apps/` rimane parte del prodotto open source.

Gli script storici di distribuzione, ripristino e registrazione delle prove su un solo dispositivo non sono strumenti di prodotto riutilizzabili. La politica di rilascio esclude script e snapshot ritirati; non ripristinarli dall'archivio privato. Gli strumenti conservati richiedono target espliciti forniti dall'operatore anziché host, account, contenitori o file di prova dello sviluppatore. Esegui la scansione sensibile supplementare insieme a Gitleaks: ID dispositivo, ID contenitore, hash GSF e nomi di account personali testano i metadati anche quando non sono credenziali di accesso utilizzabili. La pulizia della cronologia pubblica richiede l'autorizzazione esplicita del proprietario e non deve mai riscrivere l'archivio privato o i relativi tag di consegna. Dopo una riscrittura autorizzata, utilizzare un nuovo clone pubblico anziché unire nuovamente la cronologia ritirata nel repository mantenuto.

Il repository di sviluppo interno e i relativi tag rimangono intatti. La cronologia raggiungibile contiene vecchi record di distribuzione e risorse SDK proprietari ritirati; non deve essere reso pubblico immutato. Un nuovo albero esportato fornisce il punto di partenza pubblico senza riscrivere silenziosamente la cronologia di consegna originale.

## Preparazione locale

Utilizza **Gitleaks 8.30.1**, scaricato dalla sua versione ufficiale su GitHub e verificane il checksum. Lo strumento di controllo non installa mai pacchetti di sistema né carica dati. L'output privato viene ignorato `.runtime/open-source-audit/`, non un PR pubblico.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Gli output devono essere nuovi percorsi; gli strumenti non sovrascrivono mai i candidati precedenti. Rivedere le posizioni oscurate non conta solo. Documentare separatamente le apparecchiature sintetiche, le credenziali di bootstrap pubbliche, i falsi positivi identificativi e le credenziali private effettive/possibili. Le scansioni dei pattern non possono convalidare credenziali o screenshot OCR. Gli artefatti binari sono esclusi, non dichiarati scansionati. L'esportatore di origine ammette solo file noti a Git e input espliciti non tracciati in [release-policy.json](release-policy.json). I nuovi input non tracciati necessitano di revisione. Rifiuta i collegamenti simbolici e l'attraversamento del percorso ed emette SHA-256 per file più esclusioni. `website/` è sempre escluso, anche se tracciato o elencato come input non tracciato. Non copiare mai la directory `.git` del repository privato in un checkout pubblico. Prima della pubblicazione, verifica che sia l'albero che tutti i commit pubblici raggiungibili non contengano file del sito web; l'eliminazione dei file in un commit successivo non rimuove la vecchia cronologia.

Il controllo supplementare include messaggi di commit/tag raggiungibili, credenziali a bassa entropia e valori letterali di accesso, identità dei dispositivi e indirizzi di sviluppo. I test non sono automaticamente esentati: spiegare perché ogni apparecchio mantenuto è sintetico. I valori privati ​​noti possono essere forniti con `--denylist` come array JSON esterno di record `{id, value, word?}`. Utilizzare ID opachi e non sensibili; mantieni questo file fuori dal checkout dell'origine. I report mostrano posizioni e hash, mai i valori. Una corrispondenza con un marcatore noto fa fallire il controllo. Usa `--scope worktree` durante la pulizia; controlla `--scope all` nel nuovo repository di versioni parentless prima della pubblicazione. Non pubblicare la vecchia cronologia o i rapporti di revisione privati.

L'unico valore predefinito intenzionale dell'amministratore di fabbrica è `admin / admin`; modificarlo durante la distribuzione. Gli strumenti di distribuzione/test del browser devono ricevere le credenziali dell'account esistente tramite input locale protetto. Gli account smoke-test appena creati utilizzano credenziali casuali e vengono disabilitati durante la pulizia. Una pulizia non riuscita è un fallimento del test, non un'esecuzione riuscita. L'interruzione improvvisa del processo può impedire la pulizia; gli operatori devono riconciliare i loro conti temporanei dopo tale interruzione. Nessun documento pubblico afferma che le credenziali del test siano attualmente valide.

Solo il punto di ingresso `install/` gestito è un percorso di installazione di un'appliance pulita. La valutazione della proprietà del componente si trova in [OWNERSHIP.md](OWNERSHIP.it.md).

Nessun comando qui spinge Git, modifica la visibilità, riscrive la cronologia, ruota le credenziali live, cambia un dispositivo o garantisce diritti di ridistribuzione a terze parti. Il rilascio pubblico richiede una destinazione pubblica scelta esplicitamente e la revisione finale dell'artefatto. Conserva `delivery-2026-10-22` nel repository privato.
