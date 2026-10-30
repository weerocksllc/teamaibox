<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.hi.md)
<!-- doc-navigation:end -->

# सार्वजनिक स्रोत से एक उपकरण बनाएं

नया ऑर्केस्ट्रेशन प्रवेश बिंदु [SOURCE-INSTALL.md](SOURCE-INSTALL.hi.md) में प्रलेखित है। यह नीचे दी गई रेसिपी को स्वचालित करता है; इसकी पूर्ण-उपकरण सत्यापन स्थिति वहां बताई गई है। ये मैनुअल नुस्खे अनुरक्षकों और व्यक्तिगत चरण निदान के लिए उपलब्ध रहते हैं।

यह स्रोत-से-पैकेज पथ है. यह पिछले Team AI Box इंस्टॉलेशन, उसके कंटेनर, खाते, प्रमाणपत्र, अतिथि या डेटाबेस को आयात नहीं करता है। बिल्ड मशीन को इंटरनेट एक्सेस की आवश्यकता है; परिणामी पूर्ण पैकेज ऑफ़लाइन स्थापित होता है। ग्राहक विंडोज़/लिनक्स इंस्टालेशन मीडिया की आपूर्ति अलग से करता है।

Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 और स्रोत डाउनलोड, बिल्ड लेयर्स और अंतिम असम्पीडित बंडल के लिए पर्याप्त डिस्क स्थान का उपयोग करें। मॉडल परिमाणीकरण के लिए पर्याप्त मुफ्त मेमोरी के साथ एक संगत NVIDIA GPU की भी आवश्यकता होती है। मशीन मालिक की अनुमति के बिना उस मेमोरी को प्राप्त करने के लिए अन्य कार्यभार को न रोकें। डॉकर और NVIDIA पूर्वापेक्षाएँ हैं, इंस्टॉलर द्वारा प्रतिस्थापित घटक नहीं।

नए सार्वजनिक चेकआउट से आदेश चलाएँ। `BUILD` को चेकआउट के **बाहर** एक नई, पूर्ण बिल्ड निर्देशिका पर सेट करें। आउटपुट, मॉडल और रिपोर्ट प्रतिबद्ध नहीं होने चाहिए। प्रत्येक सहायक किसी कब्जे वाले आउटपुट को तब तक अस्वीकार कर देता है जब तक कि वह एक विशिष्ट बायोडाटा ऑपरेशन का दस्तावेजीकरण न कर दे। सफल रिपोर्ट के संदर्भ/आईडी का उपयोग करें, न कि किसी और की मशीन से कॉपी किए गए छवि नामों का। स्थानीय डॉकर सामग्री आईडी डाउनलोड करने योग्य रजिस्ट्री संदर्भ नहीं है; Dockerfile पैरेंट तर्कों को संबंधित स्थानीय टैग या योग्य अपस्ट्रीम डाइजेस्ट की आवश्यकता होती है।

## 1. सेवाएँ और अनुप्रयोग

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

`--network host` ऑनलाइन **बिल्ड** को प्रभावित करता है, स्थापित सेवा नेटवर्किंग को नहीं। नोड निर्भरता चरण 250 एमएस के नोड डिफ़ॉल्ट के बजाय प्रति कनेक्शन प्रयास 2 सेकंड की अनुमति देते हैं। यह आधिकारिक एनपीएम डाउनलोड को उच्च-विलंबता लिंक पर प्रयोग करने योग्य रखता है, जिसमें उपयोगकर्ता-प्रबंधित वीपीएन भी शामिल है, बिना रजिस्ट्रियों को स्विच किए, आईपीवी 6 को अक्षम किए बिना या टीएलएस/पैकेज अखंडता जांच को कमजोर किए बिना। सेटिंग एक बिल्ड-स्टेज तर्क है, इंस्टॉल किए गए एप्लिकेशन में पर्यावरण परिवर्तन नहीं। धीमे लिंक के लिए, प्रत्यक्ष डॉकर बिल्ड `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000` को ओवरराइड कर सकता है। वेब छवि अपनी स्वयं की बंद निर्भरताएँ और संपत्तियाँ बनाती है। नोड सेवाएँ नव निर्मित एपीआई निर्भरता क्लोजर को साझा करती हैं। ओसीआर में इसका सार्वजनिक एडाप्टर शामिल है; इसे किसी अन्य प्रोजेक्ट से अप्रकाशित वर्कर पैकेज की आवश्यकता नहीं है। अनुवाद पिन की गई सार्वजनिक NVIDIA vLLM छवि का उपयोग करता है। एंबेडिंग, बैच एएसआर और कास्टिंग मीडिया जानबूझकर अपनी संबंधित सार्वजनिक रनटाइम छवियां साझा करते हैं। कंप्यूटर छवि मूल विंडोज़ रनटाइम की क्षमताओं को संरक्षित करते हुए, एआरएम टीपीएम/पीपीआई, केवीएम, वीएनसी और पल्सऑडियो समर्थन के साथ हस्ताक्षर-सत्यापित क्यूईएमयू 11.1.1 बनाती है। डेबियन रनटाइम लाइब्रेरीज़ की आपूर्ति करता है, लेकिन इसके पुराने पैकेज्ड QEMU को इस निष्पादन योग्य को प्रतिस्थापित नहीं करना चाहिए। अंतिम छवि ARM TIS `ppi` प्रॉपर्टी और पल्सऑडियो बैकएंड दोनों की जांच करती है और इसमें मिलान रैम फ्रेमबफर ROM शामिल है। बाउंडेड रनटाइम जांच और डेटा-संरक्षण अद्यतन आवश्यकताओं के लिए [वर्चुअल-कंप्यूटर रनटाइम गाइड](../deploy/windows-computer/README.hi.md) देखें।

प्रत्येक भूमिका में एक लॉग होता है. एक असफल रिपोर्ट सफल भूमिका आउटपुट को सुरक्षित रखती है; केवल विफल भूमिका बनाएँ और सफल रिपोर्ट को बाद में मर्ज करें। चल रहे डेवलपमेंट कंटेनर को गुम छवि के रूप में प्रतिस्थापित न करें।

## 2. खाता-मुक्त एंड्रॉइड और कैमरा रनटाइम

ताले Google के AOSP बिल्ड, होस्ट पैकेज, कर्नेल इनपुट और स्रोत संशोधन को पिन करते हैं। उपयोग से पहले डाउनलोड की जाँच की जाती है। सभा के दौरान किसी भी अतिथि को बूट नहीं दिया जाएगा।

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

कैमरा एपीके पैच के लिए, Google के सार्वजनिक एंड्रॉइड कमांड-लाइन टूल, प्लेटफ़ॉर्म `android-36.1`, बिल्ड-टूल्स `36.1.0` और जावा रिलीज़ का समर्थन करने वाला JDK इंस्टॉल करें।
8. उन टूल निर्देशिकाओं पर `ANDROID_SDK_ROOT` and `JDK_HOME` सेट करें। उपकरण निर्भरताएँ बनाते हैं, निर्यातित Android उपयोगकर्ता प्रोफ़ाइल नहीं। ARM64 Linux पर, Google का बंडल किया गया `zipalign` केवल x86 हो सकता है: Ubuntu का ARM64 `zipalign` पैकेज इंस्टॉल करें और नीचे `--zipalign /usr/bin/zipalign` पास करें। D8 और apksigner जावा प्रोग्राम हैं। एपीके बिल्ड वैकल्पिक रूप से एक अलग समर्थित एसडीके होस्ट पर चल सकता है; केवल इसकी दो आउटपुट फ़ाइलें (`Camera2.apk`, `camera-preview.json`) स्थानांतरित करें, उस होस्ट की एंड्रॉइड सेटिंग्स या उपयोगकर्ता प्रोफ़ाइल कभी नहीं।

स्वच्छ एओएसपी बिल्ड से स्टॉक एपीके निकालें (आउटपुट निर्देशिका मौजूद होनी चाहिए और बिल्ड कंटेनर द्वारा लिखने योग्य होनी चाहिए):

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

एपीके ज्ञात **सार्वजनिक AOSP परीक्षण हस्ताक्षरकर्ता** को रखता है, निजी उत्पाद कुंजी को नहीं। सहायक मूल और परिणामी प्रमाणपत्र और अपरिवर्तित एपीके संसाधनों का सत्यापन करता है, और अस्थायी हस्ताक्षर सामग्री को हटा देता है। यह कोई खाता या Google डिवाइस पहचान नहीं है.

वर्तमान पूर्ण इंस्टॉलर अनुबंध में एक प्रयोगात्मक Google Android संस्करण भी शामिल है। इसका सार्वजनिक इनपुट लॉक और हस्ताक्षर निरीक्षण Google प्रमाणन या पुनर्वितरण अधिकार **नहीं** प्रदान करता है। इसे केवल लागू तृतीय-पक्ष शर्तों के भीतर ही बनाएं/उपयोग करें; परिणामी पूर्ण बंडल को अप्रतिबंधित MIT डाउनलोड के रूप में प्रकाशित न करें।

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

## 3. प्रकाशक मॉडल फ़ाइलें और सार्वजनिक परिमाणीकरण नुस्खा

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

सभी मॉडल डाउनलोड `deploy/compute/*profile*` में अपरिवर्तनीय संशोधन और प्रकाशक के Git/LFS हैश का उपयोग करते हैं। वैकल्पिक `--cache <directory>` केवल पढ़ने के लिए है और फ़ाइलें तभी स्वीकार करता है जब उनके बाइट्स प्रकाशक से मेल खाते हों। यह किसी स्थापित मॉडल निर्देशिका को अंधाधुंध आयात करने का एक तरीका नहीं है। ASR का स्टैंडअलोन MIT टेक्स्ट मूल व्हिस्पर रिलीज़ पर पिन किया गया है क्योंकि परिवर्तित मॉडल स्नैपशॉट केवल लाइसेंस की घोषणा करता है। OCR अपना स्वयं का लाइसेंस रखता है, MIT नहीं। पिन किए गए अनुवाद और एम्बेडिंग मॉडल कार्ड अपने स्टैंडअलोन टेक्स्ट को शिपिंग किए बिना Apache-2.0 घोषित करते हैं; उनके सहायकों में चेकसम-पिन किए गए अपाचे लाइसेंस और उस घोषणा की जांच के बाद एक उद्गम रिकॉर्ड शामिल है।

एक बाधित मिलान डाउनलोड `--resume` का समर्थन करता है। `--transfer ranges` सीमित पुन: प्रारंभ करने योग्य HTTP श्रेणियों का उपयोग करता है; `--transfer huggingface` को आधिकारिक `huggingface_hub`/`hf_xet` पैकेज की आवश्यकता है और टोकन उपयोग अक्षम करता है। आंशिक और डाउनलोड कैश प्रकाशन योग्य मॉडल निर्देशिकाओं के बाहर रहते हैं। प्रत्येक परिवहन के साथ चेकसम अनिवार्य है। HTML लॉगिन/चुनौती पृष्ठों या काटे गए डाउनलोड के लिए उन्हें कमजोर न करें।

मॉडलऑप्ट के सार्वजनिक सिंथेटिक अंशांकन डेटा का उपयोग करके क्वांटाइजेशन एक अलग बिल्ड कंटेनर में ऑफ़लाइन चलता है, कभी भी चैट इतिहास नहीं। केवल वे आउटपुट जिनके `build.json` कहते हैं कि `quantized` `assistant-model` and `translation-model` की आपूर्ति कर सकते हैं; उनकी `model/` उपनिर्देशिकाएँ चुनें, न कि कच्चे स्रोत या संपूर्ण बिल्ड कार्यक्षेत्र। इनपुट को मान्य करने के बाद, लिनक्स बिल्ड कर्नेल को उन विशिष्ट फ़ाइलों के कैश्ड पृष्ठों को जारी करने की सलाह देता है। यह GB10 की साझा मेमोरी पर तुरंत-मुक्त GPU मेमोरी रीडिंग को गुमराह करने से बचाता है; यह वज़न नहीं हटाता, होस्ट-वाइड कैश साफ़ नहीं करता, या कार्यभार नहीं रोकता। एक GB10 GPU के लिए, सहायक लिनक्स `MemAvailable` से बजट लेता है और अंशांकन और होस्ट के लिए क्षमता आरक्षित करता है। यह अधिकतर-सीपीयू निर्माण को चुपचाप स्वीकार करने के बजाय अपर्याप्त क्षमता से इनकार करता है। जब पूरा मॉडल फिट बैठता है, तो स्पष्ट मॉडलऑप्ट बजट एक्सेलेरेट के अनावश्यक सीपीयू-ऑफलोड निर्यात पथ से बचते हैं। बिल्ड कंटेनर [NVIDIA की क्वांटाइजेशन लॉन्च आवश्यकताओं](https://build.nvidia.com/spark/nvfp4-quantization/instructions) का पालन करते हुए असीमित लॉक्ड मेमोरी और 64 MiB स्टैक भी सेट करता है। ये सेटिंग्स बिल्ड कंटेनर तक सीमित हैं, होस्ट-वाइड सीमाओं पर नहीं।

## 4. पूरा पैकेज इनपुट

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

विलय में **41 भूमिकाएँ और कोई लुप्त भूमिका नहीं** की सूचना दी जानी चाहिए। यह छवि वास्तुकला/सामग्री आईडी को सत्यापित करता है और परस्पर विरोधी आउटपुट को अस्वीकार करता है। संसाधनों में केवल अपस्ट्रीम यूईएफआई फर्मवेयर (एक ताजा वैरिएबल-स्टोर टेम्पलेट समेत), एक चेकसम-पिन किए गए वर्टियो ड्राइवर आईएसओ, स्रोत ड्राइंग रनटाइम और नव निर्मित छवियों से जुड़े एंड्रॉइड नोटिस शामिल हैं। ISO विंडोज़ इंस्टालेशन मीडिया नहीं है. इसका चेकसम-समरूप माइक्रोसॉफ्ट ओपनवीएमएम मिरर एक इंटरैक्टिव फेडोरा डाउनलोड पेज पर निर्भर होने से बचाता है।

जैसा कि [README.md](README.hi.md) में बताया गया है, `collect_host_packages.py` के साथ होस्ट पैकेज इकट्ठा करें, फिर `prepare-release.py --template` के साथ टेम्पलेट तैयार करें। `images.json` से इसका छवि मानचित्र भरें; मॉडल आउटपुट, `resources/assets.json` and `guest-tools` से सभी 12 परिसंपत्ति भूमिकाएँ भरें। चेकआउट और वास्तविक एजेंट संस्करण पर `sourceCommit` सेट करें। कोई प्लेसहोल्डर या पिछला इंस्टॉलेशन कॉन्फ़िगरेशन स्वीकार्य नहीं है.

उस तैयार रिलीज़ का उपयोग करके पहले `prepare-release.py --inputs … --output …` चलाएँ, फिर `build-package.sh` चलाएँ। संशोधित/अप्रतिबद्ध स्रोतों के लिए स्पष्ट `--allow-working-tree` उम्मीदवार ध्वज की आवश्यकता होती है; वे कोई जारी प्रतिबद्धता नहीं हैं। इंस्टालेशन के लिए [PACKAGE-README.md](PACKAGE-README.hi.md) देखें। एक नया रिक्त खाता डेटाबेस `admin/admin` प्राप्त होता है; सभी सेवा क्रेडेंशियल और डिवाइस पहचान स्वतंत्र रूप से उत्पन्न होती हैं। अकेले निर्माण यह साबित नहीं करता कि स्थापना सफल रही।

## ऐतिहासिक स्तरित व्यंजन और प्रकाशन जाँच

पुराने डायग्नोस्टिक/स्तरित डॉकरफ़ाइल्स को स्रोत रखरखाव के लिए बनाए रखा जाता है, इस पाइपलाइन द्वारा उपयोग नहीं किया जाता है। उनके `BUILD_PARENT_N` तर्कों में जानबूझकर कोई निजी छवि डिफ़ॉल्ट नहीं है। आपके द्वारा बनाए गए संगत माता-पिता की आपूर्ति करें, या उपरोक्त सार्वजनिक पाइपलाइन का उपयोग करें; अनुपलब्ध विकास डाइजेस्ट का अनुमान न लगाएं।

प्रकाशन से पहले, स्रोत गार्ड और गुप्त स्कैनर चलाएं, इतिहास की अलग से समीक्षा करें, और सभी बिल्ड निर्देशिकाओं, पैकेजों, अतिथि डिस्क, खाता डेटा और निजी वेबसाइट को बाहर कर दें। स्थानीय पथों वाली रिपोर्टें सार्वजनिक वृक्ष के बाहर होती हैं। इस कार्य के लिए सत्यापन इनपुट क्लोजर, आर्टिफैक्ट पहचान, इंस्टॉलेशन और नए स्थापित न्यूनतम सेवा पथ बनाने तक सीमित है; यह असंबंधित व्यावसायिक स्वीकृति को दोबारा नहीं चलाता है।
