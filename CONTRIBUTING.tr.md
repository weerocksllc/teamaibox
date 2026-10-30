<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.tr.md)
<!-- doc-navigation:end -->

# Katkıda Bulunmak

Team AI Box'nin iyileştirilmesine yardımcı olduğunuz için teşekkür ederiz. İlk kez katkıda bulunanları memnuniyetle karşılıyoruz: hata raporları, çeviriler, belgeler, erişilebilirlik, uygulama entegrasyonları ve odaklanmış kod değişikliklerinin tümü önemlidir. Bağımsız olarak kontrol edilebilecek belgeleri veya bileşenleri geliştirmek için bir DGX Spark'ye ihtiyacınız yoktur.

## Bir fikirden çekme isteğine

1. [Mevcut sorunları](https://github.com/weerocksllc/teamaibox/issues) arayın. Kullanıcı problemini, beklenen davranışı, gerçek davranışı ve ilgili sürümü açıklayın. Bir uygulamaya yatırım yapmadan önce daha büyük değişiklikleri tartışın.
2. Genel depoyu çatallayın ve çatalınızı klonlayın. Odaklanmış bir şube oluşturun; özel pazarlama web sitesini, çalışma zamanı verilerini veya indirilen modelleri içermez.
3. Düğüm, pnpm ve yerel bileşen yapıları için [BUILDING](docs/open-source/BUILDING.tr.md) adresini takip edin. Yeni cihaz yükleyicisi farklı bir iş akışıdır: asla yalnızca kullanıcı arayüzünü geliştirmek için iş verilerini içeren bir makinede çalıştırmayın.
4. En küçük tutarlı değişikliği yapın, etkilenen belgeleri güncelleyin ve ilgili kontrolleri çalıştırın. Çalıştıramadığınız donanıma bağlı kontrolleri açıklayın.
5. Sorunu, çözümü, uyumluluğun etkisini ve kontrolleri açıklayan bir çekme isteği açın. Görünür değişiklikler için arındırılmış ekran görüntüleri ekleyin. İnceleme geri bildirimine yanıt verin; bakımcılar birleşmeden önce gözden geçirir.

Yerel OpenSpec çalışma alanı isteğe bağlıdır ve bu depoda yayınlanmaz. Kamu katkıda bulunanlar bir sayıya veya PR'ye doğrudan teklif ve kabul kriterleri koyabilir; Katılmak için herhangi bir özel spesifikasyonun eksik olması gerekmemektedir.

## Çeviriler ve ekran görüntüleri

17 ürün dilinin tamamında bir BENİOKU dosyası bulunur. `docs/readme-locales/<locale>.json`'yi düzenleyin, ardından `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`'yi çalıştırın. Oluşturulan README'leri elle düzenlemeyin. Yerel ayar listesi `packages/ui-system/src/locale-registry.mjs` adresinden gelir. Bağlantılı kurulum, derleme, katkı, güvenlik ve lisanslama kılavuzları aynı 17 dili kullanır. Belge listeleri `docs/document-locales/manifest.json` içindedir. Kaynak dil sayfasını ve paragraf çevirilerini `docs/document-locales/<locale>.json` içinde düzenleyin, ardından `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs` komutunu çalıştırın. Çeviri anahtarları kaynak paragrafların SHA-256 karmalarıdır; kaynak değişikliği, karşılık gelen çeviriler güncellenene kadar oluşturucunun başarısız olmasına neden olur. Kod örnekleri aynen paylaşılır ve seçilen dil için belge bağlantıları oluşturulur. Yeni çeviriler, korumalı kod ve bağlantılara sahip, makine destekli taslaklardır; Dil ve terminoloji incelemesi memnuniyetle karşılanır. Oluşturma ve kontroller, çeviri hizmeti, API anahtarı veya bir araca erişim olmadan yerel olarak gerçekleştirilir. Herkese açık görseller eklemeden önce [ekran görüntüsü politikasına](docs/assets/screenshots/README.tr.md) bakın. Terminoloji ve doğal ifadeler de dahil olmak üzere çeviriler, inceleme katkılarından memnuniyetle karşılanır.

## Katkı kuralları

- Özgün katkılar deponun MIT lisansı altında sunulur. Üçüncü taraf telif ve lisans başlıklarını koruyun; kopyalanan içeriğin kaynağını ve lisansını belirtin. Ayrı bir zorunlu CLA veya ücretli katkı izni gerekmez.
- Node 24 ve `package.json` dosyasında sabitlenen pnpm sürümünü kullanın. Python ve Go gereksinimleri [BUILDING](docs/open-source/BUILDING.tr.md) belgesinde açıklanır.
- Yalnızca değişikliğinizle ilgili testleri çalıştırın ve nelerin çalıştırıldığını açıkça raporlayın. Yerel test verileri gerçek cihaz kabulünün kanıtı değildir. Sırf bir belge değişikliğini kapatmak için geçmiş kabul sonuçlarını tekrarlamayın veya silmeyin.
- Silme, yeniden kurulum veya kurtarma testlerini asla kullanıcı verileri üzerinde yapmayın. Sentetik test verilerini veya açıkça belirlenmiş geçici kaynakları kullanın.
- Issue veya PR içine özel anahtar, token, çerez, müşteri istemi/dosyası, oturum açılmış konuk imajı, özel dağıtım anlık görüntüsü veya kişisel ekran görüntüsü koymayın. Özel bildirim için [SECURITY](SECURITY.tr.md) belgesine bakın.
- Çalışma alanı paketlerinde `private: true` ayarını koruyun. Bir PR kapsamında ortak Git geçmişini yeniden yazmayın, teslimat etiketlerini taşımayın veya özel derleme çıktıları yayımlamayın.

Katkınızdaki ilgili testleri, geçişleri ve davranış değişikliklerini belgeleyin. Donanıma bağlı kontroller gerçek konfigürasyonu ve limitleri tanımlamalıdır.
