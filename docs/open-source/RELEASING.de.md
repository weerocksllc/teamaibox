<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.de.md)
<!-- doc-navigation:end -->

# Grenzen freigeben

## Separate Artefakte

1. **MIT Quellkandidat**: Originalcode, aktuelle Spezifikationen, überprüfte Build-/Testtools und Hinweise; Keine Git-Historie oder private Laborbeweise.
2. **Material von Drittanbietern**: genaue Originalquelle/Binärdateien/Modelle mit eigener Lizenz und Quellenangabe. Copyleft-Quellenpflichten gelten für Binärdateien.
3. **Komplettes Offline-Appliance-Paket**: erstellt von `install/`; nicht automatisch für die öffentliche Weiterverbreitung lizenziert. GMS-, HunyuanOCR-, NVIDIA-Komponenten und Gast-/Firmwarelizenzen erfordern eine artefaktspezifische Überprüfung. Veröffentlichen Sie das private Paket, die Modellpakete oder angemeldeten Bilder nicht unter dem Label MIT.
4. **Marketing-Website**: `website/`, einschließlich seiner Artikelvorlagen, Inhalte, Design-Assets, Analysen und Bereitstellungskonfiguration, bleibt im privaten `weerocksllc/teamaibox.com` GitHub-Repository. GitLab ist ein historisches Archiv, nicht das Website-Entwicklungs-Repository. Die Website ist nicht Teil der öffentlichen Produktquellenverteilung. Die Appliance-Browser-Benutzeroberfläche in `apps/` bleibt Teil des Open-Source-Produkts.

Historische Bereitstellungs-, Wiederherstellungs- und Beweisaufzeichnungsskripte für ein Gerät sind keine wiederverwendbaren Produkttools. Die Veröffentlichungsrichtlinie schließt veraltete Skripte und Snapshots aus; Stellen Sie sie nicht aus dem privaten Archiv wieder her. Beibehaltene Tools erfordern explizite, vom Bediener bereitgestellte Ziele anstelle der Hosts, Konten, Container oder Beweisdateien eines Entwicklers. Führen Sie den zusätzlichen sensiblen Scan sowie Gitleaks durch: Geräte-IDs, Container-IDs, GSF-Hashes und persönliche Kontonamen testen Metadaten, auch wenn es sich dabei nicht um verwendbare Anmeldeinformationen handelt. Die Bereinigung des öffentlichen Verlaufs erfordert eine ausdrückliche Autorisierung durch den Eigentümer und darf das private Archiv oder seine Bereitstellungs-Tags niemals neu schreiben. Verwenden Sie nach einer autorisierten Umschreibung einen neuen öffentlichen Klon, anstatt den zurückgezogenen Verlauf wieder mit dem verwalteten Repository zusammenzuführen.

Das interne Entwicklungs-Repository und seine Tags bleiben erhalten. Der erreichbare Verlauf enthält alte Bereitstellungsdatensätze und veraltete proprietäre SDK-Assets. es darf nicht unverändert veröffentlicht werden. Ein frisch exportierter Baum stellt den öffentlichen Ausgangspunkt dar, ohne den ursprünglichen Lieferverlauf stillschweigend neu zu schreiben.

## Lokale Vorbereitung

Verwenden Sie **Gitleaks 8.30.1**, heruntergeladen von der offiziellen GitHub-Version, und überprüfen Sie die Prüfsumme. Das Audit-Tool installiert niemals Systempakete oder lädt Daten hoch. Die private Ausgabe wird ignoriert `.runtime/open-source-audit/`, keine öffentliche PR.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Ausgaben müssen neue Pfade sein; Die Tools überschreiben niemals frühere Kandidaten. Es zählt nicht nur die Überprüfung geschwärzter Orte. Dokumentieren Sie synthetische Vorrichtungen, öffentliche Bootstrap-Anmeldeinformationen, Identifikator-Falsch-Positiv-Ergebnisse und tatsächliche/mögliche private Anmeldeinformationen separat. Musterscans können keine Anmeldeinformationen oder OCR-Screenshots validieren. Binäre Artefakte sind ausgeschlossen und werden nicht als gescannt-sauber eingestuft. Der Quellexporter lässt nur Git-bekannte Dateien und explizite, nicht verfolgte Eingaben in [release-policy.json](release-policy.json) zu. Neue nicht verfolgte Eingaben müssen überprüft werden. Es lehnt Symlinks und Pfaddurchquerung ab und gibt SHA-256 pro Datei plus Ausschlüsse aus. `website/` wird immer ausgeschlossen, auch wenn es verfolgt oder als nicht verfolgte Eingabe aufgeführt wird. Kopieren Sie niemals das Verzeichnis `.git` des privaten Repositorys in einen öffentlichen Checkout. Stellen Sie vor der Veröffentlichung sicher, dass sowohl der Baum als auch alle erreichbaren öffentlichen Commits keine Website-Dateien enthalten. Durch das Löschen von Dateien in einem späteren Commit wird der alte Verlauf nicht entfernt.

Die zusätzliche Prüfung umfasst erreichbare Commit-/Tag-Nachrichten, Anmeldeinformations- und Anmeldeliterale mit niedriger Entropie, Geräteidentitäten und Entwicklungsadressen. Tests sind nicht automatisch ausgenommen: Erklären Sie, warum jede beibehaltene Vorrichtung synthetisch ist. Bekannte private Werte können mit `--denylist` als externes JSON-Array von `{id, value, word?}`-Datensätzen bereitgestellt werden. Verwenden Sie undurchsichtige, nicht sensible IDs. Bewahren Sie diese Datei außerhalb des Quell-Checkouts auf. Berichte zeigen Standorte und Hashes, niemals die Werte. Eine Übereinstimmung mit einem bekannten Marker führt dazu, dass die Prüfung fehlschlägt. Verwenden Sie beim Reinigen `--scope worktree`. Überprüfen Sie `--scope all` im neuen übergeordneten Release-Repository vor der Veröffentlichung. Veröffentlichen Sie nicht die alte Historie oder private Rezensionsberichte.

Der einzige absichtliche Standardwert des Werksadministrators ist `admin / admin`; Ändern Sie es während der Bereitstellung. Bereitstellungs-/Browsertesttools müssen vorhandene Kontoanmeldeinformationen über eine geschützte lokale Eingabe erhalten. Neu erstellte Smoke-Test-Konten verwenden zufällige Anmeldeinformationen und werden während der Bereinigung deaktiviert. Bei einer fehlgeschlagenen Bereinigung handelt es sich um einen Testfehler, nicht um eine erfolgreiche Ausführung. Ein abrupter Prozessabbruch kann die Bereinigung verhindern; Betreiber müssen nach einer solchen Unterbrechung ihre temporären Konten abgleichen. Kein öffentliches Dokument behauptet, dass ein Testnachweis derzeit gültig sei.

Nur der verwaltete Einstiegspunkt `install/` ist ein sauberer Appliance-Installationspfad. Die Komponenteneigentumsbewertung befindet sich in [OWNERSHIP.md](OWNERSHIP.de.md).

Kein Befehl hier pusht Git, ändert die Sichtbarkeit, schreibt den Verlauf neu, rotiert Live-Anmeldeinformationen, ändert ein Gerät oder gewährt Dritten Weiterverbreitungsrechte. Für die öffentliche Veröffentlichung ist ein explizit gewählter öffentlicher Zielort und eine abschließende Überprüfung des Artefakts erforderlich. Behalten Sie `delivery-2026-10-22` im privaten Repository.
