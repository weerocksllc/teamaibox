import type {Locale} from '../i18n';
const keys=['runtime','languageServers','formatters','projectSettings','effectiveSettings','settingsPatch','applyPatch'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly [string,string,string,string,string,string,string]>={
  en:['Engine status','Language servers','Formatters','Workspace settings','Effective settings','Settings to change (JSON)','Apply changes'],
  'zh-CN':['引擎状态','语言服务','格式化工具','工作空间设置','生效设置','要修改的设置（JSON）','应用更改'],
  'zh-TW':['引擎狀態','語言服務','格式化工具','工作空間設定','生效設定','要修改的設定（JSON）','套用變更'],
  ja:['エンジンの状態','言語サーバー','フォーマッター','ワークスペース設定','有効な設定','変更する設定（JSON）','変更を適用'],
  ko:['엔진 상태','언어 서버','포맷 도구','작업 공간 설정','적용된 설정','변경할 설정 (JSON)','변경 적용'],
  fr:['État du moteur','Serveurs de langage','Outils de formatage','Paramètres de l’espace de travail','Paramètres effectifs','Paramètres à modifier (JSON)','Appliquer les modifications'],
  de:['Engine-Status','Sprachserver','Formatierer','Arbeitsbereichseinstellungen','Wirksame Einstellungen','Zu ändernde Einstellungen (JSON)','Änderungen anwenden'],
  es:['Estado del motor','Servidores de lenguaje','Formateadores','Ajustes del espacio de trabajo','Ajustes efectivos','Ajustes a modificar (JSON)','Aplicar cambios'],
  'pt-BR':['Estado do mecanismo','Servidores de linguagem','Formatadores','Configurações do espaço de trabalho','Configurações efetivas','Configurações a alterar (JSON)','Aplicar alterações'],
  ru:['Состояние движка','Языковые серверы','Форматирование','Настройки рабочей области','Действующие настройки','Изменяемые настройки (JSON)','Применить изменения'],
  ar:['حالة المحرك','خوادم اللغة','أدوات التنسيق','إعدادات مساحة العمل','الإعدادات الفعلية','الإعدادات المراد تغييرها (JSON)','تطبيق التغييرات'],
  hi:['इंजन की स्थिति','भाषा सर्वर','फ़ॉर्मैटर','कार्यस्थान सेटिंग','प्रभावी सेटिंग','बदलने वाली सेटिंग (JSON)','बदलाव लागू करें'],
  id:['Status mesin','Server bahasa','Pemformat','Pengaturan ruang kerja','Pengaturan efektif','Pengaturan yang diubah (JSON)','Terapkan perubahan'],
  it:['Stato del motore','Server di linguaggio','Formattatori','Impostazioni area di lavoro','Impostazioni effettive','Impostazioni da modificare (JSON)','Applica modifiche'],
  tr:['Motor durumu','Dil sunucuları','Biçimlendiriciler','Çalışma alanı ayarları','Etkin ayarlar','Değiştirilecek ayarlar (JSON)','Değişiklikleri uygula'],
  vi:['Trạng thái động cơ','Máy chủ ngôn ngữ','Trình định dạng','Cài đặt không gian làm việc','Cài đặt có hiệu lực','Cài đặt cần thay đổi (JSON)','Áp dụng thay đổi'],
  th:['สถานะเอนจิน','เซิร์ฟเวอร์ภาษา','เครื่องมือจัดรูปแบบ','การตั้งค่าพื้นที่ทำงาน','การตั้งค่าที่มีผล','การตั้งค่าที่ต้องการเปลี่ยน (JSON)','ใช้การเปลี่ยนแปลง'],
};
export const nativeSettingsKeys=keys;
export function nativeSettingsText(locale:Locale,key:Key){return copy[locale][keys.indexOf(key)];}
