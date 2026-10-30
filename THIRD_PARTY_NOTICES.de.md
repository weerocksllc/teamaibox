<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.de.md)
<!-- doc-navigation:end -->

# Lizenzumfang und Hinweise Dritter

Urheberrecht © 2026 Weerocks LLC. Die Root-Lizenz [MIT](LICENSE) umfasst den ursprünglichen Team AI Box-Code und die vom Eigentümer autorisierte Dokumentation. Es erfolgt keine Neulizenzierung von Code Dritter, kopierten/geänderten Upstream-Dateien, Abhängigkeiten, Modellen, Firmware, Betriebssystemen, Schriftarten oder Bildern. Vorhandene Urheberrechts-, LIZENZ- und HINWEIS-Dateien haben Vorrang für ihr jeweiliges Material. Die Paketmetadaten `license: MIT` beziehen sich auf den Originalcode dieses Pakets, nicht auf alles, was in einem bereitgestellten Image enthalten ist. `private: true` wird beibehalten, um eine versehentliche Veröffentlichung der Paketregistrierung zu vermeiden; Die MIT-Bewilligung wird dadurch nicht widerrufen.

## Inventar

Das maschinenlesbare [Komponenteninventar](docs/open-source/components.json) erfasst Versionen oder Versionsquellen, Lizenznachweise, den Umfang der Weiterverbreitung und ungelöste binäre Verpflichtungen. [Abhängigkeitsinventar](docs/open-source/dependencies.json) wird aus der Sperrdatei, installierten Abhängigkeitsmetadaten, Go-Modulen und Python-Anforderungsdateien generiert. Fehlende Lizenzmetadaten sind ausdrücklich unbekannt und werden nicht angenommen MIT. Generieren Sie es mit `python3 tools/open_source_inventory.py` neu.

| Komponente / Material | Lizenzgrenze | Vertriebsanforderungen |
| --- | --- | --- |
| UxPlay-Empfänger und `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Behalten Sie GPL, Hinweise, genaue Upstream-Quelle, Patches und Build-Skripte mit jeder Empfänger-Binärdatei bei; Eine bloße Verlinkung zum Upstream reicht für eine Binärversion nicht aus. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Bewahren Sie Hinweise auf und stellen Sie geänderte, abgedeckte Quelldateien zur Verfügung. |
| GStreamer | LGPL und individuelle Plugin-Lizenzen | Überprüfen Sie das aktuelle Plugin-Set und erfüllen Sie die entsprechenden Verpflichtungen. |
| LiveKit-Server-/Browser-SDK | Apache-2.0 | Behalten Sie das Urheberrecht, die Lizenz und die entsprechenden HINWEISE bei. |
| Tintenfisch / AOSP | Apache-2.0 und Lizenzen pro Datei, einschließlich GPL-Kernel | Bewahren Sie Upstream-Hinweise und die entsprechende entsprechende Quelle auf. AOSP beinhaltet keine Lizenz für Google-Dienste. |
| QEMU / Linux / EDK II / Virtio-Treiber | Lizenzen pro Projekt und pro Datei | Überprüfen Sie den tatsächlichen Binär-Build, die Firmware und die Treiber. Nicht pauschal mit MIT kennzeichnen. |
| Guacamole | Apache-2.0 | Behalten Sie die von der Docker-Datei des Computer-Plugins kopierte LIZENZ und HINWEIS bei. |
| Knoten-/Reagierungs-/Vite- und JS-Abhängigkeitsbaum | Lizenzen pro Paket | Behalten Sie Abhängigkeitshinweise bei, wenn Sie die gebündelte Ausgabe verteilen. |
| PostgreSQL- und Container-Betriebssystempakete | PostgreSQL / pro Paket | Fügen Sie Lizenzdatensätze für installierte Pakete in eine Binärversion ein. |
| PyMuPDF / MuPDF wird von OCR verwendet | AGPL-3.0-or-later oder kommerzielle Lizenz | Die kombinierte OCR-Worker-Verteilung/der kombinierte OCR-Worker-Dienst ist nicht pauschal MIT; den AGPL-Verpflichtungen nachzukommen oder kommerzielle Rechte zu erlangen. Der ursprüngliche Code behält möglicherweise seine MIT-Gewährung. |
| Qwen / LMT / Whisper / FLUX-Modellressourcen | Genaue Modellbedingungen | Modelle sind von der Quellgewährung MIT getrennt. FLUX **4B**-Bedingungen dürfen nicht durch ein anderes FLUX-Modell ersetzt werden. |
| HunyuanOCR-Gewichte | Tencent Hunyuan Community-Lizenz | Bedingte Modelllizenz; Überprüfen Sie die Bedingungen für Empfänger, Gebiet, Nutzung, Namensnennung und Weiterverbreitung für jede Veröffentlichung. |
| NVIDIA Software | NVIDIA und enthaltene Bedingungen Dritter | Die vorhandene Host-Docker/NVIDIA-Installation wird durch dieses Quellpaket nicht weitergegeben. Gebündelte CUDA-/Containerbibliotheken benötigen noch eine eigene Überprüfung. |
| Google Mobile-Dienste / Play Store | Proprietär | Nicht Teil des öffentlichen Quellenkandidaten. Der Laufzeitintegrationscode gewährt keine Rechte zum Verteilen von GMS-Bildern. |
| Windows-Installationsmedien, Gastfestplatten, Konten | Nicht abgedeckt | Benutzer stellen autorisierte ISO-Medien und Lizenzen zur Verfügung. Versenden Sie niemals Test-VM-Festplatten oder einen angemeldeten Gaststatus. |
| Im Ruhestand befindliches ViKey SDK | Proprietär / keine öffentliche Förderung eingerichtet | SDK aus der Arbeitsquelle entfernt; Private historische Commits und aufbewahrte SDK-Kopien dürfen nicht veröffentlicht werden. Es ist kein USB-Stick erforderlich. |

Genaue Casting-Hinweise verbleiben in [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). ADB-Transportbenachrichtigungen bleiben neben dem Telefon-Client. Entfernen Sie sie nicht beim Minimieren oder Verpacken. Die Container-Isolierung allein hebt die Copyleft-Pflichten nicht auf. Die Verteilungsanalyse hängt vom tatsächlichen kombinierten Artefakt ab.

## Marke und Mitwirkende

MIT gewährt eine Urheberrechtsgenehmigung, keine Markenrechte oder Billigung. Team AI Box und Weerocks Namen/Logos dürfen keine offizielle Unterstützung für ein modifiziertes Produkt implizieren. NVIDIA, DGX Spark, Android, Google Play, Windows und Apple/AirPlay gehören ihren jeweiligen Besitzern. Kompatibilität ist keine Zertifizierung.

Bei den Metadaten lokaler Autoren handelt es sich um eine Bestandsaufnahme und nicht um einen Nachweis der Urheberrechtsübertragung. Die überprüften Eigentumskategorien werden in [OWNERSHIP.md](docs/open-source/OWNERSHIP.de.md) aufgezeichnet. Die Autorisierung des Projektinhabers gilt für seine ursprünglichen Beiträge; Mitwirkende dürfen nur Werke einreichen, zu deren Lizenzierung sie berechtigt sind. Vermutlich fehlende Namensnennung: teamaibox@weerocks.llc.
