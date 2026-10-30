<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.tr.md)
<!-- doc-navigation:end -->

# Genel kaynaktan bir cihaz oluşturun

Yeni orkestrasyon giriş noktası [SOURCE-INSTALL.md](SOURCE-INSTALL.tr.md) içinde belgelenmiştir. Aşağıdaki tarifleri otomatikleştirir; tam cihaz doğrulama durumu burada belirtilir. Bu manuel tarifler bakım görevlileri ve bireysel aşamada teşhis için kullanılabilir durumda kalacaktır.

Bu, kaynaktan pakete giden yoldur. Önceki bir Team AI Box kurulumunu, kapsayıcılarını, hesaplarını, sertifikalarını, konuklarını veya veritabanını içe aktarmaz. Yapım makinesinin internet erişimine ihtiyacı var; ortaya çıkan eksiksiz paket çevrimdışı olarak yüklenir. Müşteri, Windows/Linux kurulum ortamını ayrı olarak sağlar.

Kaynak indirmeler, derleme katmanları ve sıkıştırılmamış son paket için Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 ve yeterli disk alanı kullanın. Model niceleme ayrıca yeterli boş belleğe sahip uyumlu bir NVIDIA GPU gerektirir. Makine sahibinin izni olmadan bu belleği elde etmek için diğer iş yüklerini durdurmayın. Docker ve NVIDIA önkoşullardır, yükleyici tarafından değiştirilen bileşenler değildir.

Komutları yeni bir genel ödemeden çalıştırın. `BUILD`'yi ödeme bölümünün **dışında** yeni, mutlak bir derleme dizinine ayarlayın. Çıktılar, modeller ve raporlar taahhüt edilmemelidir. Her yardımcı, belirli bir devam ettirme işlemini belgelemediği sürece, meşgul bir çıktıyı reddeder. Başka birinin makinesinden kopyalanan resim adlarını değil, başarılı raporun referanslarını/kimliklerini kullanın. Yerel Docker içerik kimliği indirilebilir bir kayıt defteri referansı değildir; Dockerfile ana argümanlarının karşılık gelen yerel etikete veya nitelikli bir yukarı akış özetine ihtiyacı vardır.

## 1. Hizmetler ve uygulamalar

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host`, yüklü hizmet ağını değil, çevrimiçi **derlemeleri** etkiler. Düğüm bağımlılığı aşamaları, Düğüm varsayılanı olan 250 ms yerine bağlantı denemesi başına 2 saniyeye izin verir. Bu, kayıt defterlerini değiştirmeden, IPv6'yı devre dışı bırakmadan veya TLS/paket bütünlüğü kontrollerini zayıflatmadan resmi npm indirmelerinin, kullanıcı tarafından yönetilen VPN'ler de dahil olmak üzere daha yüksek gecikme süreli bağlantılarda kullanılabilir olmasını sağlar. Ayar, yüklü uygulamadaki bir ortam değişikliği değil, derleme aşaması bağımsız değişkenidir. Daha yavaş bir bağlantı için doğrudan Docker derlemeleri `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`'yi geçersiz kılabilir. Web görüntüsü kendi kilitli bağımlılıklarını ve varlıklarını oluşturur. Düğüm hizmetleri, yeni oluşturulan API bağımlılığı kapatma özelliğini paylaşır. OCR, genel bağdaştırıcısını içerir; başka bir projeden yayınlanmamış bir çalışan paketine ihtiyaç duymaz. Çeviri, sabitlenmiş genel NVIDIA vLLM görüntüsünü kullanır. Gömme, toplu ASR ve yayın medyası, ilgili genel çalışma zamanı görüntülerini kasıtlı olarak paylaşır. Bilgisayar görüntüsü, orijinal Windows çalışma zamanının yeteneklerini koruyarak, ARM TPM/PPI, KVM, VNC ve PulseAudio desteğiyle imzası doğrulanmış QEMU 11.1.1'i oluşturur. Debian çalışma zamanı kitaplıkları sağlar, ancak eski paketlenmiş QEMU'su bu yürütülebilir dosyanın yerini almamalıdır. Son görüntü hem ARM TIS `ppi` özelliğini hem de PulseAudio arka ucunu kontrol eder ve eşleşen RAM çerçeve tamponu ROM'unu içerir. Sınırlı çalışma zamanı araştırması ve verileri koruyan güncelleme gereksinimleri için [sanal bilgisayar çalışma zamanı kılavuzuna](../deploy/windows-computer/README.tr.md) bakın.

Her rolün bir günlüğü vardır. Başarısız bir rapor, başarılı rol çıktılarını korur; yalnızca başarısız olan rolü oluşturun ve başarılı raporları daha sonra birleştirin. Çalışan bir geliştirme kapsayıcısını eksik görüntü olarak değiştirmeyin.

## 2. Hesapsız Android ve kamera çalışma zamanı

Kilitler, Google'ın AOSP yapısını, ana bilgisayar paketini, çekirdek girişlerini ve kaynak revizyonlarını sabitler. İndirilenler kullanımdan önce kontrol edilir. Montaj sırasında hiçbir misafir başlatılmaz.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Kamera APK yaması için Google'ın genel Android komut satırı araçlarını, platformunu `android-36.1`, derleme araçlarını `36.1.0` ve JDK'yı destekleyen Java sürümünü yükleyin.
8. `ANDROID_SDK_ROOT` and `JDK_HOME`'yi bu araç dizinlerine ayarlayın. Araçlar, dışa aktarılan Android kullanıcı profilleri değil, derleme bağımlılıklarıdır. ARM64 Linux'ta, Google'ın paket halindeki `zipalign` paketi yalnızca x86 olabilir: Ubuntu'nun ARM64 `zipalign` paketini yükleyin ve aşağıdaki `--zipalign /usr/bin/zipalign` kodunu iletin. D8 ve apksigner Java programlarıdır. APK yapısı alternatif olarak desteklenen ayrı bir SDK ana bilgisayarında da çalışabilir; yalnızca iki çıktı dosyasını (`Camera2.apk`, `camera-preview.json`) aktarın; o ana bilgisayarın Android ayarlarını veya kullanıcı profilini asla aktarmayın.

Stok APK'sını temiz AOSP yapısından çıkarın (çıktı dizini mevcut olmalı ve derleme kapsayıcısı tarafından yazılabilir olmalıdır):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK, özel bir ürün anahtarını değil, bilinen **genel AOSP testi imzalayanını** saklar. Yardımcı, orijinal ve sonuçtaki sertifikayı ve değiştirilmemiş APK kaynaklarını doğrular ve geçici imzalama materyalini kaldırır. Bu bir hesap veya Google cihazı kimliği değil.

Mevcut tam yükleyici sözleşmesi aynı zamanda deneysel bir Google Android versiyonunu da içermektedir. Herkese açık giriş kilidi ve imza denetimi, Google'a sertifikasyon veya yeniden dağıtım hakları **vermez**. Yalnızca geçerli üçüncü taraf koşulları dahilinde oluşturun/kullanın; ortaya çıkan paketin tamamını sınırsız bir MIT indirme olarak yayınlamayın.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Yayımcı model dosyaları ve genel niceleme tarifi

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Tüm model indirmeleri, `deploy/compute/*profile*` içindeki değişmez revizyonları ve yayıncının Git/LFS karmalarını kullanır. İsteğe bağlı `--cache <directory>` salt okunurdur ve dosyaları yalnızca baytları yayıncıyla eşleştiğinde kabul eder. Kurulu bir model dizinini gelişigüzel içe aktarmanın bir yolu değildir. ASR'nin bağımsız MIT metni orijinal Whisper sürümüne sabitlenmiştir çünkü dönüştürülen model anlık görüntüsü yalnızca lisansı bildirir. OCR, MIT değil, kendi lisansını korur. Sabitlenmiş çeviri ve yerleştirme modeli kartları, bağımsız metnini göndermeden Apache-2.0 ifadesini bildirir; yardımcıları, sağlama toplamı sabitlenmiş Apache lisansını ve bu bildirimi kontrol ettikten sonra bir kaynak kaydını içerir.

Kesintiye uğrayan bir eşleştirme indirmesi `--resume`'yi destekler. `--transfer ranges`, sınırlı, sürdürülebilen HTTP aralıklarını kullanır; `--transfer huggingface`, resmi `huggingface_hub`/`hf_xet` paketlerini gerektirir ve jeton kullanımını devre dışı bırakır. Kısmi parçalar ve indirme önbellekleri yayınlanabilir model dizinlerinin dışında kalır. Her taşımada sağlama toplamı zorunludur. HTML giriş/meydan okuma sayfaları veya kesilmiş indirmeler için bunları zayıflatmayın.

Niceleme, ModelOpt'un genel sentetik kalibrasyon verilerini kullanarak ayrı bir derleme kapsayıcısında çevrimdışı olarak çalışır, hiçbir zaman sohbet geçmişlerini kullanmaz. Yalnızca `build.json` `quantized` yazan çıktılar `assistant-model` and `translation-model` sağlayabilir; ham kaynakları veya derleme çalışma alanının tamamını değil, `model/` alt dizinlerini seçin. Girişleri doğruladıktan sonra Linux yapıları, çekirdeğe bu belirli dosyaların önbelleğe alınmış sayfalarını yayınlamasını tavsiye eder. Bu, GB10'un paylaşılan belleğindeki yanıltıcı anında serbest GPU bellek okumalarını önler; ağırlıkları silmez, ana bilgisayar genelindeki önbellekleri temizlemez veya iş yüklerini durdurmaz. Yardımcı, bir GB10 GPU için Linux'tan `MemAvailable` bütçe ayırır ve kalibrasyon ve ana bilgisayar için kapasite ayırır. Çoğunlukla CPU'dan oluşan bir yapıyı sessizce kabul etmek yerine yetersiz kapasiteyi reddeder. Tam model uyduğunda, açık ModelOpt bütçeleri Accelerate'in gereksiz CPU boşaltma dışa aktarma yolunu önler. Derleme kapsayıcısı ayrıca [NVIDIA'nin niceleme başlatma gereksinimlerine](https://build.nvidia.com/spark/nvfp4-quantization/instructions) uygun olarak sınırsız kilitli bellek ve 64 MiB yığın ayarlar. Bu ayarların kapsamı ana makine genelindeki sınırlara göre değil, derleme kapsayıcısına göre belirlenir.

## 4. Paket girişlerini tamamlayın

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

Birleşme **41 rol bildirmeli ve eksik rol olmamalıdır**. Görüntü mimarisini/içerik kimliklerini doğrular ve çakışan çıktıları reddeder. Kaynaklar yalnızca yukarı akış UEFI bellenimini (yeni bir değişken depo şablonu dahil), sağlama toplamı sabitlenmiş bir sanal sürücü ISO'sunu, kaynak çizim çalışma zamanını ve yeni oluşturulan görüntülere bağlı Android bildirimlerini içerir. ISO, Windows kurulum ortamı değildir. Sağlama toplamı ile aynı Microsoft OpenVMM aynası, etkileşimli Fedora indirme sayfasına güvenmekten kaçınır.

[README.md](README.tr.md) bölümünde açıklandığı gibi `collect_host_packages.py` içeren ana bilgisayar paketlerini toplayın, ardından `prepare-release.py --template` ile şablonu oluşturun. Resim haritasını `images.json` adresinden doldurun; `resources/assets.json` and `guest-tools` model çıktılarından 12 varlık rolünün tamamını doldurun. `sourceCommit`'yi ödeme ve gerçek temsilci sürümüne ayarlayın. Hiçbir yer tutucu veya önceki kurulum konfigürasyonu kabul edilemez.

Hazırlanan sürümü kullanarak `prepare-release.py --inputs … --output …`'yi, ardından `build-package.sh`'yi çalıştırın. Değiştirilmiş/taahhüt edilmemiş kaynaklar açık `--allow-working-tree` aday bayrağını gerektirir; serbest bırakılmış bir taahhüt değiller. Kurulum için [PACKAGE-README.md](PACKAGE-README.tr.md) dosyasına bakın. Yeni bir boş hesap veritabanı `admin/admin` alır; tüm hizmet kimlik bilgileri ve cihaz kimliği bağımsız olarak oluşturulur. Derlemeler tek başına kurulumun başarılı olduğunu kanıtlamaz.

## Tarihsel katmanlı tarifler ve yayın kontrolleri

Daha eski tanılama/katmanlı Docker dosyaları kaynak bakımı için tutulur ve bu işlem hattı tarafından kullanılmaz. `BUILD_PARENT_N` bağımsız değişkenlerinin kasıtlı olarak özel görüntü varsayılanı yoktur. Oluşturduğunuz uyumlu bir ana öğeyi sağlayın veya yukarıdaki genel boru hattını kullanın; Kullanılamayan bir geliştirme özetini tahmin etmeyin.

Yayımlamadan önce kaynak korumasını ve gizli tarayıcıyı çalıştırın, geçmişi ayrı ayrı inceleyin ve tüm derleme dizinlerini, paketleri, konuk diskleri, hesap verilerini ve özel web sitesini hariç tutun. Yerel yolları içeren raporlar genel ağacın dışındadır. Bu çalışmanın doğrulaması; derleme girişi kapatma, yapı kimliği, kurulum ve yeni kurulan minimum hizmet yolları ile sınırlıdır; ilgisiz iş kabulünü yeniden yürütmez.
