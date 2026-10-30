<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.it.md)
<!-- doc-navigation:end -->

# Limite della privacy della fonte pubblica

Il repository pubblico del prodotto è una nuova istantanea della fonte, non uno specchio della cronologia dello sviluppo privato. Il sito Web di marketing dispone di un proprio archivio privato e non è incluso qui.

## Materiale rimosso

- Corretti i nomi degli account e le password dei test di distribuzione e gli elenchi degli account personali.
- Wrapper e script di distribuzione/ripristino per un solo dispositivo che registravano le identità storiche dei dispositivi o affermavano risultati da prove private.
- Indirizzi host effettivi, directory home, identità di contenitori/dispositivi e istantanee di manutenzione storica. I test conservati utilizzano dispositivi esplicitamente sintetici; gli strumenti operativi mantenuti richiedono input target espliciti.
- I dischi guest, lo stato di accesso Android, le sessioni del browser, i pacchetti di installazione, i pesi dei modelli e le prove private sono esterni alla distribuzione di origine pubblica.

L'archivio privato e i tag di consegna originali rimangono intatti. Niente in questa pulizia dell'origine modifica gli account dell'appliance, i dati degli ospiti, i servizi in esecuzione o la distribuzione del sito web. L'impostazione predefinita di fabbrica `admin / admin` viene deliberatamente mantenuta; non è una credenziale privata. Gli amministratori devono modificarlo prima dell'esposizione.

## Revisione e verifica

Esamina sia l'albero di lavoro che ogni commit/tag raggiungibile nel repository in fase di pubblicazione. Usa Gitleaks più `tools/open_source_sensitive.py`; nessuno dei due da solo è la prova dell’assenza di password a bassa entropia o metadati personali. Confronta i vecchi valori privati ​​confermati utilizzando una lista nera privata esterna, mai un dispositivo di prova impegnato. Esamina i risultati rimanenti individualmente, inclusi i file di test.

I controlli di pulizia riguardano la politica di origine, la regressione sintetica, la configurazione e i controlli di sintassi. Non accedono utilizzando le credenziali scoperte, non reinstallano una scatola né ripetono l'accettazione del prodotto. La precedente correzione del pacchetto API (inclusa l'origine dell'interfaccia utente condivisa e il controllo del punto di ingresso di sola importazione) rimane nell'origine.

I nuovi cloni non devono importare commit, riferimenti o tag ritirati. L'eliminazione di un repository non richiama le copie già scaricate da altri. Nessuna scansione può stabilire che una credenziale sconosciuta non sia mai stata copiata; una credenziale effettivamente utilizzata deve essere ruotata dal suo operatore. Questa pulizia non afferma di averlo ruotato.

Consulta [RELEASING.md](RELEASING.it.md) per istruzioni sull'esportazione e sulla revisione del codice sorgente e [BUILDING.md](BUILDING.it.md) per i prerequisiti di creazione e le risorse ottenute separatamente.
