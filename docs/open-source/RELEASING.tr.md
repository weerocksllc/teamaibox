<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.tr.md)
<!-- doc-navigation:end -->

# Sınırları serbest bırakın

## Ayrı eserler

1. **MIT kaynak adayı**: orijinal kod, mevcut spesifikasyonlar, incelenen derleme/test araçları ve bildirimler; Git geçmişi veya özel laboratuvar kanıtı yok.
2. **Üçüncü taraf materyal**: kendi lisansları ve atıfları olan tam yukarı akış kaynağı/ikili dosyalar/modeller. Copyleft kaynak yükümlülükleri ikili dosyalarla birlikte hareket eder.
3. **Tam çevrimdışı cihaz paketi**: `install/` tarafından oluşturulmuştur; kamuya yeniden dağıtım için otomatik olarak lisanslanmaz. GMS, HunyuanOCR, NVIDIA bileşenleri ve konuk/ürün yazılımı lisansları yapıya özel inceleme gerektirir. Özel paketi, model paketlerini veya oturum açılmış görselleri MIT etiketi altında yayınlamayın.
4. **Pazarlama web sitesi**: `website/`, makale şablonları, içeriği, tasarım varlıkları, analizleri ve dağıtım yapılandırması dahil olmak üzere özel `weerocksllc/teamaibox.com` GitHub deposunda kalır. GitLab, web sitesi geliştirme deposu değil, tarihi bir arşivdir. Web sitesi halka açık ürün kaynağı dağıtımının bir parçası değildir. `apps/` içindeki cihaz tarayıcısı kullanıcı arayüzü, açık kaynaklı ürünün bir parçası olmaya devam ediyor.

Geçmişteki tek cihazlı dağıtım, kurtarma ve kanıt kaydetme komut dosyaları, yeniden kullanılabilen ürün araçları değildir. Sürüm politikası, kullanımdan kaldırılan komut dosyalarını ve anlık görüntüleri hariç tutar; bunları özel arşivden geri yüklemeyin. Tutulan araçlar, geliştiricinin ana bilgisayarları, hesapları, kapsayıcıları veya kanıt dosyaları yerine operatörün açıkça sağladığı hedefleri gerektirir. Ek hassas taramayı Gitleaks'in yanı sıra çalıştırın: cihaz kimlikleri, konteyner kimlikleri, GSF karmaları ve kişisel hesap adları, kullanılabilir oturum açma kimlik bilgileri olmasalar bile meta verileri test ediyor. Genel geçmişi temizleme işlemi, açık bir şekilde sahibinin yetkilendirilmesini gerektirir ve özel arşivi veya dağıtım etiketlerini asla yeniden yazmamalıdır. Yetkilendirilmiş bir yeniden yazma işleminden sonra, kullanımdan kaldırılan geçmişi tekrar korunan depoya birleştirmek yerine yeni bir genel klon kullanın.

Dahili geliştirme deposu ve etiketleri bozulmadan kalır. Erişilebilir geçmişi, eski dağıtım kayıtlarını ve kullanımdan kaldırılan özel SDK varlıklarını içerir; değiştirilmeden kamuya açıklanmamalıdır. Dışa aktarılan yeni bir ağaç, orijinal teslimat geçmişini sessizce yeniden yazmaya gerek kalmadan halka açık bir başlangıç ​​noktası sağlar.

## Yerel hazırlık

Resmi GitHub sürümünden indirilen **Gitleaks 8.30.1**'i kullanın ve sağlama toplamını doğrulayın. Denetim aracı hiçbir zaman sistem paketlerini yüklemez veya verileri yüklemez. Özel çıktı, genel PR'ye değil, göz ardı edilen `.runtime/open-source-audit/`'ye gider.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Çıktılar yeni yollar olmalıdır; araçlar hiçbir zaman önceki adayların üzerine yazmaz. Yalnızca sayımı değil, düzeltilen konumları da inceleyin. Sentetik donanımları, genel önyükleme kimlik bilgilerini, tanımlayıcı hatalı pozitifleri ve gerçek/olası özel kimlik bilgilerini ayrı ayrı belgeleyin. Desen taramaları, kimlik bilgilerini veya OCR ekran görüntülerini doğrulayamaz. İkili yapılar hariç tutulur, taranmış-temiz olarak bildirilmez. Kaynak dışa aktarıcı, yalnızca Git tarafından bilinen dosyaları ve [release-policy.json](release-policy.json) dosyasındaki açık izlenmeyen girişleri kabul eder. Yeni izlenmeyen girdilerin gözden geçirilmesi gerekiyor. Sembolik bağlantıları ve yol geçişini reddeder ve dosya başına SHA-256 artı hariç tutmaları yayar. `website/`, izlense veya izlenmeyen bir giriş olarak listelense bile her zaman hariç tutulur. Özel havuzun `.git` dizinini asla genel ödeme alanına kopyalamayın. Yayımlamadan önce hem ağacın hem de erişilebilir tüm genel kayıtların hiçbir web sitesi dosyası içermediğini doğrulayın; daha sonraki bir işlemde dosyaların silinmesi eski geçmişi kaldırmaz.

Ek kontrol; erişilebilir commit/tag mesajlarını, kolay tahmin edilebilen kimlik bilgilerini ve giriş sabitlerini, cihaz kimliklerini ve geliştirme adreslerini kapsar. Test verileri otomatik olarak muaf değildir: korunan her fikstürün neden sentetik olduğunu açıklayın. Bilinen özel değerleri `{id, value, word?}` kayıtlarından oluşan harici bir JSON dizisinde tutun ve dosyayı `--denylist` ile belirtin. Kimliklerde hassas bilgi kullanmayın; bu dosyayı kaynak çalışma ağacının dışında tutun. Raporlar değerleri değil, yalnızca konumları ve özetleri gösterir. Bilinen bir değer eşleşirse kontrol başarısız olur. Temizlik sırasında `--scope worktree` kullanın; yayımlamadan önce üst commit içermeyen yeni sürüm deposunda `--scope all` kontrolünü yapın. Eski geçmişi veya özel inceleme raporlarını yayımlamayın.

Kasıtlı tek fabrika yöneticisi varsayılanı `admin / admin`'dir; dağıtım sırasında değiştirin. Dağıtım/tarayıcı test araçları, korumalı yerel giriş aracılığıyla mevcut hesap kimlik bilgilerini almalıdır. Yeni oluşturulan duman testi hesapları rastgele kimlik bilgileri kullanır ve temizleme sırasında devre dışı bırakılır. Başarısız bir temizleme, başarılı bir çalıştırma değil, bir test hatasıdır. Sürecin aniden sonlandırılması temizlemeyi engelleyebilir; Operatörlerin böyle bir kesinti sonrasında geçici hesaplarında mutabakat sağlamaları gerekmektedir. Hiçbir kamuya açık belge, bir test belgesinin şu anda geçerli olduğunu iddia etmez.

Yalnızca bakımı yapılan `install/` giriş noktası temiz cihaz kurulum yoludur. Bileşen sahipliği değerlendirmesi [OWNERSHIP.md](OWNERSHIP.tr.md) dosyasındadır.

Buradaki hiçbir komut Git'i zorlamaz, görünürlüğü değiştirmez, geçmişi yeniden yazmaz, canlı kimlik bilgilerini döndürmez, bir cihazı değiştirmez veya üçüncü taraflara yeniden dağıtım hakları vermez. Herkese açık sürüm, açıkça seçilmiş bir genel hedef ve nihai yapı incelemesini gerektirir. `delivery-2026-10-22` dosyasını özel depoda saklayın.
