<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.de.md)
<!-- doc-navigation:end -->

# Team AI Box Offline-Installationspaket

Die Lizenz für den Originalcode befindet sich im Paket `LICENSE`. Komponenten von Drittanbietern behalten ihre Originallizenzen; siehe `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT gewährt keine zusätzlichen Weiterverbreitungsrechte für Google-Dienste, Windows, Modellgewichte oder Marken von Drittanbietern. Durch das Bestehen der Paketintegritätsprüfungen wird nicht für jede Komponente die Erlaubnis zur Weiterverteilung erteilt.

Dieses Paket ist für ein neues DGX Spark unter Beibehaltung eines kompatiblen Werks-Linux-Systems. Es nutzt die vorhandene Docker-, Compose- und NVIDIA-GPU-Umgebung, ohne diese zu ersetzen oder die Systemfestplatte zu formatieren.

## Installation

Überprüfen Sie das Archiv mithilfe der beigefügten Datei `.sha256` und extrahieren Sie es dann:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Für die normale Installation ist weder ein öffentlicher Internetzugang noch eine manuelle Bearbeitung der Umgebungsvariablen erforderlich. Das Installationsprogramm stellt die erforderlichen gebündelten Tools bereit, generiert eine unabhängige lokale Konfiguration, initialisiert eine neue Datenbank und startet Dienste. Das anfängliche Laden des Modells kann einige Zeit dauern. Eine Ladeanzeige ist keine Bestätigung einer erfolgreichen Installation.

Führen Sie `sudo ./install.sh --check` aus, um die Umgebung und das Paket zu überprüfen, ohne es zu installieren. `./install.sh --verify-package` prüft nur den Paketinhalt und kann auch auf der Verpackungsarbeitsstation ausgeführt werden. Verwenden Sie `--installation-root /dedicated/path/installation`, um ein neues Installationsstammverzeichnis anzugeben. Richten Sie es niemals auf vorhandene Daten.

## Unterbrechungen und vorhandene Daten

Beheben Sie nach einem Fehler oder einer Unterbrechung das gemeldete Problem und wiederholen Sie den ursprünglichen Befehl. Löschen Sie nicht das Installationsverzeichnis. Das Installationsprogramm behält die Identität und die von ihm generierten Daten bei. Bei der erneuten Ausführung einer vollständigen Installation derselben Version wird lediglich deren Status überprüft. Andere Versionen verwenden den offiziellen Upgrade-Pfad, nicht das Löschen und Neuinstallieren. Es gibt keine Option zum erzwungenen Überschreiben.

## Erster Gebrauch

Öffnen Sie die HTTPS-Adresse unter der aktuellen IP der Appliance und melden Sie sich an:

- Administrator-Benutzername: `admin`
- Anfangspasswort: `admin`

Der Installer erstellt diesen Administrator automatisch; Es ist keine Setup-Token-Extraktion oder manuelle Registrierung erforderlich. Das Initialpasswort ist öffentlich und einfach: Ändern Sie es vor der Auslieferung/Nutzung in der Benutzerverwaltung. Normale Benutzer haben kein Standardkonto und werden vom Administrator erstellt. Dies gilt nur für eine leere Kontodatenbank; Fortsetzen, erneut ausführen, neu starten und aktualisieren, niemals bestehende Konten oder Passwörter auf die Standardeinstellungen zurücksetzen. Der unabhängig generierte Administrator-Wiederherstellungscode wird im Installations-Root unter `secrets/initial-owner-recovery.json` gespeichert und ist nur für Root lesbar. Senden Sie niemals Wiederherstellungscodes an Chats, Tickets oder öffentliche Protokolle. Bestehende Installationen generieren oder ersetzen keine Wiederherstellungscodes. Konfigurieren Sie für das lokal ausgestellte HTTPS-Zertifikat die Browser-Vertrauensstellung gemäß den CA-Anweisungen des Administrators. Ein Name in einem Zertifikat garantiert keine LAN-DNS/mDNS-Auflösung. Das öffentliche Zertifikat der lokalen Zertifizierungsstelle befindet sich normalerweise unter `/srv/teamaibox/installation/https/ca.crt`. Verteilen Sie nur das öffentliche Zertifikat, niemals den daneben liegenden privaten Schlüssel.

Die Installation umfasst keine vorhandenen virtuellen Maschinen, den Google-Anmeldestatus oder Benutzerdateien. Benutzer laden Windows/Linux-ISOs hoch oder wählen sie aus dem Teamlaufwerk aus und installieren dann die Gastsysteme selbst. Google Play und externe APIs erfordern einen Internetzugang und sind nicht im Offline-Verfügbarkeitsversprechen enthalten.

Komponentenlizenztexte bleiben mit ihren Release-Ressourcen erhalten. Urheberrecht © Weerocks LLC. Kontakt: teamaibox@weerocks.llc.
