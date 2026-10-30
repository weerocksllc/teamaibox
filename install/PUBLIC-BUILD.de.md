<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.de.md)
<!-- doc-navigation:end -->

# Erstellen Sie eine Appliance aus der öffentlichen Quelle

Der neue Orchestrierungseinstiegspunkt ist in [SOURCE-INSTALL.md](SOURCE-INSTALL.de.md) dokumentiert. Es automatisiert die folgenden Rezepte; Dort wird der Status der vollständigen Geräteüberprüfung angegeben. Diese manuellen Rezepte bleiben für Wartungspersonal und für die individuelle Phasendiagnose verfügbar.

Dies ist der Pfad von der Quelle zum Paket. Eine frühere Team AI Box-Installation, ihre Container, Konten, Zertifikate, Gäste oder Datenbanken werden nicht importiert. Die Build-Maschine benötigt einen Internetzugang. Das resultierende Komplettpaket wird offline installiert. Der Kunde stellt Windows/Linux-Installationsmedien separat zur Verfügung.

Verwenden Sie Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 und ausreichend Speicherplatz für Quelldownloads, Build-Layer und das endgültige unkomprimierte Bundle. Für die Modellquantisierung ist außerdem eine kompatible NVIDIA GPU mit ausreichend freiem Speicher erforderlich. Stoppen Sie andere Workloads nicht, um diesen Speicher ohne die Erlaubnis des Maschinenbesitzers zu erhalten. Docker und NVIDIA sind Voraussetzungen, keine Komponenten, die vom Installationsprogramm ersetzt werden.

Führen Sie Befehle von einer neuen öffentlichen Kasse aus aus. Legen Sie `BUILD` auf ein neues, absolutes Build-Verzeichnis **außerhalb** des Checkouts fest. Ausgaben, Modelle und Berichte dürfen nicht festgeschrieben werden. Jeder Helfer lehnt eine belegte Ausgabe ab, es sei denn, er dokumentiert einen bestimmten Wiederaufnahmevorgang. Verwenden Sie die Referenzen/IDs des erfolgreichen Berichts, nicht die Namen der Bilder, die von einem anderen Computer kopiert wurden. Eine lokale Docker-Inhalts-ID ist keine herunterladbare Registrierungsreferenz; Übergeordnete Dockerfile-Argumente benötigen das entsprechende lokale Tag oder einen qualifizierten Upstream-Digest.

## 1. Dienste und Anwendungen

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` betrifft Online-**Builds**, nicht installierte Dienstnetzwerke. Knotenabhängigkeitsstufen erlauben 2 Sekunden pro Verbindungsversuch anstelle des Knotenstandards von 250 ms. Dadurch bleiben offizielle NPM-Downloads auf Links mit höherer Latenz, einschließlich benutzerverwalteter VPNs, nutzbar, ohne die Registrierung zu wechseln, IPv6 zu deaktivieren oder TLS-/Paketintegritätsprüfungen zu schwächen. Bei der Einstellung handelt es sich um ein Argument für die Build-Phase, nicht um eine Umgebungsänderung in der installierten Anwendung. Für eine langsamere Verbindung können direkte Docker-Builds `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000` überschreiben. Das Web-Image erstellt seine eigenen gesperrten Abhängigkeiten und Assets. Knotendienste nutzen den neu erstellten API-Abhängigkeitsabschluss gemeinsam. OCR beinhaltet seinen öffentlichen Adapter; Es ist kein unveröffentlichtes Arbeitspaket aus einem anderen Projekt erforderlich. Die Übersetzung verwendet das angeheftete öffentliche NVIDIA vLLM-Image. Einbettungs-, Batch-ASR- und Casting-Medien teilen bewusst ihre jeweiligen öffentlichen Laufzeitbilder. Das Computer-Image erstellt signaturverifiziertes QEMU 11.1.1 mit ARM TPM/PPI-, KVM-, VNC- und PulseAudio-Unterstützung und behält dabei die Funktionen der ursprünglichen Windows-Runtime bei. Debian stellt Laufzeitbibliotheken bereit, sein älteres QEMU-Paket darf diese ausführbare Datei jedoch nicht ersetzen. Das endgültige Image überprüft sowohl die ARM TIS-Eigenschaft `ppi` als auch das PulseAudio-Backend und enthält das passende RAM-Framebuffer-ROM. Informationen zum begrenzten Laufzeittest und zu den datenerhaltenden Aktualisierungsanforderungen finden Sie im [Leitfaden zur Laufzeit virtueller Computer](../deploy/windows-computer/README.de.md).

Jede Rolle verfügt über ein Protokoll. Bei einem fehlgeschlagenen Bericht bleiben erfolgreiche Rollenausgaben erhalten. Erstellen Sie nur die fehlgeschlagene Rolle und führen Sie die erfolgreichen Berichte später zusammen. Ersetzen Sie keinen laufenden Entwicklungscontainer als fehlendes Image.

## 2. Android- und Kamera-Laufzeit ohne Konto

Die Sperren fixieren Googles AOSP-Build, Host-Paket, Kernel-Eingaben und Quellrevisionen. Downloads werden vor der Nutzung geprüft. Während der Montage wird kein Gast gebootet.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Installieren Sie für den Kamera-APK-Patch die öffentlichen Android-Befehlszeilentools von Google, die Plattform `android-36.1`, die Build-Tools `36.1.0` und eine JDK-unterstützende Java-Version
8. Legen Sie `ANDROID_SDK_ROOT` and `JDK_HOME` auf diese Toolverzeichnisse fest. Bei den Tools handelt es sich um Build-Abhängigkeiten, nicht um exportierte Android-Benutzerprofile. Unter ARM64-Linux ist Googles gebündeltes `zipalign` möglicherweise nur x86: Installieren Sie das ARM64-Paket `zipalign` von Ubuntu und übergeben Sie unten `--zipalign /usr/bin/zipalign`. D8 und apksigner sind Java-Programme. Der APK-Build kann alternativ auf einem separaten unterstützten SDK-Host ausgeführt werden; Übertragen Sie nur die beiden Ausgabedateien (`Camera2.apk`, `camera-preview.json`), niemals die Android-Einstellungen oder das Benutzerprofil dieses Hosts.

Extrahieren Sie das Standard-APK aus dem sauberen AOSP-Build (das Ausgabeverzeichnis muss vorhanden und für den Build-Container beschreibbar sein):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

Das APK behält den bekannten **öffentlichen AOSP-Testsignierer**, keinen privaten Produktschlüssel. Der Helfer überprüft das Original- und resultierende Zertifikat sowie die unveränderten APK-Ressourcen und entfernt temporäres Signaturmaterial. Dabei handelt es sich nicht um ein Konto oder eine Google-Geräteidentität.

Der aktuelle Komplett-Installer-Vertrag beinhaltet auch eine experimentelle Google-Android-Variante. Die öffentliche Eingabesperre und die Signaturprüfung gewähren Google **keine** Zertifizierungs- oder Weiterverbreitungsrechte. Erstellen/verwenden Sie es nur im Rahmen der geltenden Drittanbieterbedingungen; Veröffentlichen Sie das resultierende vollständige Paket nicht als uneingeschränkten MIT-Download.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Modelldateien des Herausgebers und öffentliches Quantisierungsrezept

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Alle Modell-Downloads verwenden die unveränderlichen Revisionen in `deploy/compute/*profile*` und die Git/LFS-Hashes des Herausgebers. Optional ist `--cache <directory>` schreibgeschützt und akzeptiert Dateien nur, wenn ihre Bytes mit denen des Herausgebers übereinstimmen. Es handelt sich nicht um eine Möglichkeit, ein installiertes Modellverzeichnis wahllos zu importieren. Der eigenständige MIT-Text von ASR ist an die ursprüngliche Whisper-Version angeheftet, da der konvertierte Modell-Snapshot nur die Lizenz deklariert. OCR behält seine eigene Lizenz, nicht MIT. Die angehefteten Übersetzungs- und Einbettungsmodellkarten deklarieren Apache-2.0, ohne den eigenständigen Text zu versenden; Zu ihren Helfern gehören die mit der Prüfsumme versehene Apache-Lizenz und ein Herkunftsnachweis nach Überprüfung dieser Erklärung.

Ein unterbrochener Matching-Download unterstützt `--resume`. `--transfer ranges` verwendet begrenzte fortsetzbare HTTP-Bereiche; `--transfer huggingface` erfordert die offiziellen `huggingface_hub`/`hf_xet`-Pakete und deaktiviert die Token-Nutzung. Teildateien und Download-Caches bleiben außerhalb der veröffentlichungsfähigen Modellverzeichnisse. Prüfsummen sind bei jedem Transport Pflicht. Schwächen Sie sie nicht für HTML-Anmelde-/Herausforderungsseiten oder verkürzte Downloads.

Die Quantisierung läuft offline in einem separaten Build-Container unter Verwendung der öffentlichen synthetischen Kalibrierungsdaten von ModelOpt, niemals Chat-Verläufe. Nur Ausgänge, deren `build.json` `quantized` besagt, können `assistant-model` and `translation-model` liefern; Wählen Sie deren Unterverzeichnisse `model/` aus, nicht die Rohquellen oder den gesamten Build-Arbeitsbereich. Nach der Validierung der Eingaben weisen Linux-Builds den Kernel an, die zwischengespeicherten Seiten dieser spezifischen Dateien freizugeben. Dies vermeidet irreführende Messwerte für sofort freien GPU-Speicher im gemeinsam genutzten Speicher von GB10; Es werden keine Gewichtungen gelöscht, keine hostweiten Caches geleert oder Arbeitslasten gestoppt. Für eine GB10-GPU stellt das Hilfsbudget von Linux `MemAvailable` zur Verfügung und reserviert Kapazität für die Kalibrierung und den Host. Es lehnt unzureichende Kapazität ab, anstatt stillschweigend einen Build zu akzeptieren, der hauptsächlich aus CPU besteht. Wenn das vollständige Modell passt, vermeiden explizite ModelOpt-Budgets den unnötigen CPU-Offload-Exportpfad von Accelerate. Der Build-Container legt außerdem unbegrenzten gesperrten Speicher und einen 64-MiB-Stack fest, entsprechend den Quantisierungsstartanforderungen von [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Diese Einstellungen gelten für den Build-Container und nicht für hostweite Beschränkungen.

## 4. Vervollständigen Sie die Paketeingaben

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

Die Fusion muss **41 Rollen und keine fehlenden Rollen** melden. Es überprüft Bildarchitektur/Inhalts-IDs und lehnt widersprüchliche Ausgaben ab. Die Ressourcen enthalten nur Upstream-UEFI-Firmware (einschließlich einer neuen Variable-Store-Vorlage), eine mit Prüfsummen versehene Virtio-Treiber-ISO, Source Drawing Runtime und Android-Hinweise, die an die neu erstellten Images gebunden sind. Das ISO ist kein Windows-Installationsmedium. Sein mit der Prüfsumme identischer Microsoft OpenVMM-Spiegel vermeidet die Abhängigkeit von einer interaktiven Fedora-Downloadseite.

Sammeln Sie Hostpakete mit `collect_host_packages.py`, wie in [README.md](README.de.md) beschrieben und generieren Sie dann die Vorlage mit `prepare-release.py --template`. Füllen Sie die Bildkarte mit `images.json`; Füllen Sie alle 12 Asset-Rollen aus den Modellausgaben aus, `resources/assets.json` and `guest-tools`. Legen Sie `sourceCommit` auf den Checkout und die tatsächliche Agentenversion fest. Es sind keine Platzhalter oder vorherigen Installationskonfigurationen zulässig.

Führen Sie `prepare-release.py --inputs … --output …` und dann `build-package.sh` mit dieser vorbereiteten Version aus. Geänderte/nicht festgeschriebene Quellen erfordern das explizite Kandidatenflag `--allow-working-tree`; Sie sind kein freigegebenes Commit. Informationen zur Installation finden Sie unter [PACKAGE-README.md](PACKAGE-README.de.md). Eine neue leere Kontodatenbank erhält `admin/admin`; Alle Dienstanmeldeinformationen und Geräteidentitäten werden unabhängig generiert. Builds allein beweisen nicht, dass die Installation erfolgreich war.

## Historische Schichtrezepte und Veröffentlichungsprüfungen

Ältere Diagnose-/Layer-Docker-Dateien werden zur Quellwartung beibehalten und von dieser Pipeline nicht verwendet. Ihre `BUILD_PARENT_N`-Argumente haben absichtlich keinen privaten Bildstandard. Stellen Sie ein von Ihnen erstelltes kompatibles übergeordnetes Element bereit oder verwenden Sie die oben stehende öffentliche Pipeline. Erraten Sie nicht, dass eine Entwicklungszusammenfassung nicht verfügbar ist.

Führen Sie vor der Veröffentlichung den Source Guard und Secret Scanner aus, überprüfen Sie den Verlauf separat und schließen Sie alle Build-Verzeichnisse, Pakete, Gastfestplatten, Kontodaten und die private Website aus. Berichte, die lokale Pfade enthalten, gehören außerhalb des öffentlichen Baums. Die Überprüfung dieser Arbeit beschränkt sich auf den Build-Eingabeabschluss, die Artefaktidentität, die Installation und die neu installierten Mindestdienstpfade. Es wird keine unabhängige Geschäftsakzeptanz wiederholt.
