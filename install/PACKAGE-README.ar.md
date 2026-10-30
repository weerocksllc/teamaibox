<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.ar.md)
<!-- doc-navigation:end -->

# Team AI Box حزمة التثبيت دون اتصال بالإنترنت

ترخيص الكود الأصلي موجود في الحزمة `LICENSE`. تحتفظ مكونات الطرف الثالث بتراخيصها الأصلية؛ راجع `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. لا يمنح MIT أي حقوق إعادة توزيع إضافية لخدمات Google أو Windows أو أوزان النماذج أو العلامات التجارية التابعة لجهات خارجية. لا يؤدي اجتياز اختبارات سلامة الحزمة إلى إنشاء إذن إعادة التوزيع لكل مكون.

هذه الحزمة مخصصة لـ DGX Spark الجديد الذي يحتفظ بنظام Linux المتوافق في المصنع. يستخدم بيئة Docker وCompose وNVIDIA GPU الحالية دون استبدالها أو تهيئة قرص النظام.

## التثبيت

تحقق من الأرشيف باستخدام الملف `.sha256` المصاحب، ثم استخرجه:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

لا يحتاج التثبيت العادي إلى الوصول إلى الإنترنت العام ولا إلى التعديلات اليدوية المتغيرة للبيئة. يوفر المثبت الأدوات المجمعة المطلوبة، ويقوم بإنشاء تكوين محلي مستقل، وتهيئة قاعدة بيانات جديدة وبدء الخدمات. قد يستغرق التحميل الأولي للنموذج بعض الوقت؛ مؤشر التحميل ليس تأكيدًا على التثبيت الناجح.

قم بتشغيل `sudo ./install.sh --check` للتحقق من البيئة والحزمة دون التثبيت. يقوم `./install.sh --verify-package` بالتحقق من محتويات الحزمة فقط ويمكن تشغيله أيضًا على محطة عمل التغليف. استخدم `--installation-root /dedicated/path/installation` لتحديد جذر التثبيت الجديد؛ لا تشير أبدًا إلى البيانات الموجودة.

## الانقطاعات والبيانات الموجودة

بعد حدوث فشل أو انقطاع، قم بحل المشكلة التي تم الإبلاغ عنها وكرر الأمر الأصلي. لا تقم بحذف دليل التثبيت. يحتفظ المثبت بالهوية والبيانات التي أنشأها. تؤدي إعادة تشغيل التثبيت الكامل لنفس الإصدار إلى التحقق من حالته فقط. تستخدم الإصدارات الأخرى مسار الترقية الرسمي، وليس المسح وإعادة التثبيت. لا يوجد خيار فرض الكتابة الفوقية.

## الاستخدام الأول

افتح عنوان HTTPS على عنوان IP الحالي للجهاز وقم بتسجيل الدخول:

- اسم المستخدم المسؤول: `admin`
- كلمة المرور الأولية: `admin`

يقوم المثبت بإنشاء هذا المسؤول تلقائيًا؛ ليست هناك حاجة لاستخراج الرمز المميز للإعداد أو التسجيل اليدوي. كلمة المرور الأولية عامة وبسيطة: قم بتغييرها في إدارة المستخدم قبل التسليم/الاستخدام. ليس لدى المستخدمين العاديين حساب افتراضي ويتم إنشاؤهم بواسطة المسؤول. ينطبق هذا فقط على قاعدة بيانات الحسابات الفارغة؛ الاستئناف وإعادة التشغيل وإعادة التشغيل والترقية لا تقم أبدًا بإعادة تعيين الحسابات أو كلمات المرور الحالية إلى الإعدادات الافتراضية. يتم تخزين رمز استرداد المسؤول الذي تم إنشاؤه بشكل مستقل ضمن جذر التثبيت في `secrets/initial-owner-recovery.json`، ولا يمكن قراءته إلا بواسطة الجذر. لا تقم مطلقًا بإرسال رموز الاسترداد إلى الدردشات أو التذاكر أو السجلات العامة. لا تقوم عمليات التثبيت الموجودة بإنشاء أو استبدال رموز الاسترداد. بالنسبة لشهادة HTTPS الصادرة محليًا، قم بتكوين ثقة المتصفح وفقًا لتعليمات CA الخاصة بالمسؤول. لا يضمن الاسم الموجود في الشهادة دقة LAN DNS/mDNS. عادةً ما تكون شهادة CA العامة المحلية في `/srv/teamaibox/installation/https/ca.crt`. قم بتوزيع تلك الشهادة العامة فقط، وليس المفتاح الخاص بجانبها أبدًا.

لا يتضمن التثبيت الأجهزة الافتراضية الموجودة أو حالة تسجيل الدخول إلى Google أو ملفات المستخدم. يقوم المستخدمون بتحميل ملفات ISO لنظام التشغيل Windows/Linux أو تحديدها من محرك الفريق، ثم تثبيت أنظمة الضيف بأنفسهم. تتطلب Google Play وواجهات برمجة التطبيقات الخارجية الوصول إلى الإنترنت ولا يتم تضمينها في وعد التوفر دون اتصال.

يتم الاحتفاظ بنصوص ترخيص المكونات مع موارد إصدارها. حقوق النشر © Weerocks LLC. جهة الاتصال: teamaibox@weerocks.llc.
