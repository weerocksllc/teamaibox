<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.de.md)
<!-- doc-navigation:end -->

# Erstellen Sie die Quelle

Das öffentliche Artefakt ist die Quelle und kein vorgefertigtes Offline-Appliance-Image. Ein Quell-Build lädt möglicherweise Abhängigkeiten herunter. Die Installation mit einem vorbereiteten Vollpaket bleibt offline. Keiner der Prozesse benötigt ein ViKey SDK oder einen USB-Stick.

Für eine vollständige Appliance-Installation beginnen Sie mit dem Root-[Schnellstart](../../README.de.md#install) und dem [Quellinstallationsprogramm](../../install/SOURCE-INSTALL.de.md): `sudo bash install/from-source.sh` lädt herunter, erstellt, verpackt und installiert auf einem kompatiblen neuen Spark. Der folgende Entwicklungs-Web-Build ist kein Installationsprogramm und startet nicht das vollständige Produkt.

## Entwicklung

Verwenden Sie Node.js 24, pnpm 11.1.3 (siehe Root `package.json`), Python 3.10+ und die in jedem `go.mod` deklarierte Go-Version (Node-Agent derzeit 1.26). Auf einer Build-Maschine:

Ein Quellexport hat bewusst keine private Git-Historie. Bevor Sie Quelltools für diesen exportierten Baum ausführen, initialisieren Sie Ihr eigenes Repository und übergeben Sie Ihren überprüften Baum (`git init`, `git add .`, `git commit`). Ein normaler öffentlicher Git-Klon benötigt diesen Schritt nicht. Verwenden Sie dieses neue Commit als Build-Identität. Beanspruchen Sie nicht, dass ein exportierter, geänderter Baum der alte Liefer-Commit ist.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Der Web-Build ist eine Kompilierungsprüfung, keine Produktabnahme. Laufzeitdienste nutzen die Dockerfiles unter `deploy/`. Die Ausführung von DGX Spark erfordert Linux ARM64 und die vorhandene NVIDIA/Docker-Umgebung. Ein Desktop-Source-Checkout ist kein Ersatz für diese Hardware. Verwenden Sie keine historischen Laborskripte als Installationsprogramme.

Die Python-Factory-Build-Helfer erfordern zusätzlich PyYAML; Weitere Informationen finden Sie im Installationsprogramm-Abhängigkeits-Preflight. Es ist kein installierter Betriebssystemdatenträger oder Entwicklerkonto erforderlich.

## Ausgeschlossene kompilierte Eingaben

Der Exporter lässt Binärdateien weg, auch wenn ihre Erweiterung harmlos aussieht:

- Erstellen Sie `services/node-agent` und seinen `cmd/factory-worker-spec`-Helfer aus der Go-Quelle; Die ausführbare Repository-Root-Datei `node-agent` ist keine Quelleingabe.
- Android-Geräte-APKs und Signaturdateien werden nicht geliefert. Ihre Quelle und Manifeste unter `tools/fixtures/` bleiben für lokale Test-Builds verfügbar.
- Der aktuelle Appliance-Casting-Build verwendet `deploy/appliance/wireless-casting-plugin.Dockerfile`. Die alten Alpine-Paketarchive sind nicht erforderlich. Wenn Sie stattdessen das eigenständige Plugin Dockerfile verwenden, besorgen Sie sich die genauen Pakete, die in [seinem Upstream-Prüfsummenmanifest](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) identifiziert werden, und überprüfen Sie deren SHA-256-Werte vor dem Erstellen. Ersetzen Sie niemals ein beliebiges Paket, wenn das angeheftete Upstream-Artefakt nicht verfügbar ist.
- Das LiveKit-Browsermodul und seine Lizenz verbleiben im öffentlichen Quellverzeichnis des Plugins; Das redundante npm-Archiv `.tgz` wird nicht ausgeliefert.

Hierbei handelt es sich um Ausschlüsse für die Quellverteilung, nicht um Änderungen an der ausgeführten Appliance.

## Komplettes Offline-Paket

Beginnen Sie mit [der öffentlichen Quellpipeline](../../install/PUBLIC-BUILD.de.md). Es stellt die öffentlichen übergeordneten Images und die von der Quelle erstellten Laufzeitabhängigkeiten bereit. Eine vorherige Entwicklerinstallation ist nicht erforderlich. Historische Layer-Image-Rezepte sind nicht der Einstiegspunkt für Neuinstallationen.

Folgen Sie [install/README.md](../../install/README.de.md) für Anwendungs-Image-Builds, Gast-Host-Tools, Offline-Host-Pakete, Asset-Sammlung und endgültige Verpackung. Die Ziel-Appliance ruft keine Abhängigkeiten ab und ersetzt Docker/NVIDIA nicht. Legen Sie Build-Eingaben auf Ihren tatsächlichen Quell-Commit, ARM64-OCI-Inhalts-IDs und saubere Asset-Pfade fest. Es sind keine IP-Adresse, kein Konto, kein Zertifikat oder kein Volume für den Entwicklungshost erforderlich. Modellgewichtungen und Gast-/Laufzeitressourcen werden separat von den genauen Upstream-Quellen abgerufen, die in [components.json](components.json) und den Repository-Sperren identifiziert werden. Bewahren Sie ihre Lizenzen und erforderlichen Quellenhinweise auf.

**Quellenverfügbarkeit ist keine Freigabe für die binäre Weiterverteilung.** Der aktuelle vollständige Offline-Paketvertrag beinhaltet eine Google Android-Laufzeitumgebung; Sein privater Installationsnachweis stellt keine Erlaubnis zur Verbreitung von GMS dar. Der vorhandene Packager bleibt unverändert erhalten, aber ein solches Paket ist kein genehmigter öffentlicher Download, es sei denn, diese Rechte werden erworben. Eine nur für AOSP verfügbare öffentliche Binärversion wäre eine gesonderte Paketänderung, die hier nicht stillschweigend ersetzt wird. Windows/Linux-ISO-Dateien werden von jedem Benutzer bereitgestellt; Keine installierten Testgäste oder Kontostatus sind öffentliche Build-Eingaben.
