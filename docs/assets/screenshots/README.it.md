<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.it.md)
<!-- doc-navigation:end -->

# Screenshot pubblici del prodotto

Queste sono acquisizioni reali del workbench di Team AI Box, un'immagine chiara e una scura per ciascuna delle 17 versioni locali dell'interfaccia utente. Si tratta di risorse di documentazione del prodotto, non della fonte, dei modelli o dell'output del sito Web di marketing privato.

## Cattura regole

- Utilizzare la lingua del prodotto e i controlli del tema; non tradurre le etichette su uno screenshot in inglese né inventare un risultato positivo.
- Utilizza un account dimostrativo e controlla ogni immagine per messaggi personali, nomi di file, credenziali, PIN del ricevitore, indirizzi di rete e Chrome del browser. Non pubblicare mai un disco ospite con accesso effettuato o un'esportazione di sessioni/cookie con immagini.
- Le acquisizioni del workbench corrente mostrano solo lo stato dell'attività dimostrativa generica e l'account amministratore generico. Non espongono i payload delle attività.
- Mantieni le impostazioni del prodotto come erano dopo l'acquisizione. Non eliminare i dati utente né eseguire nuovamente i carichi di lavoro aziendali per ottenere uno screenshot.
- `workbench-light.jpg` and `workbench-dark.jpg` sono gli originali. La maggior parte utilizza l'acquisizione dell'intera pagina. L'arabo utilizza il viewport effettivo perché l'acquisizione RTL dell'intera pagina del browser ha spostato la pagina; nessuna etichetta o risultato è stato modificato.
- Alcune parole relative allo stato delle attività live sono ancora in inglese nelle visualizzazioni altrimenti localizzate. Queste immagini preservano intenzionalmente l'interfaccia utente spedita invece di ritoccarla. I sistemi operativi guest, le risposte del modello e i nomi definiti dall'utente hanno impostazioni di lingua separate e non vengono tradotti dal selettore dell'interfaccia utente.

Il renderer README richiede entrambe le immagini per ogni lingua del prodotto e fallisce invece di ricorrere silenziosamente a uno screenshot in inglese. Quando aggiorni l'interfaccia utente, sostituisci entrambi i temi e rigenera il manifest dell'immagine con `node tools/screenshot-manifest.mjs`. Mantieni gli identificatori di rete/dispositivo e i log di acquisizione locale fuori da questa directory pubblica.
