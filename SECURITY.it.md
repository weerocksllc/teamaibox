<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.it.md)
<!-- doc-navigation:end -->

# Rapporti sulla sicurezza

Si prega di segnalare le sospette vulnerabilità in privato a **teamaibox@weerocks.llc**. Includi la versione interessata, la riproduzione minima, l'impatto e i registri oscurati. Non inserire credenziali, contenuti del cliente o dettagli di sfruttamento in questioni pubbliche. Richiedi un canale di trasferimento sicuro appropriato prima di inviare file sensibili. Non viene richiesta alcuna garanzia sui tempi di risposta o certificazione di sicurezza indipendente.

Le nuove installazioni offline attualmente utilizzano l'amministratore bootstrap documentato `admin` / `admin`; modificare la password prima di esporre l'appliance a utenti o a una rete non attendibile. Si tratta di una credenziale iniziale pubblica, non di un segreto da nascondere nella lista consentita dello scanner. Nessun account utente ordinario viene creato automaticamente. La modifica di questo comportamento di onboarding non rientra in questa modifica della licenza.

## Revisione della fonte/storia

Consulta [il limite della privacy della fonte pubblica](docs/open-source/SOURCE-PRIVACY.it.md) per i dati esclusi, la revisione della cronologia e le responsabilità di rotazione delle credenziali.

Esegui lo scanner locale aggiunto come descritto in [preparazione della versione](docs/open-source/RELEASING.it.md). I report sono privati, oscurati e mai caricati su un servizio di scansione esterno. Se una credenziale reale appare nella cronologia privata, la cancellazione da HEAD non costituisce revoca. Revocarlo/ruotarlo con il proprietario; la riscrittura o l'eliminazione della cronologia richiede un'autorizzazione separata. Le etichette di consegna originali non vengono spostate per la sanificazione.

Il candidato all'origine pubblica è una nuova esportazione di file senza `.git`, prove private, istantanee del dispositivo, dati degli ospiti o file binari con restrizioni. **Non** modificare semplicemente la visibilità di questo repository di sviluppo o pubblicare pubblicamente i suoi vecchi riferimenti.
