<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.de.md)
<!-- doc-navigation:end -->

# Mitwirken

Vielen Dank für Ihre Hilfe bei der Verbesserung von Team AI Box. Wir freuen uns über Erstautoren: Fehlerberichte, Übersetzungen, Dokumentation, Barrierefreiheit, Anwendungsintegrationen und gezielte Codeänderungen zählen alle. Sie benötigen kein DGX Spark, um Dokumente oder Komponenten zu verbessern, die unabhängig überprüft werden können.

## Von der Idee zum Pull Request

1. Suchen Sie nach [vorhandenen Problemen](https://github.com/weerocksllc/teamaibox/issues). Beschreiben Sie das Benutzerproblem, das erwartete Verhalten, das tatsächliche Verhalten und die relevante Version. Besprechen Sie größere Änderungen, bevor Sie in eine Implementierung investieren.
2. Forken Sie das öffentliche Repository und klonen Sie Ihren Fork. Erstellen Sie einen fokussierten Zweig. umfassen nicht die private Marketing-Website, Laufzeitdaten oder heruntergeladene Modelle.
3. Folgen Sie [BUILDING](docs/open-source/BUILDING.de.md) für Knoten-, PNPM- und lokale Komponenten-Builds. Das Fresh-Appliance-Installationsprogramm ist ein anderer Arbeitsablauf: Führen Sie es niemals auf einem Computer aus, der Geschäftsdaten enthält, nur um die Benutzeroberfläche zu entwickeln.
4. Nehmen Sie die kleinste zusammenhängende Änderung vor, aktualisieren Sie die betroffene Dokumentation und führen Sie relevante Prüfungen durch. Erläutern Sie alle hardwareabhängigen Prüfungen, die Sie nicht ausführen konnten.
5. Öffnen Sie eine Pull-Anfrage, in der das Problem, die Lösung, die Auswirkungen auf die Kompatibilität und die Prüfungen beschrieben werden. Fügen Sie bereinigte Screenshots für sichtbare Änderungen hinzu. Auf Bewertungsfeedback reagieren; Überprüfung durch den Betreuer vor der Zusammenführung.

Ein lokaler OpenSpec-Arbeitsbereich ist optional und wird nicht in diesem Repository veröffentlicht. Öffentliche Mitwirkende können einen Vorschlag und Akzeptanzkriterien direkt in einer Ausgabe oder PR angeben; Für die Teilnahme sind keine fehlenden privaten Angaben erforderlich.

## Übersetzungen und Screenshots

Bearbeiten Sie für die ausführliche Funktionsliste `docs/readme-features/<locale>.json`; halten Sie Gruppen- und Eintrags-IDs sowie deren Reihenfolge mit der englischen Fassung synchron und pflegen Sie die Quellcodeverweise in `docs/readme-features/evidence.json`.

Für alle 17 Produktsprachen gibt es eine README-Datei. Bearbeiten Sie `docs/readme-locales/<locale>.json` und führen Sie dann `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check` aus. Bearbeiten Sie generierte READMEs nicht manuell. Die Gebietsschemaliste stammt von `packages/ui-system/src/locale-registry.mjs`. Die verknüpften Installations-, Build-, Beitrags-, Sicherheits- und Lizenzierungshandbücher verwenden dieselben 17 Sprachen. Ihre Dokumentenliste befindet sich in `docs/document-locales/manifest.json`. Bearbeiten Sie die Seiten- und Absatzübersetzungen in der Ausgangssprache in `docs/document-locales/<locale>.json` und führen Sie dann `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs` aus. Übersetzungsschlüssel sind SHA-256-Hashes von Quellabsätzen; Bei einer Quelländerung schlägt der Renderer fehl, bis die entsprechenden Übersetzungen aktualisiert sind. Codebeispiele werden wörtlich geteilt und Dokumentlinks werden für die ausgewählte Sprache generiert. Bei neuen Übersetzungen handelt es sich um maschinengestützte Entwürfe mit geschütztem Code und Links; Eine sprachliche und terminologische Überprüfung ist willkommen. Generierung und Prüfungen erfolgen lokal, ohne Übersetzungsdienst, API-Schlüssel oder Zugriff auf eine Appliance. Lesen Sie [die Screenshot-Richtlinie](docs/assets/screenshots/README.de.md), bevor Sie öffentliche Bilder hinzufügen. Übersetzungen, einschließlich Terminologie und natürlicher Phrasierung, sind willkommene Rezensionsbeiträge.

## Beitragsregeln

- Originalbeiträge werden unter der MIT-Lizenz des Repositorys eingereicht. Bewahren Sie Header von Drittanbietern auf und geben Sie die Quelle/Lizenz des kopierten Materials an. Es ist kein separater obligatorischer CLA oder eine Erlaubnis eines bezahlten Mitwirkenden erforderlich.
- Verwenden Sie Knoten 24 und die in `package.json` angeheftete PNPM-Version. Die Anforderungen für Python und Go werden in [BUILDING](docs/open-source/BUILDING.de.md) beschrieben.
- Führen Sie nur Tests durch, die für Ihre Änderung relevant sind, und berichten Sie genau, was ausgeführt wurde. Eine lokale Befestigung ist kein Anspruch auf echte Geräteakzeptanz. Wiederholen oder löschen Sie keine historischen Abnahmeergebnisse, nur um eine Dokumentationsänderung abzuschließen.
- Testen Sie niemals das Löschen, Neuinstallieren oder Wiederherstellen anhand der Daten eines Benutzers. Verwenden Sie synthetische Vorrichtungen oder explizit ausgewiesene temporäre Ressourcen.
- Keine privaten Schlüssel, Token, Cookies, Kundenaufforderungen/-dateien, Bilder von angemeldeten Gästen, private Bereitstellungs-Snapshots oder persönliche Screenshots in Issues/PRs. Siehe [SICHERHEIT](SECURITY.de.md) für private Berichte.
- Behalten Sie `private: true` für Arbeitsbereichspakete bei. Schreiben Sie im Rahmen einer PR niemals den gemeinsamen Git-Verlauf neu, verschieben Sie Bereitstellungs-Tags oder veröffentlichen Sie private Build-Artefakte.

Dokumentieren Sie in Ihrem Beitrag relevante Tests, Migrationen und Verhaltensänderungen. Hardwareabhängige Prüfungen müssen die tatsächliche Konfiguration und Grenzen ermitteln.
