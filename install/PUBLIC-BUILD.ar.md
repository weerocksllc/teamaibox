<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.ar.md)
<!-- doc-navigation:end -->

# بناء جهاز من المصدر العام

تم توثيق نقطة إدخال التزامن الجديدة في [SOURCE-INSTALL.md](SOURCE-INSTALL.ar.md). يقوم بأتمتة الوصفات أدناه؛ تم ذكر حالة التحقق من الجهاز الكامل هناك. تظل هذه الوصفات اليدوية متاحة للمشرفين وتشخيص المرحلة الفردية.

هذا هو المسار من المصدر إلى الحزمة. لا يقوم باستيراد تثبيت Team AI Box سابق أو حاوياته أو حساباته أو شهاداته أو ضيوفه أو قاعدة بياناته. تحتاج آلة البناء إلى الوصول إلى الإنترنت؛ يتم تثبيت الحزمة الكاملة الناتجة دون اتصال بالإنترنت. يقوم العميل بتزويد وسائط تثبيت Windows/Linux بشكل منفصل.

استخدم Linux ARM64 (Ubuntu 24.04)، وDocker/BuildKit، وPython 3.10+، وPyYAML، وjq، وGit، وGo 1.26 ومساحة كافية على القرص لتنزيلات المصدر، وبناء الطبقات والحزمة النهائية غير المضغوطة. يتطلب تكميم النموذج أيضًا وحدة معالجة رسومات متوافقة NVIDIA مع ذاكرة خالية كافية. لا تقم بإيقاف أحمال العمل الأخرى للحصول على تلك الذاكرة دون إذن مالك الجهاز. يعتبر Docker وNVIDIA من المتطلبات الأساسية، وليس مكونات تم استبدالها بواسطة المثبت.

تشغيل الأوامر من الخروج العام الجديد. قم بتعيين `BUILD` إلى دليل بناء جديد ومطلق **خارج** منطقة الدفع. يجب عدم الالتزام بالمخرجات والنماذج والتقارير. يرفض كل مساعد مخرجات مشغولة ما لم يوثق عملية استئناف محددة. استخدم مراجع/معرفات التقرير الناجح، وليس أسماء الصور المنسوخة من جهاز شخص آخر. معرف محتوى Docker المحلي ليس مرجع تسجيل قابل للتنزيل؛ تحتاج الوسائط الأصلية لملف Dockerfile إلى العلامة المحلية المقابلة أو ملخص مؤهل للمصدر.

## 1. الخدمات والتطبيقات

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

يؤثر `--network host` على **الإصدارات** عبر الإنترنت، وليس على شبكة الخدمة المثبتة. تسمح مراحل تبعية العقدة بثانيتين لكل محاولة اتصال بدلاً من الإعداد الافتراضي للعقدة وهو 250 مللي ثانية. يؤدي ذلك إلى إبقاء تنزيلات npm الرسمية قابلة للاستخدام على الروابط ذات زمن الوصول العالي، بما في ذلك شبكات VPN التي يديرها المستخدم، دون تبديل السجلات أو تعطيل IPv6 أو إضعاف عمليات التحقق من سلامة TLS/الحزمة. يعد الإعداد وسيطة مرحلة الإنشاء، وليس تغييرًا للبيئة في التطبيق المثبت. بالنسبة للارتباط الأبطأ، يمكن أن تتجاوز إصدارات Docker المباشرة `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. تقوم صورة الويب ببناء تبعياتها وأصولها المقفلة. تشترك خدمات العقدة في إغلاق تبعية واجهة برمجة التطبيقات (API) المبنية حديثًا. يتضمن التعرف الضوئي على الحروف (OCR) المحول العام الخاص به؛ لا يحتاج إلى حزمة عاملة غير منشورة من مشروع آخر. تستخدم الترجمة صورة vLLM العامة المثبتة NVIDIA. تقوم عمليات التضمين والدفعة ASR ووسائط الإرسال بمشاركة صور وقت التشغيل العامة الخاصة بها عمدًا. تعمل صورة الكمبيوتر على إنشاء QEMU 11.1.1 تم التحقق من توقيعه مع دعم ARM TPM/PPI وKVM وVNC وPulseAudio، مما يحافظ على إمكانيات وقت تشغيل Windows الأصلي. يوفر دبيان مكتبات وقت التشغيل، ولكن يجب ألا تحل وحدة QEMU القديمة محل هذا الملف القابل للتنفيذ. تتحقق الصورة النهائية من خاصية ARM TIS `ppi` والواجهة الخلفية لـ PulseAudio وتتضمن ذاكرة القراءة فقط (ROM) لمخزن إطارات ذاكرة الوصول العشوائي (RAM). راجع [دليل وقت تشغيل الكمبيوتر الافتراضي](../deploy/windows-computer/README.ar.md) للتعرف على مسبار وقت التشغيل المحدود ومتطلبات تحديث الحفاظ على البيانات.

كل دور لديه سجل. يحافظ التقرير الفاشل على مخرجات الدور الناجحة؛ بناء الدور الفاشل فقط ودمج التقارير الناجحة لاحقًا. لا تستبدل حاوية تطوير قيد التشغيل كصورة مفقودة.

## 2. وقت تشغيل Android والكاميرا بدون حساب

تقوم الأقفال بتثبيت بنية AOSP من Google وحزمة المضيف ومدخلات kernel ومراجعات المصدر. يتم فحص التنزيلات قبل الاستخدام. لا يتم تمهيد أي ضيف أثناء التجميع.

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

بالنسبة لتصحيح APK للكاميرا، قم بتثبيت أدوات سطر أوامر Android العامة من Google، والنظام الأساسي `android-36.1`، وأدوات البناء `36.1.0`، وJDK الذي يدعم إصدار Java
8. قم بتعيين `ANDROID_SDK_ROOT` and `JDK_HOME` على أدلة الأدوات تلك. الأدوات عبارة عن تبعيات بناء، وليست ملفات تعريف مستخدم Android مُصدَّرة. في نظام ARM64 Linux، قد تكون حزمة Google `zipalign` المجمعة تعمل بنظام x86 فقط: قم بتثبيت حزمة Ubuntu's ARM64 `zipalign` وتمرير `--zipalign /usr/bin/zipalign` أدناه. D8 و apksigner هما برنامجان جافا. يمكن تشغيل إصدار APK بدلاً من ذلك على مضيف SDK منفصل مدعوم؛ انقل فقط ملفي الإخراج (`Camera2.apk`, `camera-preview.json`)، ولا تنقل مطلقًا إعدادات Android أو ملف تعريف المستخدم الخاص بهذا المضيف.

قم باستخراج ملف APK الخاص بالمخزون من بنية AOSP النظيفة (يجب أن يكون دليل الإخراج موجودًا وقابلاً للكتابة بواسطة حاوية البناء):

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

يحتفظ APK بـ **موقع اختبار AOSP العام**، وليس مفتاح المنتج الخاص. يتحقق المساعد من الشهادة الأصلية والناتجة وموارد APK التي لم تتغير، ويزيل مواد التوقيع المؤقتة. هذا ليس حسابًا أو هوية جهاز Google.

يتضمن عقد التثبيت الكامل الحالي أيضًا إصدارًا تجريبيًا من Google Android. لا يمنح قفل الإدخال العام وفحص التوقيع شهادة Google أو حقوق إعادة التوزيع. إنشاء/استخدامه فقط ضمن شروط الطرف الثالث المعمول بها؛ لا تنشر الحزمة الكاملة الناتجة كتنزيل MIT غير مقيد.

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

## 3. ملفات نموذج الناشر والوصفة العامة للتكميم

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

تستخدم جميع تنزيلات النماذج المراجعات غير القابلة للتغيير في `deploy/compute/*profile*` وتجزئة Git/LFS الخاصة بالناشر. `--cache <directory>` الاختياري للقراءة فقط ولا يقبل الملفات إلا عندما تتطابق وحدات البايت الخاصة بها مع الناشر. إنها ليست طريقة لاستيراد دليل نموذج مثبت بشكل عشوائي. تم تثبيت نص ASR المستقل MIT في إصدار Whisper الأصلي لأن لقطة النموذج المحولة تعلن الترخيص فقط. يحتفظ OCR بترخيصه الخاص، وليس MIT. تعلن بطاقات نموذج الترجمة والتضمين المثبتة عن Apache-2.0 دون شحن النص المستقل الخاص بها؛ يتضمن مساعدوهم ترخيص Apache المثبت بالمجموع الاختباري وسجل المصدر بعد التحقق من هذا الإعلان.

التنزيل المطابق المتقطع يدعم `--resume`. يستخدم `--transfer ranges` نطاقات HTTP محدودة وقابلة للاستئناف؛ يتطلب `--transfer huggingface` حزم `huggingface_hub`/`hf_xet` الرسمية ويعطل استخدام الرمز المميز. تظل الأجزاء الجزئية وذاكرة التخزين المؤقت للتنزيل خارج دلائل النماذج القابلة للنشر. المجاميع الاختبارية إلزامية مع كل وسيلة نقل. لا تقم بإضعافها بالنسبة لصفحات تسجيل الدخول/التحدي بتنسيق HTML أو التنزيلات المقتطعة.

يتم تشغيل عملية التكميم دون اتصال بالإنترنت في حاوية إنشاء منفصلة باستخدام بيانات المعايرة التركيبية العامة الخاصة بـ ModelOpt، ولا يتم تشغيل محفوظات الدردشة مطلقًا. فقط المخرجات التي تشير `build.json` إلى `quantized` يمكنها توفير `assistant-model` and `translation-model`؛ حدد الدلائل الفرعية `model/` الخاصة بهم، وليس المصادر الأولية أو مساحة عمل البناء بأكملها. بعد التحقق من صحة المدخلات، تنصح إصدارات Linux النواة بتحرير الصفحات المخزنة مؤقتًا لتلك الملفات المحددة. يؤدي هذا إلى تجنب قراءات ذاكرة GPU المجانية والمضللة على ذاكرة GB10 المشتركة؛ فهو لا يحذف الأوزان أو يمسح ذاكرة التخزين المؤقت على مستوى المضيف أو يوقف أحمال العمل. بالنسبة لوحدة معالجة الرسومات GB10 واحدة، يقوم المساعد بميزانية Linux `MemAvailable` ويحتفظ بالقدرة على المعايرة والمضيف. إنه يرفض القدرة غير الكافية بدلاً من القبول بصمت ببناء وحدة المعالجة المركزية في الغالب. عندما يتناسب النموذج الكامل، تتجنب ميزانيات ModelOpt الصريحة مسار تصدير إلغاء تحميل وحدة المعالجة المركزية غير الضروري الخاص بـ Accelerate. تقوم حاوية البناء أيضًا بتعيين ذاكرة مقفلة غير محدودة ومكدس سعة 64 ميجابايت، وفقًا لمتطلبات إطلاق التكميم [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions). يتم تحديد نطاق هذه الإعدادات ضمن حاوية البناء، وليس الحدود على مستوى المضيف.

## 4. أكمل مدخلات الحزمة

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

يجب أن يُبلغ الدمج عن **41 دورًا وعدم وجود أدوار مفقودة**. فهو يتحقق من بنية الصورة/معرفات المحتوى ويرفض المخرجات المتعارضة. تحتوي الموارد فقط على البرامج الثابتة UEFI الأولية (بما في ذلك قالب متجر متغير جديد)، وبرنامج تشغيل ISO مثبت بالمجموع الاختباري، ووقت تشغيل رسم المصدر، وإشعارات Android المرتبطة بالصور التي تم إنشاؤها حديثًا. ISO ليس وسائط تثبيت Windows. تتجنب مرآة Microsoft OpenVMM المتطابقة مع المجموع الاختباري الاعتماد على صفحة تنزيل Fedora التفاعلية.

قم بتجميع حزم المضيف باستخدام `collect_host_packages.py` كما هو موضح في [README.md](README.ar.md)، ثم قم بإنشاء القالب باستخدام `prepare-release.py --template`. املأ خريطة الصور الخاصة بها من `images.json`؛ املأ جميع أدوار الأصول الـ 12 من مخرجات النموذج، `resources/assets.json` and `guest-tools`. قم بتعيين `sourceCommit` على الخروج وإصدار الوكيل الفعلي. لا يُقبل أي عنصر نائب أو تكوين التثبيت السابق.

قم بتشغيل `prepare-release.py --inputs … --output …`، ثم `build-package.sh` باستخدام هذا الإصدار المجهز. تتطلب المصادر المعدلة/غير الملتزم بها علامة المرشح الصريحة `--allow-working-tree`؛ إنهم ليسوا التزامًا تم إصداره. راجع [PACKAGE-README.md](PACKAGE-README.ar.md) للتثبيت. تحصل قاعدة بيانات الحساب الفارغة الجديدة على `admin/admin`؛ يتم إنشاء جميع بيانات اعتماد الخدمة وهوية الجهاز بشكل مستقل. عمليات البناء وحدها لا تثبت نجاح التثبيت.

## الوصفات ذات الطبقات التاريخية وفحوصات النشر

يتم الاحتفاظ بملفات Dockerfiles التشخيصية/الطبقية الأقدم لصيانة المصدر، ولا يستخدمها خط الأنابيب هذا. لا تحتوي وسيطاتها `BUILD_PARENT_N` عمدًا على صورة افتراضية خاصة. قم بتوفير والد متوافق قمت بإنشائه، أو استخدم المسار العام أعلاه؛ لا تخمن ملخص التطوير غير المتاح.

قبل النشر، قم بتشغيل حارس المصدر والماسح السري، وقم بمراجعة السجل بشكل منفصل، واستبعاد جميع أدلة البناء والحزم وأقراص الضيوف وبيانات الحساب وموقع الويب الخاص. التقارير التي تحتوي على مسارات محلية تنتمي إلى خارج الشجرة العامة. يقتصر التحقق من هذا العمل على بناء إغلاق المدخلات وهوية القطعة الأثرية والتثبيت والحد الأدنى من مسارات الخدمة المثبتة حديثًا؛ ولا يعيد تشغيل قبول الأعمال غير ذات الصلة.
