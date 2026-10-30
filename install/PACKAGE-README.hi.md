<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.hi.md)
<!-- doc-navigation:end -->

# Team AI Box ऑफ़लाइन इंस्टॉलेशन पैकेज

मूल कोड का लाइसेंस बंडल `LICENSE` में है। तृतीय-पक्ष घटक अपने मूल लाइसेंस बनाए रखते हैं; `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json` देखें। MIT Google सेवाओं, विंडोज़, मॉडल वेट या तृतीय-पक्ष ब्रांडों के लिए कोई अतिरिक्त पुनर्वितरण अधिकार नहीं देता है। पैकेज अखंडता जांच पास करने से प्रत्येक घटक के लिए पुनर्वितरण अनुमति स्थापित नहीं होती है।

यह पैकेज एक संगत फ़ैक्टरी लिनक्स सिस्टम को बनाए रखने वाले नए DGX Spark के लिए है। यह मौजूदा डॉकर, कंपोज़ और NVIDIA GPU वातावरण को प्रतिस्थापित किए बिना या सिस्टम डिस्क को फ़ॉर्मेट किए बिना उपयोग करता है।

## स्थापना

संलग्न `.sha256` फ़ाइल का उपयोग करके संग्रह को सत्यापित करें, फिर उसे निकालें:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

सामान्य इंस्टॉलेशन के लिए न तो सार्वजनिक इंटरनेट एक्सेस की आवश्यकता होती है और न ही मैन्युअल पर्यावरण-परिवर्तनीय संपादन की। इंस्टॉलर आवश्यक बंडल टूल की आपूर्ति करता है, स्वतंत्र स्थानीय कॉन्फ़िगरेशन उत्पन्न करता है, एक नया डेटाबेस प्रारंभ करता है और सेवाएं शुरू करता है। प्रारंभिक मॉडल लोडिंग में समय लग सकता है; लोडिंग संकेतक सफल इंस्टालेशन की पुष्टि नहीं है।

बिना इंस्टाल किए परिवेश और पैकेज की जांच करने के लिए `sudo ./install.sh --check` चलाएँ। `./install.sh --verify-package` केवल पैकेज सामग्री की जांच करता है और पैकेजिंग वर्कस्टेशन पर भी चल सकता है। नया इंस्टॉलेशन रूट निर्दिष्ट करने के लिए `--installation-root /dedicated/path/installation` का उपयोग करें; इसे कभी भी मौजूदा डेटा की ओर इंगित न करें।

## रुकावटें और मौजूदा डेटा

विफलता या रुकावट के बाद, रिपोर्ट की गई समस्या का समाधान करें और मूल आदेश को दोहराएं। संस्थापन निर्देशिका को न हटाएँ. इंस्टॉलर अपने द्वारा उत्पन्न पहचान और डेटा को सुरक्षित रखता है। पूर्ण समान-संस्करण इंस्टालेशन को दोबारा चलाने से केवल उसकी स्थिति की जाँच होती है। अन्य संस्करण औपचारिक उन्नयन पथ का उपयोग करते हैं, मिटाने और पुनः स्थापित करने का नहीं। कोई बलपूर्वक अधिलेखित करने का विकल्प नहीं है.

## पहला प्रयोग

उपकरण के वर्तमान आईपी पर HTTPS पता खोलें और साइन इन करें:

- प्रशासक उपयोगकर्ता नाम: `admin`
- प्रारंभिक पासवर्ड: `admin`

इंस्टॉलर इस व्यवस्थापक को स्वचालित रूप से बनाता है; किसी सेटअप टोकन निष्कर्षण या मैन्युअल पंजीकरण की आवश्यकता नहीं है। प्रारंभिक पासवर्ड सार्वजनिक और सरल है: डिलीवरी/उपयोग से पहले इसे उपयोगकर्ता प्रबंधन में बदलें। सामान्य उपयोगकर्ताओं के पास कोई डिफ़ॉल्ट खाता नहीं होता है और वे व्यवस्थापक द्वारा बनाए जाते हैं। यह केवल खाली खाता डेटाबेस पर लागू होता है; बायोडाटा, पुन: चलाएँ, रीबूट और अपग्रेड कभी भी मौजूदा खातों या पासवर्ड को डिफ़ॉल्ट पर रीसेट नहीं करते हैं। स्वतंत्र रूप से उत्पन्न व्यवस्थापक पुनर्प्राप्ति कोड को इंस्टॉलेशन रूट के तहत `secrets/initial-owner-recovery.json` पर संग्रहीत किया जाता है, जो केवल रूट द्वारा पढ़ा जा सकता है। चैट, टिकट या सार्वजनिक लॉग पर कभी भी पुनर्प्राप्ति कोड न भेजें। मौजूदा इंस्टॉलेशन पुनर्प्राप्ति कोड उत्पन्न या प्रतिस्थापित नहीं करते हैं। स्थानीय रूप से जारी HTTPS प्रमाणपत्र के लिए, व्यवस्थापक के CA निर्देशों के अनुसार ब्राउज़र ट्रस्ट को कॉन्फ़िगर करें। प्रमाणपत्र में कोई नाम LAN DNS/mDNS रिज़ॉल्यूशन की गारंटी नहीं देता है। स्थानीय CA सार्वजनिक प्रमाणपत्र सामान्यतः `/srv/teamaibox/installation/https/ca.crt` पर होता है। केवल वह सार्वजनिक प्रमाणपत्र वितरित करें, उसके पास निजी कुंजी कभी न रखें।

इंस्टॉलेशन में मौजूदा वर्चुअल मशीन, Google लॉगिन स्थिति या उपयोगकर्ता फ़ाइलें शामिल नहीं हैं। उपयोगकर्ता विंडोज़/लिनक्स आईएसओ अपलोड करते हैं या उन्हें टीम ड्राइव से चुनते हैं, फिर अतिथि सिस्टम स्वयं स्थापित करते हैं। Google Play और बाहरी एपीआई के लिए इंटरनेट एक्सेस की आवश्यकता होती है और ये ऑफ़लाइन-उपलब्धता वादे में शामिल नहीं हैं।

घटक लाइसेंस टेक्स्ट को उनके रिलीज़ संसाधनों के साथ बनाए रखा जाता है। कॉपीराइट © Weerocks LLC। संपर्क करें: Teamaibox@weerocks.llc.
