<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.de.md)
<!-- doc-navigation:end -->

# Datenschutzgrenze für öffentliche Quellen

Das öffentliche Produkt-Repository ist ein neuer Quell-Snapshot und kein Spiegel der privaten Entwicklungsgeschichte. Die Marketing-Website verfügt über ein eigenes privates Repository und ist hier nicht enthalten.

## Material entfernt

- Die Namen und Passwörter für Bereitstellungstestkonten sowie die Listen persönlicher Konten wurden korrigiert.
- Bereitstellungs-/Wiederherstellungs-Wrapper und Skripte für ein Gerät, die historische Geräteidentitäten aufzeichneten oder Ergebnisse aus privaten Beweisen bestätigten.
- Tatsächliche Hostadressen, Home-Verzeichnisse, Container-/Geräteidentitäten und historische Wartungs-Snapshots. Bei beibehaltenen Tests werden explizit synthetische Vorrichtungen verwendet. Gepflegte Betriebsmittel erfordern explizite Zieleingaben.
- Gastfestplatten, Android-Anmeldestatus, Browsersitzungen, Installationspakete, Modellgewichte und private Beweise liegen außerhalb der öffentlichen Quellverteilung.

Das private Archiv und die ursprünglichen Lieferetiketten bleiben erhalten. Bei dieser Quellbereinigung ändert sich nichts an Appliance-Konten, Gastdaten, laufenden Diensten oder der Website-Bereitstellung. Die Werkseinstellung `admin / admin` wird bewusst beibehalten; es handelt sich nicht um einen privaten Ausweis. Administratoren müssen es vor der Veröffentlichung ändern.

## Überprüfung und Verifizierung

Überprüfen Sie sowohl den Arbeitsbaum als auch jedes erreichbare Commit/Tag im zu veröffentlichenden Repository. Verwenden Sie Gitleaks plus `tools/open_source_sensitive.py`; Beides allein ist kein Beweis dafür, dass Passwörter mit niedriger Entropie oder persönliche Metadaten fehlen. Vergleichen Sie bestätigte alte private Werte mit einer privaten externen Denylist, niemals mit einem festgeschriebenen Testgerät. Überprüfen Sie die verbleibenden Ergebnisse einzeln, einschließlich der Testdateien.

Bei den Bereinigungsprüfungen handelt es sich um Quellrichtlinien-, synthetische Regressions-, Konfigurations- und Syntaxprüfungen. Sie melden sich nicht mit den erkannten Anmeldeinformationen an, installieren eine Box nicht neu und wiederholen die Produktabnahme nicht. Die frühere API-Paketierungskorrektur (einschließlich der gemeinsam genutzten UI-Quelle und der Nur-Import-Einstiegspunktprüfung) bleibt in der Quelle.

Neue Klone dürfen keine veralteten Commits, Refs oder Tags importieren. Durch das Löschen eines Repositorys werden Kopien, die bereits von anderen heruntergeladen wurden, nicht zurückgerufen. Kein Scan kann feststellen, dass ein unbekannter Berechtigungsnachweis nie kopiert wurde; Ein tatsächlich genutzter Ausweis muss von seinem Betreiber rotiert werden. Diese Bereinigung erhebt nicht den Anspruch, sie gedreht zu haben.

Siehe [RELEASING.md](RELEASING.de.md) für Quellenexport- und Überprüfungsanweisungen und [BUILDING.md](BUILDING.de.md) für Build-Voraussetzungen und separat erworbene Assets.
