<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.it.md)
<!-- doc-navigation:end -->

# Runtime del computer virtuale ARM

`Public.Dockerfile` crea la stessa funzionalità di presenza fisica (PPI) ARM TPM richiesta dal runtime `windows-arm64-ppi` originale. Costruisce QEMU 11.1.1 dalla versione ufficiale dopo aver verificato la sua firma staccata rispetto all'impronta digitale bloccata del gestore del rilascio. Debian fornisce le librerie e gli strumenti del contenitore, non l'eseguibile QEMU utilizzato per eseguire gli ospiti.

Non sostituire questo eseguibile con un pacchetto QEMU di distribuzione precedente. I profili Windows abilitano `tpm-tis-device,...,ppi=on`; una build senza la proprietà ARM termina prima dell'avvio del firmware. La rimozione di `ppi=on`, la disattivazione del TPM o la reimpostazione del TPM di un ospite non è una riparazione compatibile.

La build dell'immagine finale controlla il supporto ARM TIS PPI e PulseAudio e include la ROM framebuffer RAM corrispondente. Su un host KVM ARM, il `python3 /usr/local/bin/probe-ppi` in bundle esegue un controllo QEMU/TPM senza disco e in pausa. Non monta i dischi guest esistenti né dimostra che l'installazione di Windows è stata completata. L'avvio di Windows deve essere controllato separatamente su un guest di prova esplicitamente designato.

Per un'installazione esistente, utilizzare la policy di aggiornamento runtime della piattaforma e il digest dell'immagine del profilo Node Agent corrispondente. Conserva disco, firmware, identità e stato del TPM. Non ricreare i guest o modificare le immagini dei guest Linux in esecuzione semplicemente per riparare il runtime di Windows. Registra le immagini create localmente come non pubblicate finché le modifiche all'origine non vengono confermate e rilasciate.

Conserva la proprietà della configurazione installata e le autorizzazioni di lettura durante l'aggiornamento. Se l'API della piattaforma viene ricreata per caricare la policy di aggiornamento del runtime, ricrea anche i relativi dipendenti dello spazio dei nomi di rete (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` e `maintenance-controller`) dalle relative immagini invariate. Devono unirsi allo spazio dei nomi di rete del nuovo contenitore API. Questo non è un riavvio guest, daemon Docker o lavoratore AI. Attendere che il normale battito cardiaco autenticato del nodo ripristini la disponibilità prima di inviare un'operazione di avvio di Windows.
