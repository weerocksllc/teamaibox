<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.tr.md)
<!-- doc-navigation:end -->

# Team AI Box çevrimdışı kurulum paketi

Orijinal kodun lisansı paketteki `LICENSE` içindedir. Üçüncü taraf bileşenler orijinal lisanslarını korur; bkz. `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT, Google hizmetleri, Windows, model ağırlıkları veya üçüncü taraf markalar için hiçbir ek yeniden dağıtım hakkı vermez. Paket bütünlüğü kontrollerinden geçmek, her bileşen için yeniden dağıtım izni sağlamaz.

Bu paket, uyumlu bir fabrika Linux sistemini koruyan yeni bir DGX Spark içindir. Mevcut Docker, Compose ve NVIDIA GPU ortamını değiştirmeden veya sistem diskini biçimlendirmeden kullanır.

## Kurulum

Birlikte verilen `.sha256` dosyasını kullanarak arşivi doğrulayın ve ardından arşivi çıkarın:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Normal kurulum, ne genel internet erişimine ne de manuel ortam değişkeni düzenlemelerine ihtiyaç duyar. Kurulumcu gerekli paket araçları sağlar, bağımsız yerel konfigürasyon oluşturur, yeni bir veritabanını başlatır ve hizmetleri başlatır. İlk modelin yüklenmesi zaman alabilir; yükleme göstergesi başarılı kurulumun onayı değildir.

Kurulum yapmadan ortamı ve paketi kontrol etmek için `sudo ./install.sh --check` komutunu çalıştırın. `./install.sh --verify-package` yalnızca paket içeriğini kontrol eder ve paketleme iş istasyonunda da çalışabilir. Yeni bir kurulum kökü belirtmek için `--installation-root /dedicated/path/installation` kullanın; asla mevcut verilere doğrultmayın.

## Kesintiler ve mevcut veriler

Bir arıza veya kesinti sonrasında bildirilen sorunu çözün ve orijinal komutu tekrarlayın. Kurulum dizinini silmeyin. Yükleyici, oluşturduğu kimliği ve verileri korur. Aynı sürüm kurulumunun tamamını yeniden çalıştırmak yalnızca durumunu kontrol eder. Diğer sürümler, silme ve yeniden yükleme yerine resmi yükseltme yolunu kullanır. Üzerine zorla yazma seçeneği yoktur.

## İlk kullanım

Cihazın mevcut IP'sindeki HTTPS adresini açın ve oturum açın:

- Yönetici kullanıcı adı: `admin`
- Başlangıç şifresi: `admin`

Yükleyici bu yöneticiyi otomatik olarak oluşturur; kurulum jetonunun çıkarılmasına veya manuel kayıt yapılmasına gerek yoktur. Başlangıç ​​şifresi herkese açık ve basittir: teslimattan/kullanmadan önce kullanıcı yönetiminde değiştirin. Sıradan kullanıcıların varsayılan hesapları yoktur ve yönetici tarafından oluşturulurlar. Bu yalnızca boş bir hesap veritabanı için geçerlidir; devam ettirin, yeniden çalıştırın, yeniden başlatın ve yükseltin, mevcut hesapları veya şifreleri hiçbir zaman varsayılan ayarlara sıfırlamayın. Bağımsız olarak oluşturulan yönetici kurtarma kodu, `secrets/initial-owner-recovery.json` adresindeki kurulum kökü altında depolanır ve yalnızca kök tarafından okunabilir. Kurtarma kodlarını asla sohbetlere, destek taleplerine veya genel günlüklere göndermeyin. Mevcut kurulumlar kurtarma kodları oluşturmaz veya değiştirmez. Yerel olarak verilen HTTPS sertifikası için tarayıcı güvenini yöneticinin CA talimatlarına göre yapılandırın. Sertifikadaki ad, LAN DNS/mDNS çözümlemesini garanti etmez. Yerel CA genel sertifikası normalde `/srv/teamaibox/installation/https/ca.crt` konumundadır. Yalnızca bu genel sertifikayı dağıtın, asla yanındaki özel anahtarı dağıtmayın.

Kurulum mevcut sanal makineleri, Google oturum açma durumunu veya kullanıcı dosyalarını içermez. Kullanıcılar Windows/Linux ISO'larını yükler veya bunları ekip sürücüsünden seçer ve ardından konuk sistemleri kendileri yükler. Google Play ve harici API'ler internet erişimi gerektirir ve çevrimdışı kullanılabilirlik sözüne dahil değildir.

Bileşen lisans metinleri yayın kaynaklarıyla birlikte saklanır. Telif hakkı © Weerocks LLC. İletişim: Teamaibox@weerocks.llc.
