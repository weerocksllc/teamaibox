<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.tr.md)
<!-- doc-navigation:end -->

# Herkese açık bir klondan yükleme

Bu giriş noktası gerekli genel girdileri hazırlar, uygulama görüntülerini oluşturur ve kurulumdan önce eksiksiz bir paket oluşturur. Oluşturma ilerlemesi devam ettirilebilir; yalnızca nihai kurulum hazırlığı sonucu kurulu bir cihazı gösterir. İndirme veya ön kontrol başarısı tek başına yeterli değildir.

Oluşturulan modelleri, konteyner görüntülerini, kurulum paketlerini, test kayıtlarını ve kimlik bilgilerini havuzun dışında tutun. Üçüncü taraf aynanın kullanılabilirliği garanti edilmez; doğrulanmış taşınabilir önbellekler ve çevrimdışı paketler aşağıda açıklanmıştır.

Docker/Compose, NVIDIA ve KVM ile çalışan, Ubuntu 24.04 yüklü yeni bir DGX Spark üzerinde, genel depoyu klonlayın ve kökünden çalıştırın:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Yukarı akış model/görüntü uç noktalarına ulaşılamayan bir Çin ana karası ağı için, bölgesel indirme kaynaklarıyla aynı giriş noktasını kullanın:

```sh
sudo bash install/from-source.sh --region cn
```

Bu, çevrimdışı bir kaynak derlemesi değil, **çevrimiçi kaynak derlemesi ve ardından çevrimdışı yüklemedir**. Eksik derleme araçlarını otomatik olarak hazırlar, altı model girişini indirir, Android'i ve tüm uygulama görüntülerini derleyip birleştirir, iki kaynak modelini niceler, donanım yazılımı/ana bilgisayar paketlerini toplar, çevrimdışı paketin tamamını oluşturur ve mevcut yükleyicisini çalıştırır. Docker/NVIDIA'nin yerini almaz, Docker arka plan programını yeniden başlatmaz, mevcut kurulumu temizlemez veya ana bilgisayar yönlendirmesini, DNS veya VPN ayarlarını değiştirmez. Modeller, misafir giriş durumları ve özel pazarlama web sitesi başka bir kurulumdan alınmaz.

Varsayılan çalışma alanı: `/var/tmp/teamaibox-source-build`; indirme önbellekleri ve aşama başına günlükler, klonun dışında orada bulunur. Kurulum varsayılanı `/srv/teamaibox/installation` şeklindedir. Büyük indirmeler ve birkaç yüz GB geçici disk kullanımı bekleyebilirsiniz. Model yükleme ve GPU nicelemesi önemli ölçüde zaman alabilir; sabit bir tamamlanma süresi vaat edilmemektedir.

## Kurulumu sürdürme ve durum

Kesintiye uğrarsa **aynı komutu yeniden çalıştırın**. Çalışma alanını koruyun. Çalışan bir yapı başka bir yazarı hariç tutar; tamamlanan aşama dosyaları ve görseller yeniden kullanılmadan önce doğrulanır. Başarısız denemeler teşhis için kullanılabilir durumda kalırken bir sonraki deneme yalnızca başarısız aşamayı çalıştırır. Model bayt aralıkları ve doğrulanmış dosyalar korunur. `state.json` mevcut aşamayı ve onun günlük dizinini tanımlar. Resmi model indirmeleri sınırlı dosya/aralık eşzamanlılığını kullanır; bölgesel kaynaklar oran sınırlamasını azaltmak için muhafazakar eşzamanlılık kullanıyor. Aktarılan veya yeniden kullanılan dosya başına bayt ilerleme raporları, son yayıncı karma doğrulamasından ayrı olarak değişir. Konuk aracı derlemesi aynı zamanda oturum açmaya gerek kalmadan bir sistem hizmeti altında da çalışır: sonuçta ortaya çıkan kurulum varlıklarının dışında yalıtılmış yapı önbellekleri oluşturur.

Kaynak değişiklikleri yeni bir `--work-dir` gerektirir; indirme önbelleğini `--cache-dir /path/to/public-cache` ile yeniden kullanın. Kaynak parmak izi, farklı kodlardan gelen çıktıların sessizce birleştirilmesini önler. Mevcut bir kurulum, onu sıfırlamaya yönelik bir davet değildir: yalnızca bu çalışma alanının aynı paket kurulumu devam edebilir; diğer yüklemelerin yükseltme işlemlerini kullanması gerekir.

Yararlı modlar:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` salt okunurdur ve indirme işlemlerinin başarılı olacağını iddia etmez. Salt indirme ve salt derleme açıkça kurulu hazır olma iddiasında bulunmaz.

## Bölgesel kaynaklar ve bütünlük

Çin modu, model aktarımı için `https://hf-mirror.com` ve özet sabitlenmiş Docker Hub girişleri için `https://docker.m.daocloud.io` kullanır. Bunlar üçüncü taraf aynalardır; Weerocks veya model yayıncıları tarafından işletilen hizmetler değildir. Git taahhüdü modeli ürün profiline sabitlenir; doğrulanmış Git ağacı ve LFS işaretçileri, beklenen dosya boyutlarını ve karmaları oluşturur. Aynanın API yanıtı tek başına güven oluşturamaz. Docker sabitlenmiş manifest/katman özetlerini doğrular. Sabitlenmemiş etiketler otomatik olarak yeniden yönlendirilmez (Go derleme aracının açık bir özet kilidi vardır). NVIDIA resim yayıncının kayıt defterinde kalıyor. TLS doğrulaması etkin kalır ve model aynalarına hiçbir hesap belirteci gönderilmez.

`--model-endpoint` and `--registry-mirror` kullanarak kendi HTTPS kaynaklarınızı seçebilirsiniz. Uç nokta değerleri, kimlik bilgilerini veya sorgu parametrelerini içermemelidir. Kapsamlı Docker sarmalayıcısı yalnızca bu derleme işlemi için geçerlidir; sistem arka plan programı veya diğer projeler için geçerli değildir. SDK meta verileri ve lisans arşivleri hâlâ yetkili HTTPS yayıncılarından gelmektedir; bir ayna karmaları icat edemez.

Aynalar hız sınırlı olabilir veya kullanılamayabilir. Model indirmeleri sınırlı eş zamanlılıkla çalıştırılır ve bekleme sürelerine uyulur. Hiçbir komut dosyası, her ağdaki her yukarı akışa bağlantıyı garanti edemez. Her iki rota da mevcut değilse, indirmeleri veya paketin tamamını erişilebilir ve uyumlu bir makinede hazırlayın ve bunları kopyalayın:

- `--download-models-only --cache-dir <public-cache>` doğrulanmış model dosyalarını ve sürdürülebilir önbellekleri hazırlar. Bu dizini kopyalayın ve ardından onu `--cache-dir` ile hedefe iletin. Yeniden kullanılan her model, sabitlenmiş kimliğine göre kontrol edilir. Bu önbellek tam bir çevrimdışı yükleme paketi **değildir**.
- `--build-only` paketin tamamını çevrimdışı kurulum için hazırlar. Katranını ve sağlama toplamını kopyalayın, doğrulayın ve paketi açın, ardından içinde `sudo ./install.sh` komutunu çalıştırın. Bu, güvenilir bağlantısız ana bilgisayar yoludur; hedefte bir VPN veya bir geliştirme kutusuna erişim gerektirmez.

Genel girişlerin yerine asla canlı bir Docker veri dizinini, konuk disklerini, tarayıcı profillerini, hesap veritabanlarını, kimlik bilgilerini veya özel önbellekleri kopyalamayın. Sağlama toplamlarını devre dışı bırakmayın veya oturum açma/meydan okuma sayfasını model dosyası olarak kabul etmeyin.

## Lisanslama ve ilk kullanım

Oluşturmadan önce `THIRD_PARTY_NOTICES.md`, Android SDK şartlarını ve bireysel model lisanslarını inceleyin. Üçüncü taraf bileşenlerin indirilmesi, bunları MIT öğelerine dönüştürmez veya Google'a sertifika/yeniden dağıtım hakları vermez. Windows/Linux ISO medyası hâlâ kullanıcı tarafından sağlanmaktadır. Fabrika girişi `admin/admin` olarak kalır; cihazı açığa çıkarmadan önce değiştirin. Mevcut yükleyici bağımsız hizmet kimlik bilgileri oluşturur ve fiili hazır olma durumunu bildirir.

Tamamlandıktan sonra aynı LAN üzerinde `https://<BOX_LAN_IP>/` dosyasını açın; Docker köprüsü veya VPN adresini değil, Spark'ın mevcut fiziksel ağ adresini değiştirin. Kaynak çalışma alanının `state.json` kayıtları ilerlemeyi oluşturur. Kurulu `/srv/teamaibox/installation/readiness.json` kurulum kontrollerini kaydeder. Ne başarılı bir derleme ne de dinleme kabı sağlık kontrolü, bir uygulamanın gözle görülür uçtan uca işleminin yerini alamaz.

Yayınlama çalışma zamanı, UxPlay alıcısını, özel D-Bus ve Avahi keşif yürütülebilir dosyalarının yanı sıra medya eklentilerini de içermelidir. Son genel görüntü yapısı bu yürütülebilir dosyaları kontrol eder; istemci kitaplığı tek başına yeterli değildir. Yeni bir kurulum, masaüstü proxy'sini ve ağ geçidini diğer API ağ-ad alanı bağımlılarına kaydeder, böylece gruplandırılmış API yükseltmeleri masaüstü bağlantı yolunu koruyabilir. Bakım sırasında o grubun yalnızca bir alt kümesini yeniden oluşturmayın.
