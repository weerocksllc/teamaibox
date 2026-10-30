<!-- Generated from docs/readme-locales/tr.json by tools/render-readmes.mjs. -->
# Team AI Box

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.tr.md) · [简体中文](README.tr.md) · [繁體中文](README.tr.md) · [日本語](README.tr.md) · [한국어](README.tr.md) · [Français](README.tr.md) · [Deutsch](README.tr.md) · [Español](README.tr.md) · [Português](README.tr.md) · [Русский](README.tr.md) · [العربية](README.tr.md) · [हिन्दी](README.tr.md) · [Bahasa Indonesia](README.tr.md) · [Italiano](README.tr.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.tr.md) · [ไทย](README.tr.md)

**Sizin DGX Spark'ınız, ekibinizin yapay zekâ çalışma alanı.** Team AI Box; yerel yapay zekâ, dosyalar, iletişim ve sanal cihazları tek NVIDIA DGX Spark üzerinde birleştirir. Her bilgisayara ayrı yapay zekâ ortamı kurmadan tarayıcıdan çalışın.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

## Neden Team AI Box?

- **Birleşik alan:** yapay zekâ, iş birliği ve cihazlar için tutarlı arayüz ve hesaplar.
- **Önce yerel:** Spark üzerinde çıkarım, isteğe bağlı dış model API'leri; USB anahtarı gerekmez.
- **DGX Spark için:** Ubuntu ARM64, NVIDIA GPU konteynerleri ve KVM; geliştirici makinesine bağlı değildir.
- **Katkıya açık:** özgün kod MIT, 17 dil, açık/koyu tema ve kaydedilen elle seçimler. Varsayılan dil İngilizcedir.

## Gerçek çalışma alanı

Türkçe gerçek ürün görüntüsüdür, tasarım maketi değildir. GitHub temasına uyar; iki aslı aşağıdadır. Müşteri dosyası veya kimlik bilgisi içermez. Model çıktıları, konuk sistemler ve özel adların dil ayarları ayrıdır.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/tr/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/tr/workbench-light.jpg">
  <img src="docs/assets/screenshots/tr/workbench-light.jpg" alt="Gerçek çalışma alanı — Türkçe" width="1280">
</picture>

[Açık tema](docs/assets/screenshots/tr/workbench-light.jpg) · [Koyu tema](docs/assets/screenshots/tr/workbench-dark.jpg)

## Yapabilecekleriniz

### Yapay zekâ asistanı

Sorular sorun, metin yazıp düzenleyin, bilgi özetleyin ve belgelerle sohbet üzerinden çalışın. Yerel modeller esastır; dış sağlayıcılar isteğe bağlıdır.

### Görsel üretimi

İstemlerle görsel üretin, düzenleyin, sonuçları kaydedin ve görev ilerlemesini izleyin.

### Metin tanıma

Görsel ve belgelerden metin ve düzen çıkarın, inceleyip yeniden kullanın.

### Konuşma dökümü

Ses ve videoyu zaman damgalı metne dönüştürerek toplantı notları ve altyazılar hazırlayın.

### Çeviri

Metin ve desteklenen dosyaları çevirin. Diller kurulu modele bağlıdır; arayüz dili listesiyle aynı değildir.

### Mesajlaşma

Takım dosyalarının yanında bire bir veya grup sohbetleri yapın. Görünür kontrollerle mesajları yönetin ve sohbetleri silin.

### Takım sürücüsü

Dosyaları yükleyin, düzenleyin, paylaşın ve uyumlu uygulamalarda doğrudan yeniden kullanın.

### Kablosuz ekran paylaşımı

Uyumlu Apple cihazlarının görüntü ve sesini tarayıcıda iş arkadaşlarınızla izleyin. Alıcı keşfi uygun LAN bağlantısı gerektirir.

### Sanal Android telefonlar

Uygulama yükleyin ve tarayıcıdan her telefonun kalıcı durumuna dönün. Cihazların verileri ayrıdır; Google hizmetlerinin kendi uyumluluk ve lisans koşulları vardır.

### Sanal Windows ve Linux bilgisayarlar

İzinli ARM64 ISO yükleyin veya takım sürücüsünden seçin; sanal optik sürücüye bağlayarak sanal ekrandan kendiniz kurun. Açılış, yeniden başlatma, ses, izleyici/denetleyici daveti, kontrol aktarımı ve ortak kontrol desteklenir; sahibi kontrolü geri alabilir. Uzak masaüstü ek bir moddur.

### Yönetim ve görevler

Hesap ve erişimleri yönetin, uygulama hazırlığını ve görev ilerlemesini görün. Her uygulama kendi bağımlılıkları hazır olunca açılır; ilk model açılışı zaman alabilir.

<a id="install"></a>

## Yeni DGX Spark üzerine kurulum

**Ubuntu 24.04 ARM64 çalıştıran temiz DGX Spark**, çalışan Docker Engine/Compose v2, NVIDIA sürücüsü ve konteyner desteği, KVM, Git ve Python 3.10+ gerekir. Model, derleme ve paket için birkaç yüz GB geçici alan ayırın. Mevcut iş verileri üzerine yeni kurulum yapmayın.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Komutları **Spark üzerinde** çalıştırın. Betik modelleri ve girdileri indirir, imajları derler, tam çevrimdışı paket oluşturur ve kurar. İlk derleme internet ve zaman gerektirir; clone tek başına kurulum değildir. Docker/NVIDIA yeniden kullanılır; geliştirici hesapları, diskleri veya sırları kopyalanmaz.

### Ön kontrol ve devam

`--check` gereksinimleri denetler. Kesinti olursa `/var/tmp/teamaibox-source-build` dizinini koruyup **aynı komutu** çalıştırın; doğrulanan indirmeler ve aşamalar yeniden kullanılır. Önbelleği silmeyin, eşzamanlı rakip derlemeler başlatmayın. Varsayılan resmî kaynaklardır. Ulaşılamıyorsa [kılavuzdaki](install/SOURCE-INSTALL.tr.md) seçenekleri veya doğrulanmış önbellek/tam paket aktarımını kullanın; aynaların erişilebilirliği garanti edilmez. Değişen kod için yeni `--work-dir` gerekir; kontrolleri atlamayın.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Kurulumdan sonra

1. Güncel LAN adresiyle `https://<BOX_LAN_IP>/` açın ve yerel HTTPS sertifikasının cihazınıza ait olduğunu doğrulayın.
2. `admin` / `admin` ile girin, **ilk parolayı değiştirin**, normal hesapları oluşturun. Varsayılan bilgileri internete açmayın.
3. Uygulamaların hazır olmasını bekleyip profilden dil/tema seçin. Durum: `/srv/teamaibox/installation/readiness.json`.
4. İzinli Windows/Linux ARM64 ISO ve lisanslarını kendiniz sağlayın. Çevrimdışı hedef için önce tam paketi hazırlayıp [kılavuzu](install/README.tr.md) izleyin; kaynak hazırlığı çevrimiçidir.

## Lisans ve sınırlar

Özgün kod ve belgeler MIT'dir, **kurulan tüm ikililer değil**. Üçüncü taraflar, modeller, NVIDIA, firmware, Google ve Windows kendi koşullarını korur. Git; ağırlık, kurulu konuk diski, giriş oturumu, ISO veya paket içermez. Google uyumluluğu Play Protect sertifikası değildir; yayın DRM veya Apple sertifikası içermez. Windows 10 ARM64 desteği iddia edilmez. Performans ve eşzamanlılık yük ve donanıma bağlıdır. Pazarlama sitesi ayrı ve özeldir; ürün arayüzü açıktır.

## Birlikte geliştirelim

Hata raporu, belge, çeviri, erişilebilirlik, entegrasyon ve kod katkıları bekliyoruz. Issue ile kullanıcı sorununu anlatın, fork ve odaklı dal oluşturup ilgili kontrol ve görsellerle PR gönderin. Belgeler veya bağımsız bileşenler için Spark gerekmez; donanım doğrulamasını dürüstçe belirtin. Sırları, kişisel dosyaları ve giriş yapılmış imajları yüklemeyin. Açıkları SECURITY.md uyarınca özel bildirin. Zorunlu CLA veya ücretli katkı izni yoktur.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.tr.md) · [SECURITY](SECURITY.tr.md)

## Ayrıntılı kaynaklar

- [Kaynak kurulumu ve kurtarma](install/SOURCE-INSTALL.tr.md)
- [Çevrimdışı paket](install/README.tr.md)
- [Geliştirme ve derleme](docs/open-source/BUILDING.tr.md)
- [Katkı süreci](CONTRIBUTING.tr.md)
- [Özel güvenlik bildirimi](SECURITY.tr.md)
- [Üçüncü taraf lisansları ve dağıtım kapsamı](THIRD_PARTY_NOTICES.tr.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Üçüncü taraf lisansları ve dağıtım kapsamı](docs/open-source/RELEASING.tr.md)
