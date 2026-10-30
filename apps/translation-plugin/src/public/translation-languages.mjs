/**
 * Translation content languages, NOT the product's interface locales.
 * Source: https://huggingface.co/NiuTrans/LMT-60-4B#support-languages
 * LMT-60 covers 60 languages, with 234 Chinese/English-centric directions.
 * This catalog does not imply all-to-all quality or OCR/ASR language coverage.
 * Keep zh-CN for compatibility with existing translation requests.
 */
export const translationLanguages = Object.freeze([
  ['ar', 'Arabic', 'العربية'], ['en', 'English', 'English'],
  ['es', 'Spanish', 'Español'], ['de', 'German', 'Deutsch'],
  ['fr', 'French', 'Français'], ['it', 'Italian', 'Italiano'],
  ['ja', 'Japanese', '日本語'], ['nl', 'Dutch', 'Nederlands'],
  ['pl', 'Polish', 'Polski'], ['pt', 'Portuguese', 'Português'],
  ['ru', 'Russian', 'Русский'], ['tr', 'Turkish', 'Türkçe'],
  ['zh-CN', 'Chinese (Simplified)', '简体中文'],
  ['bg', 'Bulgarian', 'Български'], ['bn', 'Bengali', 'বাংলা'],
  ['cs', 'Czech', 'Čeština'], ['da', 'Danish', 'Dansk'],
  ['el', 'Greek', 'Ελληνικά'], ['fa', 'Persian', 'فارسی'],
  ['fi', 'Finnish', 'Suomi'], ['hi', 'Hindi', 'हिन्दी'],
  ['hu', 'Hungarian', 'Magyar'], ['id', 'Indonesian', 'Bahasa Indonesia'],
  ['ko', 'Korean', '한국어'], ['nb', 'Norwegian Bokmål', 'Norsk bokmål'],
  ['ro', 'Romanian', 'Română'], ['sk', 'Slovak', 'Slovenčina'],
  ['sv', 'Swedish', 'Svenska'], ['th', 'Thai', 'ไทย'],
  ['uk', 'Ukrainian', 'Українська'], ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['am', 'Amharic', 'አማርኛ'], ['az', 'Azerbaijani', 'Azərbaycanca'],
  ['bo', 'Tibetan', 'བོད་སྐད་'], ['he', 'Hebrew', 'עברית'],
  ['hr', 'Croatian', 'Hrvatski'], ['hy', 'Armenian', 'Հայերեն'],
  ['is', 'Icelandic', 'Íslenska'], ['jv', 'Javanese', 'Basa Jawa'],
  ['ka', 'Georgian', 'ქართული'], ['kk', 'Kazakh', 'Қазақ тілі'],
  ['km', 'Khmer', 'ភាសាខ្មែរ'], ['ky', 'Kyrgyz', 'Кыргызча'],
  ['lo', 'Lao', 'ລາວ'], ['mvf', 'Inner Mongolian', 'ᠮᠣᠩᠭᠣᠯ'],
  ['mr', 'Marathi', 'मराठी'], ['ms', 'Malay', 'Bahasa Melayu'],
  ['my', 'Burmese', 'မြန်မာဘာသာ'], ['ne', 'Nepali', 'नेपाली'],
  ['ps', 'Pashto', 'پښتو'], ['si', 'Sinhala', 'සිංහල'],
  ['sw', 'Swahili', 'Kiswahili'], ['ta', 'Tamil', 'தமிழ்'],
  ['te', 'Telugu', 'తెలుగు'], ['tg', 'Tajik', 'Тоҷикӣ'],
  ['tl', 'Tagalog', 'Tagalog'], ['ug', 'Uyghur', 'ئۇيغۇرچە'],
  ['ur', 'Urdu', 'اردو'], ['uz', 'Uzbek', 'Oʻzbekcha'],
  ['yue', 'Cantonese', '粵語'],
].map(([code, englishName, nativeName]) => Object.freeze({ code, englishName, nativeName })));

// Intl.DisplayNames does not yet name mvf in many browsers. Supply the specific
// language rather than silently relabeling it as generic Mongolian (mn).
const copy = Object.freeze({
  'zh-CN': ['{count} 种翻译语言', '内蒙古蒙古语', '藏语'],
  'zh-TW': ['{count} 種翻譯語言', '內蒙古蒙古語', '藏語'],
  en: ['{count} translation languages', 'Inner Mongolian', 'Tibetan'],
  ja: ['{count} 言語の翻訳に対応', '内モンゴル語', 'チベット語'],
  ko: ['번역 언어 {count}개', '내몽골어', '티베트어'],
  fr: ['{count} langues de traduction', 'Mongol de Mongolie-Intérieure', 'Tibétain'],
  de: ['{count} Übersetzungssprachen', 'Innermongolisch', 'Tibetisch'],
  es: ['{count} idiomas de traducción', 'Mongol de Mongolia Interior', 'Tibetano'],
  'pt-BR': ['{count} idiomas de tradução', 'Mongol da Mongólia Interior', 'Tibetano'],
  ru: ['{count} языков перевода', 'Внутреннемонгольский', 'Тибетский'],
  ar: ['{count} لغة للترجمة', 'المنغولية الداخلية', 'التبتية'],
  hi: ['अनुवाद की {count} भाषाएँ', 'आंतरिक मंगोलियाई', 'तिब्बती'],
  id: ['{count} bahasa terjemahan', 'Mongolia Dalam', 'Tibet'],
  it: ['{count} lingue di traduzione', 'Mongolo della Mongolia Interna', 'Tibetano'],
  tr: ['{count} çeviri dili', 'İç Moğolca', 'Tibetçe'],
  vi: ['{count} ngôn ngữ dịch', 'Tiếng Mông Cổ Nội Mông', 'Tiếng Tây Tạng'],
  th: ['ภาษาแปล {count} ภาษา', 'ภาษามองโกเลียใน', 'ภาษาทิเบต'],
});

export function translationLanguageName(code, locale = 'en') {
  const normalized = code === 'zh' ? 'zh-CN' : code === 'no' ? 'nb' : code === 'mn_cn' ? 'mvf' : code;
  const item = translationLanguages.find(language => language.code === normalized);
  if (normalized === 'mvf') return (copy[locale] ?? copy.en)[1];
  if (normalized === 'bo') return (copy[locale] ?? copy.en)[2];
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(normalized === 'zh-CN' ? 'zh-Hans' : normalized);
    if (name) return name;
  } catch { /* Older browsers still get a readable name from the model catalog. */ }
  return item?.englishName ?? code;
}

export function translationLanguageSummary(locale = 'en') {
  return (copy[locale] ?? copy.en)[0].replace('{count}', new Intl.NumberFormat(locale).format(translationLanguages.length));
}

/** Shared by text, local-file and Drive modes; changing locale keeps selections. */
export function populateTranslationLanguages(source, target, { locale = 'en', autoLabel = 'Auto' } = {}) {
  const labels = translationLanguages.map(item => {
    const name = translationLanguageName(item.code, locale);
    return { ...item, label: name === item.nativeName ? name : `${name} · ${item.nativeName}` };
  });
  const collator = new Intl.Collator(locale);
  labels.sort((a, b) => collator.compare(a.label, b.label));
  for (const [select, fallback, automatic] of [[source, '', true], [target, 'en', false]]) {
    const selected = select.value;
    const options = (automatic ? [{ code: '', label: autoLabel }] : []).concat(labels).map(item => {
      const option = select.ownerDocument.createElement('option');
      option.value = item.code;
      option.textContent = item.label;
      return option;
    });
    select.replaceChildren(...options);
    select.value = options.some(option => option.value === selected) ? selected : fallback;
  }
}
