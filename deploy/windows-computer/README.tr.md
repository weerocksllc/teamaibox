<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.tr.md)
<!-- doc-navigation:end -->

# ARM sanal bilgisayar çalışma zamanı

`Public.Dockerfile`, orijinal `windows-arm64-ppi` çalışma zamanının gerektirdiği aynı ARM TPM fiziksel varlık (PPI) özelliğini oluşturur. Sabitlenmiş sürüm yöneticisi parmak izine göre bağımsız imzasını doğruladıktan sonra resmi sürümden QEMU 11.1.1'i oluşturur. Debian, konukları çalıştırmak için kullanılan QEMU yürütülebilir dosyasını değil, konteyner kitaplıklarını ve araçlarını sağlar.

Bu yürütülebilir dosyayı eski bir dağıtım QEMU paketiyle değiştirmeyin. Windows profilleri `tpm-tis-device,...,ppi=on`'yi etkinleştirir; bu ARM özelliğine sahip olmayan bir yapı, ürün yazılımı başlamadan önce çıkar. `ppi=on`'yi kaldırmak, TPM'yi devre dışı bırakmak veya misafirin TPM'sini sıfırlamak uyumlu bir onarım değildir.

Nihai görüntü yapısı, ARM TIS PPI ve PulseAudio desteğini kontrol eder ve eşleşen RAM çerçeve tamponu ROM'unu içerir. Bir ARM KVM ana bilgisayarında, paket halindeki `python3 /usr/local/bin/probe-ppi` disksiz, duraklatılmış bir QEMU/TPM kontrolü gerçekleştirir. Mevcut konuk diskleri bağlamaz veya Windows kurulumunun tamamlandığını kanıtlamaz. Windows önyüklemesinin açıkça belirlenmiş bir test konuğu üzerinde ayrı olarak kontrol edilmesi gerekir.

Mevcut bir kurulum için platformun çalışma zamanı güncelleme politikasını ve eşleşen Node Agent profil görüntüsü özetini kullanın. Diski, ürün yazılımını, TPM kimliğini ve durumunu koruyun. Yalnızca Windows çalışma zamanını onarmak için konukları yeniden oluşturmayın veya çalışan Linux konuk görüntülerini değiştirmeyin. Yerel olarak oluşturulmuş görüntüleri, kaynak değişiklikleri uygulanıp yayınlanıncaya kadar yayınlanmamış olarak kaydedin.

Güncellerken yüklü konfigürasyonun sahipliğini ve okuma izinlerini koruyun. Platform API'si, çalışma zamanı güncelleme politikasını yüklemek için yeniden oluşturulursa, ağ ad alanı bağımlılarını da (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` ve `maintenance-controller`) değiştirilmemiş görüntülerinden yeniden oluşturun. Yeni API kapsayıcısının ağ ad alanına katılmaları gerekir. Bu bir konuk, Docker arka plan programı veya AI çalışanının yeniden başlatılması değildir. Bir Windows başlatma işlemi göndermeden önce, düğümün normal kimlik doğrulamalı kalp atışının hazır duruma gelmesini bekleyin.
