<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.tr.md)
<!-- doc-navigation:end -->

# Team AI Box çevrimdışı paket aracı

Orijinal yükleyici MIT lisanslıdır. Paketler, dosya karma envanterinde kök lisansı, üçüncü taraf envanterini ve lisans metinlerini içerir. Bu, modelleri, Google hizmetlerini, sürücüleri veya kapsayıcı bağımlılıklarını MIT olarak yeniden lisanslamaz. Dağıtımdan önce [yayın sınırlarını](../docs/open-source/RELEASING.tr.md) okuyun; Mevcut tam bir test paketinin otomatik olarak yeniden dağıtım izni yoktur.

Müşteriler hazırlanan paketin içinde **`sudo ./install.sh` çalıştırır**. Bakımcılar bu paketi `build-package.sh` ile oluşturur. Çevrimdışı müşterilerin Git, Node, Go, pip veya genel paket depolarına ihtiyacı yoktur.

Genel bir klondan otomatik indirme, derleme ve kurulum için `sudo bash install/from-source.sh` komutunu çalıştırın. Çin'deki ağlar `--region cn` kullanabilir. Çalıştırma, devam ettirme ve çevrimdışı aktarım için [SOURCE-INSTALL.md](SOURCE-INSTALL.tr.md) konusuna bakın. Devam desteklenmektedir; yalnızca nihai hazırlık sonucu kurulumun tamamlandığını belirler. Başarılı bir ön kontrol veya indirme yeterli değildir.

Hedef, fabrikada Ubuntu 24.04 ARM64 sistemi ve çalışan Docker Engine, Compose v2, NVIDIA Container Toolkit/GPU ve KVM'ye sahip yeni bir DGX Spark'dir. Yükleyici, Docker/NVIDIA'yi değiştirmez, Docker'ı yeniden başlatmaz veya bir geliştirme cihazının hesaplarını, veritabanını, anahtarlarını veya sanal makinelerini kopyalamaz.

> Özel tesisat kabul kayıtları tarihsel gelişim deposunda kalır. Bunlar genel kaynak dosyaları veya derleme girdileri değildir. Mevcut ilk kurulum, devam ettirme ve önyükleme kurtarma kanıtları yalnızca kaynak yayınlama için yeniden çalıştırılmaz ve keyfi olarak yeni oluşturulan görüntüleri nitelendirmez veya üçüncü taraf ikili dosyalar için yeniden dağıtım hakları vermez.

## Bakımcılar: sürüm girişlerini hazırlayın

**Yeni bir genel GitHub derlemesi için [PUBLIC-BUILD.md](PUBLIC-BUILD.tr.md) ile başlayın.** Bir geliştirme cihazından görüntüler gerektirmeden genel görüntüleri, kamera çalışma sürelerini, model indirmeleri/kuantizasyonunu ve ürün yazılımını kapsar. Aşağıdaki katmanlı görüntü yardımcıları, doğrulanmış yapıtların artan güncellemelerini destekler; bunlar yeni bir yapının önkoşulları değildir.

Hazırlık interneti kullanabilir. Teslim edilen paketten kurulum bağımlılıkları indirmemelidir. Paketleme ana bilgisayarının Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` ve yeterli depolama alanına ihtiyacı var. Modeller ve görseller büyük olabilir; paketleyici hem çıkarılan ağacı hem de `.tar` tutar ve gerçek girdilerden alanı tahmin eder. Ne bir geliştirme cihazının tamamını tarar ne de çalışan konteynerlerden yazılabilir katmanları dışa aktarır.

1. Gerekli tüm roller için **bir yayın sürümünden** ARM64 görüntülerini hazırlayın. `deploy/images/`, `deploy/appliance/` altındaki derleme giriş noktalarını ve karşılık gelen misafir/model dizinlerini kullanın. Platform API'si, Düğüm Aracısı, zamanlayıcı ve aracı denetleyicisi yerel görüntü kimliklerini desteklemelidir; PostgreSQL görüntüsü, geçiş 116 da dahil olmak üzere mevcut geçiş bildirimini içermelidir. Paketleyici, rastgele eski bir görüntüyü güncel bir görüntüye derlemez. Doğrulanmış aynı sürüm ana görüntülerle, beş ardıl görüntüyü oluşturmak için `build_runtime_images.py --bases … --node-agent-binary … --output …` öğesini kullanın. `--bases` bir JSON rolünden tam görüntü kimliğine eşlemedir. İlk önce Düğüm Aracısını `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build` ile oluşturun. Bu yardımcı, çekme/ağ oluşturma işlemlerini yasaklar, ana/kaynak kimliklerini kaydeder ve canlı etiketleri dağıtmadan veya değiştirmeden yeni görüntüler oluşturur. Temiz Android ROM'lar aynı zamanda mevcut kontrol ağı bağdaştırıcısına da ihtiyaç duyar. Ağ erişimi veya ROM verisi değişikliği olmadan her iki ROM ardıl katmanına `phone_network.py` eklemek için `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` kullanın. Tam görüntü kimliklerini ve kaynak özetlerini kaydeder. Android sepetini öncekilere değil, her iki yeni kimliğe bağlayın. `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>` kullanarak web'i ve dokuz resmi uygulamayı derleyin. Öncelikle web'i `apps/web/package.json` tarafından belirtildiği şekilde oluşturun. Yardımcı, üretim Docker dosyalarını kullanır, `/opt/teamaibox/web` adresindeki web dizinini düzeltir ve görüntü dosyalarını mevcut derleme giriş karmalarıyla karşılaştırır. Bir geliştirme kapsayıcısı görüntüsünün tam bir web yapısı olduğunu varsaymayın: fazladan statik dizin değişkenlerine bağlı olabilir veya eski bir dizin içerebilir. Bu çevrimdışı yardımcı dağıtılmıyor. On yeni görüntü kimliğinin tamamını sürüm girişlerine ekleyin.
2. Altı model için eksiksiz, temiz dizinler toplayın: yapılandırma, parçalar, belirteçler, gerekli kod ve lisanslar. Ayrıca iki temiz Android görüntüsü, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` ve çizim çalışma zamanı komut dosyalarını hazırlayın. Telefon örneği dizinlerini, kullanıcı disklerini, Google oturum açma durumunu, kullanıcı ISO'larını veya genel kimlik bilgilerini toplamayın. Android ROM'lar zaten `phone-runtime` / `phone-google-runtime` içindedir; ikinci bir diski kopyalamayın. `android-standard` / `android-google` varlık dizinleri yalnızca menşei, lisansları ve `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` ve `runtimeImageId: "sha256:…"` içerir. Kimlik, dışa aktarılan çalışma zamanı görüntüsüyle eşleşmelidir. Sürücü dizini yalnızca `virtio.iso` içerir; `windows.iso`'yi de içeren bir geliştirme dizini reddedilir.
3. Birlikte verilen iki Linux ARM64 ana bilgisayar aracını, bunları derleme ana bilgisayarına yüklemeden oluşturun:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. İnternet bağlantılı bir ARM64 derleme ana bilgisayarında, açık bir yerel Ubuntu 24.04 görüntüsünü kullanarak ana makine aracı bağımlılıklarını toplayın. Bir geliştirme cihazından kopyalanan kimliği değil, söz konusu ana bilgisayarda doğrulanan görüntü kimliğini kullanın:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Yalnızca cryptsetup, ext4, USB/kameralar, QEMU görüntü araçları, ağ iletişimi ve küçük sistem yardımcı programlarına yönelik bağımlılıkları toplayın. Docker, Containerd, NVIDIA, CUDA ve çekirdek değiştirme paketleri yasaktır. Kurulum yalnızca eksik araçları sağlar; apt, çevrimiçi bir geri dönüş olmadan paketin yerel dosya deposunu `--no-download --no-remove` ile okur.

5. Sürüm girişi bildirimini oluşturun ve **açık yapıt yollarını ve yerel görüntü içerik kimliklerini** sağlayın:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Şablon, 41 görüntü rolünün ve 12 harici varlık kategorisinin tamamını içerir; başka bir fabrika varlığı araçlar tarafından üretilir. Yer tutucular bir pakete giremez. `sourceCommit` ödemeyle, `agentVersion` gerçek Aracı yapısıyla ve `hostPackageCollection` 4. adımla `collection.json` eşleşmelidir. Derleme ana bilgisayarı yolları, müşteri çalışma zamanı yapılandırması değil, koleksiyon girişleridir. Mevcut fabrika oluşturucuyu kullanın: Çizim kullanıcı arayüzünün `drawing.automatic` / `drawing.fast` rotaları yerel model konfigürasyonuyla eşleşmelidir. İşçi sağlığı veya doğrudan model çağrısı tek başına başvuruya hazır olmayı sağlamaz. Paketleme, bu eşlemelerin eksik olduğu eski fabrika şablonlarını reddeder.

İmaj rolü sözleşmesi `python3 install/package.py --describe-contract` tarafından bildirilmektedir:

- Çekirdek, web, ekip çalışması, mesajlaşma, ağ geçitleri, zamanlayıcı, bakım, eklentiler, dinamik aracı sanal alanları ve paket kaynağı ağ geçitleri.
- Dokuz uygulama eklentisi, altı ofis modeli çalışanı ve isteğe bağlı ASR/hoparlör çalışma süreleri.
- Standart Android, Google Android, bilgisayar çalışma zamanı ve web ekranı/ses ağ geçitleri.
- Döküm alıcısı, medya işleme ve SFU.

İki rol bir görüntü içerik kimliğini paylaşabilir; arşivi yalnızca bir kez dışa aktarılır. Model parça dizinleri de kontrol edilir: eşleşen dosya karmaları, eksik parçanın mazeretini göstermez. Ana makine araçları gerçek ARM64 ELF ikili dosyaları olmalıdır.

## Paketi oluştur

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Çıkışlar `teamaibox-<releaseId>-linux-arm64.tar`, onun `.sha256` dosyası ve çıkarılan dizindir. Kopyalama, görüntü dışa aktarma, karma oluşturma ve arşivleme, son sağlama toplamı yayınlanmadan önce geçici bir dizinde gerçekleşir. Mevcut çıktıların üzerine yazılmaz; kesintiye uğramış bir yapı, tam bir sürüm gibi görünmemelidir. Görüntü kimlikleri değişmeden yalnızca yükleyiciye yönelik değişiklikler için `--image-cache <previous-extracted-package>` kullanın. Eski paketin tamamı, arşivleri gerçek görüntü kimliğiyle yeniden kullanılmadan önce doğrulanır ve yeni paket yeniden doğrulanır. Eski bir kurulumdan veya kapsayıcının yazılabilir katmanından hiçbir veri alınmaz. Bu, yüzlerce GB'lık aynı görselin tekrar dışa aktarılmasını önler.

Normal bir sürüm, paketlenmiş kaynak dosyalarının bildirilen Git işlemine ait olmasını gerektirir. Açık bir `--allow-working-tree`, bir geliştirme adayı oluşturur; manifest kayıtları `candidate: true` ve değişen dosyalar. Odaklanmış kabulü geçmek, taahhüt edilmemiş kaynağı yayınlanmış bir sürüme dönüştürmez.

Paket düzeni:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

`./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64` ile bağımsız olarak doğrulayın. Bu bütünlüğü kontrol eder; yeni donanımda başarılı bir önyükleme olduğunu kanıtlamaz.

## Müşteriler: çevrimdışı kurulum ve devam ettirme

[Paket kurulum kılavuzunu](PACKAGE-README.tr.md) okuyun. Varsayılan kök `/srv/teamaibox/installation`'dir. LUKS/ext4, sistem diskinde veya mevcut disklerde değil, yalnızca yeni `volume/data.img` içinde oluşturulur. Veri havuzu, sabit 256 GiB sınırını değil, kullanılabilir depolama alanını fiziksel güvenlik marjı hariç kullanır. Modeller, iş dosyaları ve konuk verileri şifrelenmiş birimde bulunur; mevcut Docker konteyner görüntülerini yönetir.

Yeni bir kurulum, başlangıç şifresi `admin` olan yönetici `admin` oluşturur. Sıradan kullanıcılar yönetici tarafından oluşturulur. Teslimattan/kullanmadan önce başlangıç ​​şifresini değiştirin. Bu yalnızca boş bir hesap veritabanı için geçerlidir: devam ettirme, yeniden çalıştırma, yeniden başlatma ve yükseltme, mevcut hesapları veya parolaları sıfırlamaz. Cihaz kimliği, hizmet kimlik bilgileri, sertifikalar ve yönetici kurtarma kodları bağımsız olarak oluşturulur, başka bir cihazdan kopyalanmaz. İlk GPU çekirdek önbellek hazırlığı, birlikte verilen araçlar ve modeller kullanılarak cihazda gerçekleştirilir; uyumlu önbellekler korunur. Önyükleme kurtarma, önce verileri ve cihaz hizmetlerini, ardından temel hizmetleri ve bireysel AI çalışanlarını geri yükler. Yükleyici yalnızca yükleme sırasında çalışır; yerleşik kurulum yöneticisi eklemez.

Kesintiden sonra orijinal komutu tekrarlayın. Tamamlanan adımlar doğrulanır; Verileri silerek veya kapsayıcıları yeniden oluşturarak çakışmaları gizlemeyin. Tamamlanmış bir aynı sürüm kurulumunun yeniden çalıştırılması yalnızca onu kontrol eder; farklı sürümler resmi yükseltme yolunu kullanır. Arıza ayrıntıları `install-state.json`, `readiness.json` dosyasındadır ve kurulum kökü altındaki aşama kayıtlarıdır.

## Doğrulama sınırları

Yükleyiciye özel testler, küçük yapısal yapılar, geçici dosyalar ve yalıtılmış çevrimdışı veritabanları/Docker arka plan programlarını kullanır. İş veritabanlarına erişmemeli veya mevcut VM disklerini bağlamamalıdırlar. Gerçekten yeni bir kurulum, bu amaç için açıkça belirlenmiş uyumlu bir DGX Spark gerektirir; bir iş aletini silmeyin. Kabul, ilgisiz iş testlerini değil, yeni kurulum için minimum başlatma, devam ettirme ve önyükleme kurtarmayı kapsar. Kaynak sürüm hazırlığının kendisi mevcut cihazları silmez, yeniden yüklemez veya dağıtmaz.

Bir derleme ana bilgisayarında, paketin tamamını boş önbelleğe sahip ve genel ağ içermeyen ayrı bir Docker arka plan programına aktarmak için `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` komutunu çalıştırın. Yeni yüklenen komut dosyasını çağırmaz, GPU kullanmaz, müşteri dizinlerini bağlamaz veya sistem Docker'ı yeniden başlatmaz. Raporu açıkça tam donanım kurulumu iddiasında bulunmuyor. Test görüntüleri özel test dizininde kalır, ek disk alanına ihtiyaç duyar ve sistem Docker'ın görüntü deposuna girmez.
