<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.de.md)
<!-- doc-navigation:end -->

# ARM-Laufzeit für virtuelle Computer

`Public.Dockerfile` erstellt die gleiche ARM TPM Physical-Presence-Funktion (PPI), die von der ursprünglichen `windows-arm64-ppi`-Laufzeit benötigt wird. Es erstellt QEMU 11.1.1 aus der offiziellen Version, nachdem die abgetrennte Signatur anhand des angehefteten Release-Manager-Fingerabdrucks überprüft wurde. Debian stellt die Containerbibliotheken und Tools bereit, nicht die ausführbare QEMU-Datei, die zum Ausführen von Gästen verwendet wird.

Ersetzen Sie diese ausführbare Datei nicht durch ein älteres QEMU-Distributionspaket. Windows-Profile aktivieren `tpm-tis-device,...,ppi=on`; Ein Build ohne diese ARM-Eigenschaft wird beendet, bevor die Firmware gestartet wird. Das Entfernen von `ppi=on`, das Deaktivieren von TPM oder das Zurücksetzen des TPM eines Gastes ist keine kompatible Reparatur.

Der endgültige Image-Build überprüft die ARM TIS PPI- und PulseAudio-Unterstützung und enthält das passende RAM-Framebuffer-ROM. Auf einem ARM-KVM-Host führt das gebündelte `python3 /usr/local/bin/probe-ppi` eine festplattenlose, pausierte QEMU/TPM-Prüfung durch. Es werden keine vorhandenen Gastfestplatten gemountet und es wird nicht nachgewiesen, dass die Windows-Installation abgeschlossen ist. Der Windows-Start muss separat auf einem explizit festgelegten Testgast überprüft werden.

Verwenden Sie für eine vorhandene Installation die Laufzeitaktualisierungsrichtlinie der Plattform und den passenden Node Agent-Profil-Image-Digest. Behalten Sie Festplatte, Firmware, TPM-Identität und -Status bei. Erstellen Sie keine Gäste neu und ändern Sie keine laufenden Linux-Gast-Images, nur um die Windows-Laufzeit zu reparieren. Zeichnen Sie lokal erstellte Images als unveröffentlicht auf, bis ihre Quelländerungen festgeschrieben und freigegeben werden.

Behalten Sie den Besitz und die Leseberechtigungen der installierten Konfiguration bei, wenn Sie diese aktualisieren. Wenn die Plattform-API neu erstellt wird, um die Laufzeitaktualisierungsrichtlinie zu laden, erstellen Sie auch ihre Netzwerk-Namespace-Abhängigkeiten (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` und `maintenance-controller`) aus ihren unveränderten Bildern neu. Sie müssen dem Netzwerk-Namespace des neuen API-Containers beitreten. Dies ist kein Gast-, Docker-Daemon- oder AI-Worker-Neustart. Warten Sie, bis der normale authentifizierte Heartbeat des Knotens die Bereitschaft wiederhergestellt hat, bevor Sie einen Windows-Startvorgang senden.
