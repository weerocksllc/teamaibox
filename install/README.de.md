<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.de.md)
<!-- doc-navigation:end -->

# Team AI Box Offline-Paket-Tools

Das ursprüngliche Installationsprogramm ist MIT-lizenziert. Pakete enthalten die Root-Lizenz, Drittanbieter-Inventar und Lizenztexte in ihrem Datei-Hash-Inventar. Dadurch werden Modelle, Google-Dienste, Treiber oder Containerabhängigkeiten nicht als MIT neu lizenziert. Lesen Sie die [Releasegrenzen](../docs/open-source/RELEASING.de.md) vor der Verteilung; Ein vorhandenes vollständiges Testpaket verfügt nicht automatisch über eine Weiterverteilungsfreigabe.

Kunden führen **`sudo ./install.sh` innerhalb des vorbereiteten Pakets aus**. Betreuer erstellen dieses Paket mit `build-package.sh`. Offline-Kunden benötigen keine Git-, Node-, Go-, Pip- oder öffentlichen Paket-Repositorys.

Zum automatischen Herunterladen, Erstellen und Installieren von einem öffentlichen Klon führen Sie `sudo bash install/from-source.sh` aus. Netzwerke in China können `--region cn` verwenden. Siehe [SOURCE-INSTALL.md](SOURCE-INSTALL.de.md) für Betrieb, Fortsetzen und Offline-Übertragung. Lebenslauf wird unterstützt; Erst das endgültige Bereitschaftsergebnis stellt den Abschluss der Installation dar. Ein erfolgreicher Preflight oder Download reicht nicht aus.

Das Ziel ist ein neues DGX Spark mit seinem werkseitigen Ubuntu 24.04 ARM64-System und funktionierender Docker Engine, Compose v2, NVIDIA Container Toolkit/GPU und KVM. Das Installationsprogramm ersetzt Docker/NVIDIA nicht, startet Docker nicht neu und kopiert auch nicht die Konten, Datenbanken, Schlüssel oder virtuellen Maschinen einer Entwicklungs-Appliance.

> Private Installationsabnahmedatensätze bleiben im historischen Entwicklungs-Repository. Es handelt sich weder um öffentliche Quelldateien noch um Build-Eingaben. Vorhandene Erstinstallations-, Fortsetzungs- und Startwiederherstellungsnachweise werden nicht nur zur Quellveröffentlichung erneut ausgeführt und qualifizieren nicht für willkürlich neu erstellte Images oder gewähren keine Weiterverbreitungsrechte für Binärdateien von Drittanbietern.

## Betreuer: Release-Eingaben vorbereiten

**Für einen neuen öffentlichen GitHub-Build beginnen Sie mit [PUBLIC-BUILD.md](PUBLIC-BUILD.de.md).** Es deckt öffentliche Bilder, Kameralaufzeiten, Modell-Downloads/Quantisierung und Firmware ab, ohne dass Bilder von einer Entwicklungs-Appliance erforderlich sind. Die unten aufgeführten Layer-Image-Helfer unterstützen inkrementelle Aktualisierungen verifizierter Artefakte. Sie sind keine Voraussetzung für einen Neuaufbau.

Zur Vorbereitung kann das Internet genutzt werden. Bei der Installation aus dem gelieferten Paket dürfen keine Abhängigkeiten heruntergeladen werden. Der Verpackungshost benötigt Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` und ausreichend Speicherplatz. Modelle und Bilder können groß sein; Der Packager behält sowohl den extrahierten Baum als auch `.tar` und schätzt den Speicherplatz anhand der tatsächlichen Eingaben. Es scannt weder eine gesamte Entwicklungs-Appliance noch exportiert es beschreibbare Layer aus laufenden Containern.

1. Bereiten Sie ARM64-Images aus **einer Release-Version** für alle erforderlichen Rollen vor. Verwenden Sie die Build-Einstiegspunkte unter `deploy/images/`, `deploy/appliance/` und die entsprechenden Gast-/Modellverzeichnisse. Plattform-API, Node Agent, Scheduler und Agent Controller müssen lokale Image-IDs unterstützen; Das PostgreSQL-Image muss das aktuelle Migrationsmanifest enthalten, einschließlich Migration 116. Der Packager kompiliert kein beliebiges altes Image in ein aktuelles. Verwenden Sie bei verifizierten übergeordneten Images derselben Version `build_runtime_images.py --bases … --node-agent-binary … --output …`, um die fünf Nachfolgeimages zu erstellen. `--bases` ist eine JSON-Rollen-zu-Vollbild-ID-Zuordnung. Erstellen Sie zuerst den Node Agent mit `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Dieser Helfer verbietet Pulls/Netzwerkaufbauten, zeichnet Eltern-/Quellenidentitäten auf und erstellt neue Images, ohne Live-Tags bereitzustellen oder zu ändern. Saubere Android-ROMs benötigen außerdem den aktuellen Control-Network-Adapter. Verwenden Sie `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>`, um `phone_network.py` zu beiden ROM-Nachfolgeschichten hinzuzufügen, ohne Netzwerkzugriff oder ROM-Datenänderungen. Es zeichnet genaue Bild-IDs und Quellauszüge auf. Binden Sie den Android-Sidecar an beide neuen IDs, nicht an die vorherigen. Erstellen Sie das Web und neun offizielle Apps mit `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Erstellen Sie zunächst das Web wie in `apps/web/package.json` angegeben. Der Helfer verwendet Produktions-Dockerdateien, korrigiert das Webverzeichnis unter `/opt/teamaibox/web` und vergleicht Bilddateien mit aktuellen Build-Eingabe-Hashes. Gehen Sie nicht davon aus, dass es sich bei einem Entwicklungscontainer-Image um einen vollständigen Web-Build handelt: Es kann von zusätzlichen statischen Verzeichnisvariablen abhängen oder ein altes Verzeichnis enthalten. Dieser Offline-Helfer wird nicht bereitgestellt. Geben Sie alle zehn neuen Bild-IDs in die Freigabeeingänge ein.
2. Sammeln Sie vollständige, saubere Verzeichnisse für sechs Modelle: Konfiguration, Shards, Tokenizer, erforderlicher Code und Lizenzen. Bereiten Sie außerdem zwei saubere Android-Images vor, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` und die Zeichenlaufzeitskripte. Erfassen Sie keine Telefoninstanzverzeichnisse, Benutzerdatenträger, den Google-Anmeldestatus, Benutzer-ISOs oder globale Anmeldeinformationen. Android-ROMs sind bereits in `phone-runtime` / `phone-google-runtime` enthalten; Kopieren Sie keine zweite Festplatte. Die Asset-Verzeichnisse `android-standard` / `android-google` enthalten nur Herkunft, Lizenzen und `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` sowie `runtimeImageId: "sha256:…"`. Die ID muss mit dem exportierten Laufzeitbild übereinstimmen. Das Treiberverzeichnis enthält nur `virtio.iso`; Ein Entwicklungsverzeichnis, das auch `windows.iso` enthält, wird abgelehnt.
3. Erstellen Sie die beiden gebündelten Linux ARM64-Host-Tools, ohne sie auf dem Build-Host zu installieren:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Erfassen Sie auf einem mit dem Internet verbundenen ARM64-Build-Host Host-Tool-Abhängigkeiten mithilfe eines expliziten lokalen Ubuntu 24.04-Images. Verwenden Sie die auf diesem Host überprüfte Image-ID und keine von einer Entwicklungs-Appliance kopierte ID:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Sammeln Sie nur Abhängigkeiten für Cryptsetup, ext4, USB/Kameras, QEMU-Image-Tools, Netzwerke und kleine Systemdienstprogramme. Docker-, Containerd-, NVIDIA-, CUDA- und Kernel-Ersatzpakete sind verboten. Installation liefert nur fehlende Werkzeuge; apt liest das lokale Datei-Repository des Pakets mit `--no-download --no-remove`, ohne Online-Fallback.

5. Generieren Sie das Release-Input-Manifest und geben Sie **explizite Artefaktpfade und lokale Bildinhalts-IDs** an:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Die Vorlage umfasst alle 41 Bildrollen und 12 externen Asset-Kategorien; Ein weiteres Fabrikvermögen wird durch die Werkzeuge generiert. Platzhalter können kein Paket eingeben. `sourceCommit` muss mit dem Checkout übereinstimmen, `agentVersion` mit dem tatsächlichen Agent-Build und `hostPackageCollection` mit Schritt 4 `collection.json`. Build-Host-Pfade sind Sammlungseingaben, keine Kundenlaufzeitkonfiguration. Verwenden Sie den aktuellen Fabrikgenerator: Die `drawing.automatic` / `drawing.fast`-Routen der Zeichnungs-Benutzeroberfläche müssen mit der lokalen Modellkonfiguration übereinstimmen. Die Gesundheit des Arbeitnehmers oder ein direkter Modellaufruf allein stellt noch keine Einsatzbereitschaft her. Die Verpackung lehnt veraltete Factory-Vorlagen ab, denen diese Zuordnungen fehlen.

Der Bildrollenvertrag wird von `python3 install/package.py --describe-contract` gemeldet:

- Kern, Web, Teamlaufwerk, Messaging, Gateways, Planer, Wartung, Plugins, dynamische Agent-Sandboxes und Paketquellen-Gateways.
- Neun Anwendungs-Plugins, sechs Office-Modell-Worker und On-Demand-ASR-/Lautsprecher-Laufzeiten.
- Standard-Android, Google Android, Computer-Laufzeit- und Web-Anzeige-/Audio-Gateways.
- Casting-Receiver, Medienverarbeitung und SFU.

Zwei Rollen können eine Bildinhalts-ID gemeinsam nutzen; sein Archiv wird nur einmal exportiert. Modell-Shard-Indizes werden ebenfalls überprüft: Übereinstimmende Datei-Hashes entschuldigen nicht, dass ein Shard fehlt. Host-Tools müssen echte ARM64 ELF-Binärdateien sein.

## Erstellen Sie das Paket

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Die Ausgaben sind `teamaibox-<releaseId>-linux-arm64.tar`, die Datei `.sha256` und das extrahierte Verzeichnis. Kopieren, Bildexport, Hashing und Archivierung erfolgen in einem temporären Verzeichnis, bevor die endgültige Prüfsumme veröffentlicht wird. Vorhandene Ausgaben werden nicht überschrieben; Ein unterbrochener Build darf nicht wie eine vollständige Veröffentlichung aussehen. Für Änderungen nur durch das Installationsprogramm mit unveränderten Image-Identitäten verwenden Sie `--image-cache <previous-extracted-package>`. Das gesamte alte Paket wird überprüft, bevor seine Archive anhand der tatsächlichen Bild-ID wiederverwendet werden, und das neue Paket wird erneut überprüft. Es werden keine Daten von einer alten Installation oder Container-beschreibbaren Ebene übernommen. Dadurch wird vermieden, dass Hunderte GB identischer Bilder erneut exportiert werden.

Für eine normale Version müssen die gebündelten Quelldateien zum deklarierten Git-Commit gehören. Ein explizites `--allow-working-tree` erstellt einen Entwicklungskandidaten; seine Manifestdatensätze `candidate: true` und geänderte Dateien. Das Bestehen einer gezielten Akzeptanz führt nicht dazu, dass eine nicht festgeschriebene Quelle in eine veröffentlichte Veröffentlichung umgewandelt wird.

Paketlayout:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Überprüfen Sie unabhängig mit `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Dadurch wird die Integrität überprüft. es beweist keinen erfolgreichen Start auf neuer Hardware.

## Kunden: Offline-Installation und Fortsetzung

Lesen Sie die [Paketinstallationsanleitung](PACKAGE-README.de.md). Der Standardstamm ist `/srv/teamaibox/installation`. LUKS/ext4 wird nur innerhalb des neuen `volume/data.img` erstellt, nicht auf der Systemfestplatte oder vorhandenen Festplatten. Der Datenpool nutzt den verfügbaren Speicher abzüglich einer physischen Sicherheitsmarge und nicht einer festen Grenze von 256 GiB. Modelle, Geschäftsdateien und Gastdaten befinden sich im verschlüsselten Volume; Der vorhandene Docker verwaltet Container-Images.

Bei einer Neuinstallation wird der Administrator `admin` mit dem Anfangskennwort `admin` erstellt. Normale Benutzer werden vom Administrator erstellt. Ändern Sie das Initialpasswort vor der Auslieferung/Nutzung. Dies gilt nur für eine leere Kontodatenbank: Durch Fortsetzen, erneutes Ausführen, Neustarten und Upgrade werden vorhandene Konten oder Passwörter nicht zurückgesetzt. Geräteidentität, Dienstanmeldeinformationen, Zertifikate und Administrator-Wiederherstellungscodes werden unabhängig generiert und nicht von einer anderen Appliance kopiert. Die erste GPU-Kernel-Cache-Vorbereitung wird auf der Appliance mit gebündelten Tools und Modellen ausgeführt. Kompatible Caches bleiben erhalten. Bei der Boot-Wiederherstellung werden zuerst Daten und Gerätedienste wiederhergestellt, dann Kerndienste und einzelne KI-Mitarbeiter. Das Installationsprogramm wird nur während der Installation ausgeführt. Es wird kein residenter Installationsmanager hinzugefügt.

Wiederholen Sie nach der Unterbrechung den ursprünglichen Befehl. Abgeschlossene Schritte werden überprüft; Verstecken Sie Konflikte nicht, indem Sie Daten löschen oder Container neu erstellen. Beim erneuten Ausführen einer abgeschlossenen Installation derselben Version wird diese lediglich überprüft. Verschiedene Versionen verwenden den formalen Upgrade-Pfad. Fehlerdetails finden Sie in `install-state.json`, `readiness.json` und in den Phasendatensätzen im Installationsstammverzeichnis.

## Überprüfungsgrenzen

Installerspezifische Tests nutzen kleine Strukturartefakte, temporäre Dateien und isolierte Offline-Datenbanken/Docker-Daemons. Sie dürfen nicht auf Unternehmensdatenbanken zugreifen oder vorhandene VM-Festplatten mounten. Für eine echte Neuinstallation ist ein kompatibles DGX Spark erforderlich, das ausdrücklich für diesen Zweck vorgesehen ist. Löschen Sie kein Geschäftsgerät. Die Annahme umfasst die Mindestanforderungen an Start, Wiederaufnahme und Boot-Wiederherstellung für die neue Installation, nicht jedoch damit zusammenhängende Geschäftstests. Durch die Source-Release-Vorbereitung selbst werden vorhandene Appliances nicht gelöscht, neu installiert oder bereitgestellt.

Führen Sie auf einem Build-Host `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` aus, um das vollständige Paket in einen separaten Docker-Daemon mit leerem Cache und ohne öffentliches Netzwerk zu importieren. Es ruft nicht das Neuinstallationsskript auf, verwendet keine GPU, mountet keine Kundenverzeichnisse und startet das System-Docker nicht neu. Der Bericht behauptet ausdrücklich nicht, dass die Hardware vollständig installiert sei. Testbilder verbleiben im dedizierten Testverzeichnis, benötigen zusätzlichen Speicherplatz und gelangen nicht in den Bildspeicher des System-Dockers.
