<!-- Generated from docs/readme-locales/ and docs/readme-features/de.json by tools/render-readmes.mjs. -->
# Team AI Box — Open-Source-Software für NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Machen Sie Ihren NVIDIA DGX Spark zum KI-Arbeitsbereich Ihres Teams.** Nutzen Sie lokale KI, Bildgenerierung und Dokumentwerkzeuge auf NVIDIA DGX Spark. Team AI Box vereint Teamdateien, Nachrichten und virtuelle Geräte in einem quelloffenen Arbeitsbereich im Browser.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Vollständige Funktionsübersicht](#features) · [Auf einem neuen DGX Spark installieren](#install) · [Gemeinsam weiterentwickeln](#contribute)

## Warum Team AI Box?

- **Ein gemeinsamer Arbeitsbereich:** einheitliche Oberfläche und Konten für KI, Zusammenarbeit und Geräte.
- **Lokale KI im Mittelpunkt.** Führen Sie Modellinferenz auf Ihrem Spark aus und binden Sie bei Bedarf externe Modell-APIs ein.
- **Für DGX Spark entwickelt.** Installieren Sie auf Ubuntu ARM64 mit NVIDIA-GPU-Containern und KVM-Virtualisierung.
- **Offen für Verbesserungen:** eigener Code unter MIT, 17 Sprachen, helle/dunkle Designs und gespeicherte manuelle Auswahl. Standardsprache ist Englisch.

## Der echte Arbeitsbereich

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/de/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/de/workbench-light.jpg">
  <img src="docs/assets/screenshots/de/workbench-light.jpg" alt="Team AI Box für NVIDIA DGX Spark mit KI-Apps und Teamwerkzeugen — Deutsch" width="1280">
</picture>

[Helles Design](docs/assets/screenshots/de/workbench-light.jpg) · [Dunkles Design](docs/assets/screenshots/de/workbench-dark.jpg)

<a id="features"></a>

## Vollständige Funktionsübersicht

**Zu einem Modul springen**

- [Arbeitsbereich und tägliche Navigation](#feature-workspace)
- [KI-Assistent und kontrollierte Agent-Abläufe](#feature-assistant)
- [KI-Bilderzeugung](#feature-drawing)
- [Texterkennung und Korrektur](#feature-ocr)
- [Transkription von Aufnahmen und Live-Sprache](#feature-transcription)
- [Übersetzung von Texten, Dateien und Medien](#feature-translation)
- [Team-Messaging](#feature-messaging)
- [Team-Laufwerk und gemeinsame Dateiarbeit](#feature-drive)
- [AirPlay-kompatible drahtlose Bildschirmübertragung](#feature-casting)
- [Dauerhaft gespeicherte virtuelle Android-Telefone](#feature-phones)
- [Virtuelle Windows- und Linux-Computer](#feature-computers)
- [Administration, Berechtigungen und Sicherheit](#feature-administration)
- [Installation aus Quellcode und Wartung](#feature-installation)
- [Open-Source-Entwicklung und Erweiterungen](#feature-developers)

<a id="feature-workspace"></a>

### Arbeitsbereich und tägliche Navigation

- Nutzen Sie einen gemeinsamen Browser-Arbeitsbereich für lokale KI, Teamarbeit und virtuelle Geräte auf einem einzigen DGX Spark.
- Durchsuchen Sie Anwendungen nach Kategorien, suchen Sie im Anwendungskatalog und öffnen Sie Apps über die Seitenleiste.
- Sehen Sie den Ladefortschritt, die Verfügbarkeit und den Dienststatus jeder Anwendung.
- Verfolgen Sie wartende, laufende, abgeschlossene, fehlgeschlagene und abgebrochene Arbeiten im Aufgabencenter und öffnen Sie verfügbare Ergebnisse.
- Sehen Sie ausstehende Einladungen zur Bildschirmübertragung im Benachrichtigungsmenü und öffnen Sie die Übertragungs-App, um darauf zu antworten.
- Wählen Sie aus 17 Oberflächensprachen, darunter Arabisch mit Rechts-nach-links-Darstellung. Englisch bleibt die Standardsprache, bis Sie eine andere auswählen.
- Verwenden Sie das helle oder dunkle Design oder folgen Sie der Systemeinstellung. Manuell gewählte Sprache und Design bleiben nach Aktualisierungen, erneuter Anmeldung und beim Wechsel zwischen Anwendungen erhalten.

<a id="feature-assistant"></a>

### KI-Assistent und kontrollierte Agent-Abläufe

- Starten Sie Gespräche, speichern Sie deren Verlauf und öffnen Sie frühere Unterhaltungen erneut.
- Wählen Sie für die aktuelle Anfrage den Modus Automatisch, Antwort oder Agent.
- Fügen Sie einer Anfrage mehrere Dateien hinzu und entfernen Sie Anhänge vor dem Senden.
- Lesen Sie Antworten während der Generierung, stoppen Sie einen laufenden Vorgang und setzen Sie den Ereignisstrom nach einer erneuten Verbindung fort.
- Prüfen Sie zurückgegebene Modelldetails, Werkzeugaktivitäten, Quellen und Nutzungsdaten. Laden Sie erzeugte Dateien herunter, sofern der Vorgang welche erstellt.
- Prüfen Sie den Umfang einer bestätigungspflichtigen Agent-Aktion und erlauben oder verweigern Sie diese Aktion.
- Führen Sie Agent-Arbeiten in einer benutzerspezifischen Sandbox mit dauerhaftem Arbeitsbereich aus. Werkzeuge und Netzwerkzugriff unterliegen den Richtlinien des Administrators.

<a id="feature-drawing"></a>

### KI-Bilderzeugung

- Erzeugen Sie mit dem verfügbaren Bildmodell ein Bild aus einer Texteingabe. Die aktuelle App ist kein Bildbearbeitungs- oder Inpainting-Editor.
- Wählen Sie die automatische oder schnelle Bilderzeugung, sofern die verfügbare Modellkonfiguration dies unterstützt.
- Wählen Sie quadratische, Quer- oder Hochformate, unterstützte Ausgabegrößen sowie einen zufälligen oder festen Seed.
- Fordern Sie PNG-, WebP- oder JPEG-Ausgaben an, sehen Sie eine Vorschau und laden Sie das Bild herunter.
- Verfolgen Sie Warteschlange und Generierungsfortschritt, brechen Sie Arbeiten ab und stellen Sie die aktuelle Aufgabe nach erneutem Öffnen der Seite wieder her.
- Prüfen Sie das tatsächlich verwendete Modell und die mit dem Ergebnis gespeicherten Generierungsparameter.

<a id="feature-ocr"></a>

### Texterkennung und Korrektur

- Laden Sie PNG-, JPEG-, WebP- oder PDF-Dateien hoch oder wählen Sie eine vorhandene Datei aus dem Team-Laufwerk.
- Geben Sie einen Sprachhinweis an und erkennen Sie Text, Markdown-Tabellen oder LaTeX-Formeln im Rahmen der Fähigkeiten des ausgewählten Modells.
- Prüfen Sie Erkennungsergebnisse nach Seiten und Textblöcken und korrigieren Sie den erkannten Text manuell.
- Exportieren Sie überprüfte Inhalte als Text, Markdown oder JSON.
- Übergeben Sie ein gespeichertes Erkennungsergebnis an die Übersetzung, ohne die Quelle erneut hochzuladen oder zu erkennen.
- Verfolgen Sie Erkennungsaufträge und brechen Sie sie ab. Das aktuelle Modell liefert weder Begrenzungskoordinaten noch Konfidenzwerte.

<a id="feature-transcription"></a>

### Transkription von Aufnahmen und Live-Sprache

- Wählen Sie lokale oder im Team-Laufwerk gespeicherte Audio- und Videodateien: WAV, FLAC, OGG, WebM, MP3, M4A, AIFF oder MP4.
- Sehen oder hören Sie das Ausgangsmedium in der Vorschau und verwenden Sie automatische Spracherkennung oder einen unterstützten Sprachhinweis.
- Prüfen Sie Transkriptabschnitte mit Zeitstempeln und bearbeiten Sie deren Text.
- Exportieren Sie Text, JSON oder Untertitel im SRT- oder WebVTT-Format.
- Übergeben Sie ein gespeichertes Transkript an die Übersetzung und verfolgen oder beenden Sie die aktuelle Transkriptionsaufgabe.
- Transkribieren Sie Mikrofoneingaben live, wenn HTTPS, Browserberechtigung, MediaRecorder und der Echtzeitdienst verfügbar sind.
- Nutzen Sie Wortzeitstempel oder Sprechertrennung nur mit unterstützten Profilen. Der experimentelle Ablauf zur Sprechertrennung benötigt WAV-Eingaben.

<a id="feature-translation"></a>

### Übersetzung von Texten, Dateien und Medien

- Wählen Sie aus dem modellbasierten Katalog mit 60 Sprachen, lassen Sie die Ausgangssprache automatisch erkennen oder wählen und tauschen Sie Ausgangs- und Zielsprache. Gleiche Qualität für alle Sprachpaare wird nicht zugesichert.
- Übersetzen Sie eingegebenen oder eingefügten Text und vergleichen Sie Original- und Übersetzungsabschnitte.
- Laden Sie ein Bild oder PDF hoch oder wählen Sie es aus dem Team-Laufwerk. Bei einsatzbereiter OCR wird der Text vor der Übersetzung erkannt.
- Übersetzen Sie unterstützte Audio- und Videodateien über die Transkription und behalten Sie die Abschnittszeiten bei, wenn der Transkriptionsdienst bereit ist.
- Verwenden Sie gespeicherte OCR- oder Transkriptionsergebnisse erneut und laden Sie verfügbare Zwischenergebnisse herunter.
- Bearbeiten Sie übersetzten Text und exportieren Sie Text, Markdown oder JSON. Audio- und Videoergebnisse unterstützen außerdem SRT und WebVTT.
- Verfolgen Sie Extraktion, Transkription und Übersetzung, brechen Sie Arbeiten ab und stellen Sie die aktuelle Aufgabe nach erneutem Öffnen wieder her.
- Die Übersetzungssprachen sind unabhängig von den Sprachen der Oberfläche und der OCR-/Spracherkennung. PDF-Übersetzung ist textbasiert und keine Wiederherstellung des Originallayouts oder allgemeine DOCX-/XLSX-Bearbeitung.

<a id="feature-messaging"></a>

### Team-Messaging

- Finden Sie Teammitglieder, starten Sie direkte Gespräche und erstellen Sie benannte Gruppenchats mit ausgewählten Mitgliedern.
- Filtern Sie nach allen, ungelesenen oder Gruppenchats und durchsuchen Sie Gespräche und Nachrichten, auf die Sie zugreifen dürfen.
- Senden Sie Text und Dateianhänge und laden Sie die ursprüngliche Dateiversion eines Anhangs herunter.
- Empfangen Sie Nachrichten live, verbinden Sie sich wieder mit dem Chatverlauf, verfolgen Sie gelesene und ungelesene Positionen und sehen Sie den Anwesenheitsstatus der Mitglieder.
- Senden Sie mit Eingabe, fügen Sie mit Umschalt+Eingabe einen Zeilenumbruch ein und wechseln Sie auf schmalen Bildschirmen zwischen Gesprächsliste und Chat.
- Löschen Sie eine Nachricht aus Ihrer eigenen Ansicht oder leeren Sie Ihren eigenen Chatverlauf. Die Aufzeichnungen anderer Teilnehmer werden nicht gelöscht.
- Entfernen Sie einen Chat aus Ihrer Gesprächsliste, ohne die Gruppe zu verlassen. Eine neue Nachricht kann ihn wieder anzeigen.

<a id="feature-drive"></a>

### Team-Laufwerk und gemeinsame Dateiarbeit

- Organisieren Sie persönliche und gemeinsame Dateibereiche mit Ordnern und einer Pfadnavigation.
- Wechseln Sie zwischen Listen- und Rasteransicht, prüfen Sie Dateidetails, suchen Sie Dateien und Ordner und sehen Sie die letzten Änderungen.
- Laden Sie mehrere Dateien hoch, verfolgen Sie den Fortschritt und brechen Sie einen Upload ab.
- Setzen Sie den mehrteiligen Upload einer großen Datei fort, indem Sie dieselbe Datei erneut auswählen. Bereits hochgeladene Teile werden vom Server überprüft.
- Erstellen Sie Ordner und benennen, verschieben oder kopieren Sie Dateien und Ordner.
- Sehen Sie unterstützte Bilder, Audio, Video, Text und PDFs in der Vorschau und laden Sie Dateien herunter. Die Medienwiedergabe hängt vom Browser ab.
- Laden Sie eine neue Dateiversion hoch, prüfen Sie den Versionsverlauf und laden Sie frühere Versionen herunter.
- Verschieben Sie Elemente in den Papierkorb und stellen Sie sie wieder her.
- Teilen Sie intern mit Mitgliedern oder Teams über Lese- und Bearbeitungsrechte und eine optionale Ablaufzeit. Anonyme öffentliche Freigabelinks sind damit nicht gemeint.
- Durchsuchen Sie mit Ihnen geteilte Dateien und Ordner. Der Zugriff wird anhand der aktuellen Berechtigungen und Mitgliedschaften erneut geprüft.

<a id="feature-casting"></a>

### AirPlay-kompatible drahtlose Bildschirmübertragung

- Starten und stoppen Sie einen temporären Empfänger für kompatible Apple-Geräte im selben LAN mit eigenem Empfängernamen und PIN.
- Wählen Sie eine Empfängerlaufzeit von 15, 30, 60 oder 120 Minuten. Beim Stoppen oder Ablaufen enden die Empfängerankündigung und der Zugriff für Zuschauer.
- Beschränken Sie die Ansicht auf sich selbst, ausgewählte Mitglieder oder ein Team. Eingeladene Zuschauer können annehmen oder ablehnen.
- Sehen Sie den Bildschirm und hören Sie den Ton im Browser. Automatische Wiedergaberegeln des Browsers können einen Klick zum Aktivieren des Tons erfordern.
- Sehen und entfernen Sie verbundene Zuschauer. Ein Administrator kann eine Sitzung stoppen, ohne dadurch Zugriff auf private Inhalte zu erhalten.
- Sehen Sie den Status bei Verbindungsabbruch und Wiederverbindung. Beim erneuten Beitritt wird die Ansichtsberechtigung nochmals geprüft.
- Erfordert eine einsatzbereite Medienlaufzeit, erreichbare LAN-Geräteerkennung und kompatible Browser- und Geräteversionen. Die Browseransicht bietet weder HDMI-Ausgabe noch DRM-/FairPlay-Wiedergabe oder Apple-Zertifizierung.

<a id="feature-phones"></a>

### Dauerhaft gespeicherte virtuelle Android-Telefone

- Erstellen Sie unabhängige Android-Telefone aus installierten Systemprofilen. Die Apps und Daten jedes Telefons bleiben über Sitzungen hinweg erhalten.
- Starten Sie einzelne Telefone, fahren Sie sie herunter, starten Sie sie neu, benennen Sie sie um oder löschen Sie sie ausdrücklich.
- Bedienen Sie Android mit Tastatur und Zeiger sowie den Tasten Zurück, Startbildschirm, Letzte Apps und Lautstärke.
- Nutzen Sie Ton und Vollbild, verbinden Sie sich erneut oder übertragen Sie die aktive Telefonverbindung auf eine andere Seite.
- Laden Sie Dateien auf das Telefon hoch und aus dessen Team AI Box-Übertragungsordner herunter.
- Installieren Sie nach Bestätigung eigene APK-Dateien. Android-App-Berechtigungen werden nicht stillschweigend erteilt.
- Speisen Sie bei entsprechender Unterstützung ein Bild, Video oder die Browserkamera in die virtuelle Kamera ein. Physische USB-Kameras und Netzwerkeingänge benötigen zusätzlich Einrichtung und Berechtigungen durch den Administrator.
- Erlauben Sie vorübergehend gerätebezogenes ADB-Debugging über ein kurzlebiges Relay mit Standard-ADB-Werkzeugen und dem Node.js-Relay-Client.
- Prüfen Sie bei Bedarf Bildrate, Paketverluste und Umlaufzeiten der Verbindung. Diese Werte garantieren keine Ende-zu-Ende-Latenz.
- Wählen Sie ein Google Play-Systemprofil nur, wenn dessen Ressourcen verfügbar sind. Verfügbarkeit bedeutet weder Play Protect-Zertifizierung noch eine Funktionsgarantie für jede Android-App.

<a id="feature-computers"></a>

### Virtuelle Windows- und Linux-Computer

- Erstellen Sie unabhängige ARM64-Windows-/Linux-Computer mit gewählter CPU-, Speicher- und Festplattenausstattung.
- Starten Sie einen Computer, fahren Sie ihn ordnungsgemäß herunter und löschen Sie einen ausgeschalteten Computer nach ausdrücklicher Bestätigung.
- Öffnen Sie einen virtuellen Monitor im Browser, um Firmware-, Start-, Installations- und Betriebssystembildschirme zu sehen, ohne sich zuvor per Remotedesktop anzumelden.
- Verwenden Sie Tastatur, Zeiger, Ton, Vollbildanzeige und Wiederverbindungssteuerung.
- Öffnen Sie denselben virtuellen Computer in mehreren Browser-Tabs oder -Fenstern.
- Laden Sie Teammitglieder zum Betrachten oder Steuern eines Monitors ein und widerrufen Sie deren Zugriff.
- Übergeben Sie die Steuerung an einen Teilnehmer, geben Sie sie frei oder holen Sie sie als Eigentümer zurück. Wählen Sie Einzel- oder gemeinsame Steuerung.
- Laden Sie ein Installations-ISO mit Pause, Fortsetzung und Abbruch hoch oder wählen Sie ein vorhandenes ISO aus dem persönlichen oder Team-Laufwerk.
- Legen Sie virtuelle optische Medien ein oder werfen Sie sie aus und wählen Sie einen einmaligen Start vom Datenträger. Ein Medienwechsel startet den Computer nicht automatisch neu.
- Installieren Sie ein ARM64-Betriebssystem, zu dessen Nutzung Sie berechtigt sind, und verwenden Sie optional separat Remotedesktop. Die Windows-Lizenzierung liegt in Ihrer Verantwortung; voraktiviertes Windows und allgemeine Unterstützung für x86-Gastsysteme sind nicht enthalten.

<a id="feature-administration"></a>

### Administration, Berechtigungen und Sicherheit

- Erstellen Sie lokale Mitglieder, verwalten Sie den Kontostatus und setzen Sie Kennwörter zurück, soweit Ihre Rolle dies erlaubt.
- Weisen Sie integrierte Rollen zu, prüfen Sie Berechtigungen und verwalten Sie Teammitgliedschaften mit Schutzmaßnahmen für eigentümerbezogene Aktionen.
- Filtern Sie Audit-Ereignisse nach Bereich oder Korrelations-ID, prüfen Sie Details und fordern Sie eine Integritätsprüfung des Audit-Verlaufs an.
- Prüfen Sie den Status von Gerät, Anwendungen, Speicher und Ausführungsdiensten im Administrationsbereich.
- Konfigurieren Sie externe KI-Anbieter und Modell-/Operationszuordnungen, erneuern Sie Zugangsdaten und aktivieren oder deaktivieren Sie Anbieter.
- Legen Sie erlaubte lokale und externe Routing-Richtlinien mit ausdrücklicher Zustimmung zur externen Verarbeitung fest. Lokale KI benötigt keinen externen API-Schlüssel.
- Prüfen Sie installierte Modellprofile, Laufzeitversionen, Bereitschaft und Validierungsdetails.
- Importieren Sie überprüfte Plugin-Pakete und verwalten Sie Installation, Aktualisierung, Aktivierung, Deaktivierung und Entfernung geeigneter Plugins. Für geschützte offizielle Plugins gelten Einschränkungen.
- Prüfen Sie Ausführungswarteschlangen und Aufträge, passen Sie zulässige Planungsrichtlinien an und brechen Sie dafür geeignete Arbeiten ab.
- Prüfen Sie die Einstellungen für verschlüsselten Speicher und Startschutz. Die automatische Entsperrung verwendet einen lokalen Schlüssel; eine Passphrase beim Start lässt sich erst nach Wiederherstellungsprüfung und Bestätigung aktivieren.

<a id="feature-installation"></a>

### Installation aus Quellcode und Wartung

- Installieren Sie nach einem öffentlichen Git-Klon mit einem dokumentierten Quellcode-Installationsbefehl auf einem kompatiblen, noch nicht eingerichteten DGX Spark.
- Bereiten Sie Build-Werkzeuge vor, laden Sie Modelle und Laufzeitkomponenten herunter, bauen und paketieren Sie Anwendungsimages und installieren Sie sie unter Wiederverwendung der vorhandenen Docker-/NVIDIA-Umgebung.
- Setzen Sie unterbrochene Vorbereitungen mit demselben Befehl und Arbeitsverzeichnis fort und verwenden Sie überprüfte Downloads und abgeschlossene Schritte erneut.
- Führen Sie Vorabprüfungen, reine Download-Vorbereitung oder reine Build-Paketerstellung aus.
- Bereiten Sie ein vollständiges portables Paket zur Installation auf einem Offline-Ziel vor. Die Vorbereitung aus dem Quellcode selbst benötigt Netzwerkzugriff.
- Prüfen Sie festgelegte Eingabedateien und nutzen Sie bei Bedarf dokumentierte alternative Quellen oder überprüfte portable Caches. Für Drittanbieter-Mirrors wird keine Garantie gegeben.
- Initialisieren Sie neue gerätespezifische Zugangsdaten und das dokumentierte Konto admin/admin und ändern Sie anschließend dessen Kennwort. Übernehmen Sie keine Konten oder Gastdatenträger einer anderen Box.
- Prüfen Sie Wartungsvorschläge, Kompatibilitätsbefunde, ausdrücklich festgelegte Ausführungspläne und deren Verlauf mit begrenzten Rücksetz- und Wiederherstellungsanweisungen – keine beliebigen automatischen Betriebssystem- oder Treiber-Upgrades.

<a id="feature-developers"></a>

### Open-Source-Entwicklung und Erweiterungen

- Lesen, ändern und verbreiten Sie den selbst entwickelten Produktcode und die Dokumentation unter MIT. Drittanbieterkomponenten behalten ihre eigenen Lizenzen.
- Entwickeln Sie ApplicationPlugin- oder ComputePlugin-Erweiterungen mit den öffentlichen SDK-Verträgen und mitgelieferten Beispiel-Plugins.
- Verwenden Sie signierte Paketmanifeste sowie Integritäts- und Berechtigungsprüfungen für Plugin-Importe. Dies bedeutet nicht, dass ein öffentlicher Plugin-Marktplatz verfügbar ist.
- Tragen Sie Fehlerkorrekturen, Übersetzungen, Dokumentation und Integrationen über Issues und Pull Requests bei. Melden Sie Sicherheitslücken über den privaten Meldeweg.

## Was ist NVIDIA DGX Spark?

NVIDIA DGX Spark ist ein kompaktes Desktop-KI-System mit dem GB10 Grace Blackwell Superchip. Die 128-GB-Konfiguration kombiniert eine Arm-CPU mit 20 Kernen, eine Blackwell-GPU und 128 GB gemeinsamen Systemspeicher bei 273 GB/s Speicherbandbreite. NVIDIA nennt bis zu 1 PFLOP theoretische KI-Rechenleistung mit FP4-Präzision und Sparsity.

Unified Memory ist gemeinsam genutzter Systemspeicher, kein dedizierter VRAM. Die Spezifikationen hängen von der Konfiguration ab; theoretische Rechenleistung garantiert weder Anwendungsgeschwindigkeit noch gleichzeitige Nutzerzahlen.

DGX Spark liefert die Rechenleistung. Team AI Box ergänzt eine gemeinsame Oberfläche für lokale Inferenz, Bildgenerierung, OCR, Transkription, Übersetzung und Zusammenarbeit. Die Erstinstallation aus dem Quellcode lädt Abhängigkeiten herunter und erstellt vor der Einrichtung die Laufzeitumgebung.

[Offizielle Hardwarespezifikationen von NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box ist ein unabhängiges Projekt von Weerocks LLC und kein Produkt, keine Zertifizierung oder Empfehlung von NVIDIA. Die unterstützte Hardware ist in den folgenden Installationsvoraussetzungen definiert.

<a id="install"></a>

## Auf einem neuen DGX Spark installieren

Benötigt wird ein **noch nicht eingerichteter DGX Spark mit Ubuntu 24.04 ARM64**, funktionierendem Docker Engine/Compose v2, NVIDIA-Treibern und Container-Unterstützung, KVM, Git und Python 3.10+. Mehrere hundert GB temporären Platz für Modelle, Builds und Paket vorsehen. Keine Neuinstallation über vorhandene Geschäftsdaten ausführen.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Diese Befehle **auf dem Spark** ausführen. Das Skript lädt Modelle und Build-Eingaben, baut Images, erstellt ein vollständiges Offline-Paket und installiert es. Der erste Quellcode-Build braucht Internet und Zeit; Klonen allein installiert nichts. Docker/NVIDIA werden wiederverwendet.

### Vorprüfung und Fortsetzen

`--check` prüft Voraussetzungen. Bei Unterbrechung `/var/tmp/teamaibox-source-build` behalten und **denselben Befehl** erneut ausführen; geprüfte Downloads und abgeschlossene Schritte werden genutzt. Cache nicht löschen, keine konkurrierenden Builds starten. Standard sind offizielle Quellen. Bei Netzproblemen nennt die [Anleitung](install/SOURCE-INSTALL.de.md) Alternativen oder den Transfer geprüfter Caches/Offline-Pakete; Spiegel sind nicht garantiert erreichbar. Geänderter Code braucht ein neues `--work-dir`, keine umgangenen Prüfpunkte.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Nach der Installation

1. `https://<BOX_LAN_IP>/` mit der aktuellen LAN-Adresse öffnen und das lokal erzeugte HTTPS-Zertifikat dem eigenen Gerät zuordnen.
2. Mit `admin` / `admin` anmelden, **Startpasswort ändern** und normale Konten anlegen. Standardzugang nicht ins Internet stellen.
3. Anwendungsbereitschaft abwarten und Sprache/Design im Profil wählen.
4. Eigene berechtigte Windows/Linux-ARM64-ISOs und Lizenzen verwenden. Für Offline-Ziele zuerst das vollständige Paket vorbereiten und die [Paket-Anleitung](install/README.de.md) nutzen. Quellcode-Vorbereitung ist online.

## Lizenz und Grenzen

Eigener Code und Dokumentation sind MIT, **nicht sämtliche installierten Binärdateien**. Drittcode, Modelle, NVIDIA, Firmware, Google und Windows behalten ihre Bedingungen. Git enthält keine Gewichte, installierten Gastplatten, Anmeldespuren, ISOs oder Offline-Pakete. Google-Kompatibilität ist keine Play-Protect-Zertifizierung; Casting umfasst weder DRM noch Apple-Zertifizierung. Windows 10 ARM64 wird nicht als unterstützt beworben. Leistung und Parallelität hängen von Last und Hardware ab.

<a id="contribute"></a>

## Gemeinsam weiterentwickeln

Fehlerberichte, Dokumentation, Übersetzungen, Barrierefreiheit, Integrationen und Code sind willkommen. Problem als Issue beschreiben, forken, einen fokussierten Branch erstellen und PR mit passenden Prüfungen und Bildern einreichen. Für Dokumentation oder isolierte Komponenten ist kein Spark nötig; Hardwareprüfungen ehrlich kennzeichnen. Keine Geheimnisse, persönlichen Dateien oder angemeldeten Geräte-Images hochladen. Sicherheitslücken privat nach SECURITY.md melden. Kein verpflichtendes CLA und keine kostenpflichtige Mitarbeitserlaubnis.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.de.md) · [SECURITY](SECURITY.de.md)

## Weitere Informationen

- [Quellcode-Installation und Wiederaufnahme](install/SOURCE-INSTALL.de.md)
- [Offline-Paket](install/README.de.md)
- [Entwicklungsumgebung und Build](docs/open-source/BUILDING.de.md)
- [Mitwirken](CONTRIBUTING.de.md)
- [Private Sicherheitsmeldung](SECURITY.de.md)
- [Drittlizenzen und Veröffentlichungsumfang](THIRD_PARTY_NOTICES.de.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Drittlizenzen und Veröffentlichungsumfang](docs/open-source/RELEASING.de.md)
