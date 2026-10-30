<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.tr.md)
<!-- doc-navigation:end -->

# Kamu kaynağı gizlilik sınırı

Kamuya açık ürün deposu, özel geliştirme geçmişinin bir aynası değil, yeni bir kaynak anlık görüntüsüdür. Pazarlama web sitesinin kendi özel deposu vardır ve buraya dahil edilmemiştir.

## Kaldırılan materyal

- Dağıtım testi hesap adları ve parolaları ile kişisel hesap listeleri düzeltildi.
- Geçmiş cihaz kimliklerini kaydeden veya özel kanıtlardan elde edilen sonuçları ileri süren tek cihazlı dağıtım/kurtarma paketleyicileri ve komut dosyaları.
- Gerçek ana bilgisayar adresleri, ana dizinler, kapsayıcı/cihaz kimlikleri ve geçmiş bakım anlık görüntüleri. Tutulan testler açıkça sentetik fikstürler kullanır; bakımı yapılan operasyonel araçlar açık hedef girdileri gerektirir.
- Konuk diskler, Android oturum açma durumu, tarayıcı oturumları, kurulum paketleri, model ağırlıkları ve özel kanıtlar genel kaynak dağıtımının dışındadır.

Özel arşiv ve orijinal teslimat etiketleri bozulmadan kalır. Bu kaynak temizleme işlemindeki hiçbir şey cihaz hesaplarını, konuk verilerini, çalışan hizmetleri veya web sitesi dağıtımını değiştirmez. `admin / admin` fabrika varsayılanı bilinçli olarak korunur; bu özel bir kimlik bilgisi değildir. Yöneticilerin kullanıma sunulmadan önce bunu değiştirmesi gerekir.

## İnceleme ve doğrulama

Hem çalışma ağacını hem de yayınlanmakta olan depodaki ulaşılabilir tüm taahhütleri/etiketleri inceleyin. Gitleaks artı `tools/open_source_sensitive.py` kullanın; hiçbiri tek başına düşük entropili şifrelerin veya kişisel meta verilerin bulunmadığının kanıtı değildir. Onaylanmış eski özel değerleri özel bir harici red listesi kullanarak karşılaştırın; asla taahhütlü bir test fikstürü kullanmayın. Test dosyaları da dahil olmak üzere kalan bulguları ayrı ayrı inceleyin.

Temizleme kontrolleri kaynak politikası, sentetik regresyon, yapılandırma ve sözdizimi kontrolleridir. Keşfedilen kimlik bilgilerini kullanarak oturum açmazlar, bir kutuyu yeniden yüklemezler veya ürün kabulünü tekrarlamazlar. Önceki API paketleme düzeltmesi (paylaşılan kullanıcı arayüzü kaynağı ve yalnızca içe aktarma giriş noktası kontrolü dahil) kaynakta kalır.

Yeni klonlar kullanımdan kaldırılan taahhütleri, referansları veya etiketleri içe aktarmamalıdır. Bir havuzun silinmesi, başkaları tarafından zaten indirilmiş olan kopyaların geri çağrılmasına neden olmaz. Hiçbir tarama, bilinmeyen bir kimlik bilgisinin hiçbir zaman kopyalanmadığını belirleyemez; gerçekte kullanılan bir kimlik bilgisinin operatörü tarafından döndürülmesi gerekir. Bu temizleme işlemi onu döndürdüğünü iddia etmiyor.

Kaynak dışa aktarma ve inceleme talimatları için [RELEASING.md](RELEASING.tr.md) adresine ve derleme önkoşulları ve ayrı olarak elde edilen varlıklar için [BUILDING.md](BUILDING.tr.md) adresine bakın.
