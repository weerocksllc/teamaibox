<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.tr.md)
<!-- doc-navigation:end -->

# Lisans kapsamı ve üçüncü taraf bildirimleri

Telif hakkı © 2026 Weerocks LLC. Kök [MIT lisansı](LICENSE), sahibi tarafından yetkilendirilen orijinal Team AI Box kodunu ve belgelerini kapsar. Üçüncü taraf kodunu, kopyalanan/değiştirilen yukarı akış dosyalarını, bağımlılıkları, modelleri, aygıt yazılımını, işletim sistemlerini, yazı tiplerini veya görüntüleri yeniden lisanslamaz. Mevcut telif hakkı, LİSANS ve BİLDİRİM dosyaları ilgili materyaller için önceliklidir. Paket meta verileri `license: MIT`, dağıtılan görüntüde yer alan her şeyi değil, o paketin orijinal kodunu ifade eder. `private: true`, paket kayıt defterinin yanlışlıkla yayınlanmasını önlemek için tutulur; MIT hibesini iptal etmez.

## Envanter

Makine tarafından okunabilen [bileşen envanteri](docs/open-source/components.json) sürümleri veya sürüm kaynaklarını, lisans kanıtlarını, yeniden dağıtım kapsamını ve çözülmemiş ikili yükümlülükleri kaydeder. [Bağımlılık envanteri](docs/open-source/dependencies.json) kilit dosyasından, yüklü bağımlılık meta verilerinden, Go modüllerinden ve Python gereksinim dosyalarından oluşturulur. Eksik lisans meta verileri açıkça bilinmiyor ve varsayılmıyor MIT. `python3 tools/open_source_inventory.py` ile yeniden oluşturun.

| Bileşen / malzeme | Lisans sınırı | Dağıtım gereksinimleri |
| --- | --- | --- |
| UxPlay alıcısı ve `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Herhangi bir alıcı ikili dosyasıyla GPL'yi, bildirimleri, tam yukarı akış kaynağını, yamaları ve derleme komut dosyalarını saklayın; ikili sürüm için yalnızca yukarı akışa bağlanmak yeterli değildir. |
| gst-eklentileri-rs / `gst-webrtc-*.patch` | MPL-2.0 | Bildirimleri saklayın ve değiştirilmiş kapsam dahilindeki kaynak dosyalarını kullanılabilir hale getirin. |
| GSstreamer | LGPL ve bireysel eklenti lisansları | Gerçek eklenti setini inceleyin ve ilgili yükümlülükleri yerine getirin. |
| LiveKit sunucu/tarayıcı SDK'sı | Apache-2.0 | Telif hakkını, lisansı ve geçerli BİLDİRİMİ saklayın. |
| Mürekkepbalığı / AOSP | Apache-2.0 ve GPL çekirdeği dahil dosya başına lisanslar | Yukarı yöndeki bildirimleri ve ilgili ilgili kaynağı koruyun. AOSP bir Google hizmetleri lisansı içermez. |
| QEMU / Linux / EDK II / virtio sürücüleri | Proje başına ve dosya başına lisanslar | Gerçek ikili yapıyı, bellenimi ve sürücüleri denetleyin; MIT genel etiketini kullanmayın. |
| Guacamole | Apache-2.0 | Bilgisayar eklentisi Dockerfile tarafından kopyalanan LİSANS ve BİLDİRİM'i koruyun. |
| Node / React / Vite ve JS bağımlılık ağacı | Paket başına lisanslar | Paketlenmiş çıktıyı dağıtırken bağımlılık bildirimlerini koruyun. |
| PostgreSQL ve kapsayıcı işletim sistemi paketleri | PostgreSQL / paket başına | Kurulu paket lisans kayıtlarını ikili sürüme dahil edin. |
| PyMuPDF / OCR tarafından kullanılan MuPDF | AGPL-3.0-or-later veya ticari lisans | Birleştirilmiş OCR çalışan dağıtımı/hizmeti kapsamlı değildir MIT; AGPL yükümlülüklerine uymak veya ticari haklar elde etmek. Orijinal kod, MIT iznini koruyabilir. |
| Qwen / LMT / Whisper / FLUX model varlıkları | Tam modelin şartları | Modeller, MIT kaynak hibesinden ayrıdır. FLUX **4B** terimleri başka bir FLUX modelinin yerine kullanılmamalıdır. |
| HunyuanOCR ağırlıkları | Tencent Hunyuan Topluluk Lisansı | Koşullu model lisansı; her sürüm için alıcıyı, bölgeyi, kullanım, atıf ve yeniden dağıtım koşullarını inceleyin. |
| NVIDIA yazılım | NVIDIA ve üçüncü taraf şartlarını içeriyordu | Mevcut ana makine Docker/NVIDIA kurulumu bu kaynak paket tarafından yeniden dağıtılmıyor. Paketlenmiş CUDA/konteyner kitaplıklarının hâlâ kendi incelemelerine ihtiyacı var. |
| Google Mobil Hizmetleri / Play Store | Tescilli | Kamu kaynağı adayının parçası değil. Çalışma zamanı entegrasyon kodu, GMS görüntülerini dağıtma haklarını vermez. |
| Windows kurulum ortamı, konuk diskler, hesaplar | Kapsam dışı | Kullanıcılar yetkili ISO ortamını ve lisanslarını sağlar. Test VM disklerini veya oturum açmış konuk durumunu asla göndermeyin. |
| Kullanımdan kaldırılan ViKey SDK'sı | Tescilli / kamu hibesi yok | SDK çalışma kaynağından kaldırıldı; özel geçmiş kayıtlar ve tutulan SDK kopyaları yayınlanmamalıdır. USB anahtarına gerek yoktur. |

Kesin yayın bildirimleri [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt) dosyasında kalır. ADB aktarım bildirimleri telefon istemcisinin yanında kalır. Küçültme veya paketleme sırasında bunları çıkarmayın. Konteyner izolasyonu tek başına telif hakkı yükümlülüklerini iptal etmez. Dağıtım analizi gerçek birleştirilmiş yapıya bağlıdır.

## Marka ve katkıda bulunanlar

MIT, ticari marka hakları veya onayı değil, telif hakkı izni verir. Team AI Box ve Weerocks adları/logoları, değiştirilmiş bir ürün için resmi destek anlamına gelmemelidir. NVIDIA, DGX Spark, Android, Google Play, Windows ve Apple/AirPlay ilgili sahiplerine aittir. Uyumluluk sertifikasyon değildir.

Yerel yazar meta verileri bir envanterdir, telif hakkı devrinin kanıtı değildir. İncelenen sahiplik kategorileri [OWNERSHIP.md](docs/open-source/OWNERSHIP.tr.md) dosyasına kaydedilir. Proje sahibinin izni orijinal katkıları için geçerlidir; Katkıda bulunanlar yalnızca lisans almaya hak kazandıkları çalışmaları sunmalıdır. Eksik olduğundan şüphelenilen atıf: Teamaibox@weerocks.llc.
