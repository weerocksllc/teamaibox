<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.de.md)
<!-- doc-navigation:end -->

# Von einem öffentlichen Klon installieren

Dieser Einstiegspunkt bereitet die erforderlichen öffentlichen Eingaben vor, erstellt die Anwendungsimages und erstellt vor der Installation ein vollständiges Paket. Der Baufortschritt ist fortsetzbar; Nur das endgültige Ergebnis der Installationsbereitschaft weist auf eine installierte Appliance hin. Download- oder Preflight-Erfolg alleine reicht nicht aus.

Bewahren Sie generierte Modelle, Container-Images, Installationspakete, Testaufzeichnungen und Anmeldeinformationen außerhalb des Repositorys auf. Die Verfügbarkeit von Spiegeln von Drittanbietern kann nicht garantiert werden; Verifizierte tragbare Caches und Offline-Pakete werden unten beschrieben.

Klonen Sie auf einem neuen DGX Spark mit Ubuntu 24.04, funktionierendem Docker/Compose, NVIDIA und KVM das öffentliche Repository und führen Sie es von seinem Stammverzeichnis aus aus:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Für ein Netzwerk auf dem chinesischen Festland, in dem die Upstream-Modell-/Image-Endpunkte nicht erreicht werden können, verwenden Sie denselben Einstiegspunkt mit regionalen Downloadquellen:

```sh
sudo bash install/from-source.sh --region cn
```

Dies ist ein **Online-Quell-Build mit anschließender Offline-Installation**, kein Offline-Quell-Build. Es bereitet fehlende Build-Tools automatisch vor, lädt die sechs Modelleingaben herunter, erstellt und assembliert Android- und alle Anwendungs-Images, quantisiert die beiden Quellmodelle, sammelt Firmware-/Host-Pakete, erstellt das vollständige Offline-Paket und führt das vorhandene Installationsprogramm aus. Es ersetzt weder Docker/NVIDIA noch den Docker-Daemon neu, löscht keine bestehende Installation oder ändert Host-Routing, DNS- oder VPN-Einstellungen. Modelle, Gast-Login-Status und die private Marketing-Website werden nicht von einer anderen Installation übernommen.

Der Standardarbeitsbereich ist `/var/tmp/teamaibox-source-build`; Laden Sie Caches und Protokolle pro Stufe live dort herunter, außerhalb des Klons. Die Installation erfolgt standardmäßig auf `/srv/teamaibox/installation`. Erwarten Sie große Downloads und mehrere hundert GB temporäre Festplattennutzung. Das Laden des Modells und die GPU-Quantisierung können viel Zeit in Anspruch nehmen. Es wird keine feste Fertigstellungszeit versprochen.

## Installation fortsetzen und Status prüfen

Bei einer Unterbrechung **führen Sie genau denselben Befehl erneut aus**. Behalten Sie den Arbeitsbereich. Ein laufender Build schließt einen anderen Autor aus; Fertige Bühnendateien und Bilder werden vor der Wiederverwendung überprüft. Fehlgeschlagene Versuche bleiben für die Diagnose verfügbar, während beim nächsten Versuch nur die fehlgeschlagene Phase ausgeführt wird. Modellbytebereiche und überprüfte Dateien bleiben erhalten. `state.json` identifiziert die aktuelle Stufe und ihr Protokollverzeichnis. Offizielle Modell-Downloads verwenden begrenzte Datei-/Bereichs-Parallelität; Regionale Quellen nutzen konservative Parallelität, um die Ratenbegrenzung zu reduzieren. Fortschrittsberichte pro Dateibyte übertragen oder wiederverwendet werden, getrennt von der endgültigen Herausgeber-Hash-Überprüfung. Die Kompilierung des Gasttools funktioniert auch unter einem Systemdienst ohne Login-Home: Es werden isolierte Build-Caches außerhalb der resultierenden Installationsressourcen erstellt.

Quelländerungen erfordern ein neues `--work-dir`; Verwenden Sie den Download-Cache mit `--cache-dir /path/to/public-cache` erneut. Der Quell-Fingerabdruck verhindert, dass Ausgaben aus unterschiedlichem Code stillschweigend kombiniert werden. Eine bestehende Installation ist keine Aufforderung, sie zurückzusetzen: Nur die Installation desselben Pakets dieses Arbeitsbereichs kann fortgesetzt werden; Andere Installationen müssen ihren Upgrade-Prozess verwenden.

Nützliche Modi:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` ist schreibgeschützt und gibt keinen Anspruch auf erfolgreiche Downloads. „Nur Download“ und „Nur Build“ erheben ausdrücklich keinen Anspruch auf Installationsbereitschaft.

## Regionale Quellen und Integrität

Der China-Modus verwendet `https://hf-mirror.com` für die Modellübertragung und `https://docker.m.daocloud.io` für Digest-Pinned-Docker-Hub-Eingaben. Hierbei handelt es sich um Spiegel von Drittanbietern, nicht um Dienste, die von Weerocks oder den Modellherausgebern betrieben werden. Der Modell-Git-Commit wird durch das Produktprofil angeheftet; Sein verifizierter Git-Baum und die LFS-Zeiger ermitteln die erwarteten Dateigrößen und Hashes. Die API-Antwort des Spiegels allein kann kein Vertrauen herstellen. Docker überprüft angeheftete Manifest-/Layer-Digests. Nicht angeheftete Tags werden nicht automatisch umgeleitet (das Go-Build-Tool verfügt über eine explizite Digest-Sperre). NVIDIA Bilder verbleiben in der Registrierung ihres Herausgebers. Die TLS-Überprüfung bleibt aktiviert und es werden keine Kontotokens an Modellspiegel gesendet.

Mit `--model-endpoint` and `--registry-mirror` können Sie Ihre eigenen HTTPS-Ursprünge auswählen. Endpunktwerte dürfen keine Anmeldeinformationen oder Abfrageparameter enthalten. Der bereichsbezogene Docker-Wrapper gilt nur für diesen Build-Prozess, nicht für den System-Daemon oder andere Projekte. SDK-Metadaten und Lizenzarchive stammen weiterhin von ihren maßgeblichen HTTPS-Herausgebern; Ein Spiegel kann keine Hashes erfinden.

Mirrors können ratenbegrenzt oder nicht verfügbar sein. Modell-Downloads werden mit begrenzter Parallelität ausgeführt und berücksichtigen Abklingzeiten. Kein Skript kann die Konnektivität zu jedem Upstream in jedem Netzwerk garantieren. Sollten beide Routen nicht verfügbar sein, bereiten Sie Downloads oder das komplette Paket auf einem zugänglichen kompatiblen Rechner vor und kopieren Sie diese über:

- `--download-models-only --cache-dir <public-cache>` bereitet verifizierte Modelldateien und fortsetzbare Caches vor. Kopieren Sie dieses Verzeichnis und übergeben Sie es dann mit `--cache-dir` an das Ziel. Jedes wiederverwendete Modell wird anhand seiner angehefteten Identität überprüft. Bei diesem Cache handelt es sich **kein** um ein vollständiges Offline-Installationspaket.
- `--build-only` bereitet das vollständige Paket für die Offline-Installation vor. Kopieren Sie den Tar-Code und die Prüfsumme, verifizieren und entpacken Sie ihn und führen Sie dann darin `sudo ./install.sh` aus. Dies ist die zuverlässige Route für getrennte Hosts. Es ist kein VPN auf dem Ziel oder Zugriff auf eine Entwicklungsbox erforderlich.

Kopieren Sie niemals ein Live-Docker-Datenverzeichnis, Gastfestplatten, Browserprofile, Kontodatenbanken, Anmeldeinformationen oder private Caches als Ersatz für öffentliche Eingaben. Deaktivieren Sie keine Prüfsummen und akzeptieren Sie keine Anmelde-/Herausforderungsseite als Modelldatei.

## Lizenzierung und Erstnutzung

Lesen Sie vor dem Erstellen `THIRD_PARTY_NOTICES.md`, die Android SDK-Bedingungen und die einzelnen Modelllizenzen. Durch das Herunterladen von Komponenten Dritter werden diese nicht in MIT-Assets umgewandelt und Google erhält keine Zertifizierungs-/Weiterverbreitungsrechte. Windows/Linux-ISO-Medien werden weiterhin vom Benutzer bereitgestellt. Die Werksanmeldung bleibt `admin/admin`; Ändern Sie es, bevor Sie das Gerät freilegen. Das vorhandene Installationsprogramm generiert unabhängige Dienstanmeldeinformationen und meldet die tatsächliche Bereitschaft.

Öffnen Sie nach Abschluss `https://<BOX_LAN_IP>/` im selben LAN. Ersetzen Sie die aktuelle physische Netzwerkadresse des Spark, nicht eine Docker-Bridge oder VPN-Adresse. Der `state.json` des Quellarbeitsbereichs zeichnet den Build-Fortschritt auf. Das installierte `/srv/teamaibox/installation/readiness.json` zeichnet Installationsprüfungen auf. Weder eine erfolgreiche Kompilierung noch eine Integritätsprüfung des Listening-Containers ersetzen den sichtbaren End-to-End-Vorgang einer Anwendung.

Die Casting-Laufzeit muss den UxPlay-Receiver, die ausführbaren Dateien für Private D-Bus und Avahi Discovery sowie die Medien-Plugins enthalten. Der endgültige öffentliche Image-Build überprüft diese ausführbaren Dateien. Eine Client-Bibliothek allein reicht nicht aus. Eine Neuinstallation registriert den Desktop-Proxy und das Gateway bei den anderen API-Netzwerk-Namespace-Abhängigen, sodass gruppierte API-Upgrades den Desktop-Verbindungspfad beibehalten können. Erstellen Sie während der Wartung nicht nur eine Teilmenge dieser Gruppe neu.
