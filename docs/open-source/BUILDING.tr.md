<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.tr.md)
<!-- doc-navigation:end -->

# Kaynağı oluştur

Genel yapı, önceden oluşturulmuş bir çevrimdışı cihaz görüntüsü değil, kaynaktır. Bir kaynak yapısı bağımlılıkları indirebilir; hazırlanmış bir tam paket kullanılarak yapılan kurulum çevrimdışı kalır. Her iki işlemin de ViKey SDK'ya veya USB anahtarına ihtiyacı yoktur.

Tam bir cihaz kurulumu için kök [hızlı başlangıç](../../README.tr.md#install) ve [kaynak yükleyici](../../install/SOURCE-INSTALL.tr.md) ile başlayın: `sudo bash install/from-source.sh` uyumlu yeni bir Spark'ı indirir, derler, paketler ve yükler. Aşağıdaki geliştirme web yapısı bu yükleyici değildir ve ürünün tamamını başlatmaz.

## Geliştirme

Node.js 24, pnpm 11.1.3 (bkz. root `package.json`), Python 3.10+ ve her `go.mod`'de belirtilen Go sürümünü (düğüm aracısı şu anda 1.26) kullanın. Bir yapım makinesinde:

Kaynak aktarımının kasıtlı olarak özel Git geçmişi yoktur. Dışa aktarılan ağaçta kaynak araçlarını çalıştırmadan önce, kendi veri havuzunuzu başlatın ve incelenen ağacınızı (`git init`, `git add .`, `git commit`) kaydedin. Normal bir genel Git klonunun bu adıma ihtiyacı yoktur. Bu yeni taahhüdü yapı kimliği olarak kullanın; Dışa aktarılan, değiştirilmiş bir ağacı talep etme eski teslimat taahhüdüdür.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Web yapısı, ürün kabulü değil, derleme kontrolüdür. Çalışma zamanı hizmetleri, `deploy/` altındaki Docker dosyalarını kullanır. DGX Spark yürütmesi için Linux ARM64 ve mevcut NVIDIA/Docker ortamı gerekir. Masaüstü kaynağının satın alınması söz konusu donanımın yerini almaz. Yükleyici olarak geçmiş laboratuvar komut dosyalarını kullanmayın.

Python fabrika oluşturma yardımcıları ayrıca PyYAML'a ihtiyaç duyar; yükleyici bağımlılığı ön kontrolüne bakın. Yüklü bir işletim sistemi diski veya geliştirici hesabı gerekmez.

## Hariç tutulan derlenmiş girişler

Dışa aktarıcı, uzantıları zararsız görünse bile ikili dosyaları atlar:

- Go kaynağından `services/node-agent` ve onun `cmd/factory-worker-spec` yardımcısını oluşturun; repository-root `node-agent` yürütülebilir dosyası bir kaynak girişi değil.
- Android fikstür APK'ları ve imzalama dosyaları gönderilmez. `tools/fixtures/` kapsamındaki kaynakları ve manifestleri yerel test derlemeleri için kullanılabilir durumda kalacaktır.
- Mevcut cihaz yayın yapısı `deploy/appliance/wireless-casting-plugin.Dockerfile` kullanıyor. Eski Alpine paket arşivlerine ihtiyaç duymaz. Bunun yerine bağımsız Dockerfile eklentisini kullanırsanız, [yukarı akış sağlama toplamı bildiriminde](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) içinde tanımlanan paketlerin tamını edinin ve derlemeden önce bunların SHA-256 değerlerini doğrulayın. Sabitlenmiş yukarı akış yapısı mevcut olmadığında asla rastgele bir paketi değiştirmeyin.
- LiveKit tarayıcı modülü ve lisansı, eklentinin genel kaynak dizininde kalır; yedek npm `.tgz` arşivi gönderilmedi.

Bunlar kaynak dağıtımı hariç tutmalarıdır, çalışan cihazda yapılan değişiklikler değildir.

## Çevrimdışı paketi tamamlayın

[Genel kaynak hattı](../../install/PUBLIC-BUILD.tr.md) ile başlayın. Genel ana görüntüleri ve kaynak tarafından oluşturulmuş çalışma zamanı bağımlılıklarını sağlar; önceki bir geliştirici kurulumu gerekli değildir. Tarihsel katmanlı görüntü tarifleri yeni kuruluma giriş noktası değildir.

Uygulama görüntüsü derlemeleri, konuk barındırma araçları, çevrimdışı barındırma paketleri, varlık toplama ve son paketleme için [install/README.md](../../install/README.tr.md) adresini takip edin. Hedef cihaz bağımlılıkları getirmez veya Docker/NVIDIA'nin yerini almaz. Derleme girişlerini gerçek kaynak taahhüdünüze, ARM64 OCI içerik kimliklerine ve temiz varlık yollarına ayarlayın. Geliştirme ana bilgisayarı IP'si, hesabı, sertifikası veya birimi gerekmez. Model ağırlıkları ve konuk/çalışma zamanı varlıkları, [components.json](components.json) ve depo kilitlerinde tanımlanan tam yukarı akış kaynaklarından ayrı olarak elde edilir. Lisanslarını ve gerekli kaynak bildirimlerini koruyun.

**Kaynak kullanılabilirliği, ikili yeniden dağıtım izni değildir.** Mevcut tam çevrimdışı paket sözleşmesi, bir Google Android çalışma zamanını içerir; özel kurulum kanıtı GMS'yi dağıtma izni değildir. Mevcut paketleyici değişmeden korunur, ancak bu tür bir paket, bu haklar alınmadığı sürece onaylı bir genel indirme değildir. Yalnızca AOSP'ye yönelik genel ikili sürüm, burada sessizce değiştirilmeyen, ayrı kapsamlı bir paketleme değişikliği olacaktır. Windows/Linux ISO dosyaları her kullanıcı tarafından sağlanır; yüklü test konuklarının veya hesap durumlarının hiçbiri genel derleme girişi değildir.
