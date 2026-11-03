import type {Locale} from '../i18n';
const keys=['catalog','tools','resources','parameters','empty','capabilities'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly [string,string,string,string,string,string]>={
  en:['Tools and resources','Default agent tools','MCP resources','Parameters','No entries','Experimental capabilities'],
  'zh-CN':['工具与资源','默认 Agent 工具','MCP 资源','参数','暂无条目','实验性能力'],
  'zh-TW':['工具與資源','預設 Agent 工具','MCP 資源','參數','暫無項目','實驗性功能'],
  ja:['ツールとリソース','既定エージェントのツール','MCP リソース','パラメーター','項目なし','実験的な機能'],
  ko:['도구 및 리소스','기본 에이전트 도구','MCP 리소스','매개변수','항목 없음','실험적 기능'],
  fr:['Outils et ressources','Outils de l’agent par défaut','Ressources MCP','Paramètres','Aucune entrée','Fonctionnalités expérimentales'],
  de:['Werkzeuge und Ressourcen','Werkzeuge des Standardagenten','MCP-Ressourcen','Parameter','Keine Einträge','Experimentelle Funktionen'],
  es:['Herramientas y recursos','Herramientas del agente predeterminado','Recursos MCP','Parámetros','Sin entradas','Funciones experimentales'],
  'pt-BR':['Ferramentas e recursos','Ferramentas do agente padrão','Recursos MCP','Parâmetros','Nenhuma entrada','Recursos experimentais'],
  ru:['Инструменты и ресурсы','Инструменты агента по умолчанию','Ресурсы MCP','Параметры','Нет записей','Экспериментальные возможности'],
  ar:['الأدوات والموارد','أدوات الوكيل الافتراضي','موارد MCP','المعلمات','لا توجد عناصر','ميزات تجريبية'],
  hi:['उपकरण और संसाधन','डिफ़ॉल्ट एजेंट के उपकरण','MCP संसाधन','पैरामीटर','कोई प्रविष्टि नहीं','प्रयोगात्मक क्षमताएँ'],
  id:['Alat dan sumber daya','Alat agen bawaan','Sumber daya MCP','Parameter','Tidak ada entri','Kemampuan eksperimental'],
  it:['Strumenti e risorse','Strumenti dell’agente predefinito','Risorse MCP','Parametri','Nessuna voce','Funzionalità sperimentali'],
  tr:['Araçlar ve kaynaklar','Varsayılan ajan araçları','MCP kaynakları','Parametreler','Kayıt yok','Deneysel özellikler'],
  vi:['Công cụ và tài nguyên','Công cụ của tác nhân mặc định','Tài nguyên MCP','Tham số','Không có mục','Khả năng thử nghiệm'],
  th:['เครื่องมือและทรัพยากร','เครื่องมือของเอเจนต์เริ่มต้น','ทรัพยากร MCP','พารามิเตอร์','ไม่มีรายการ','ความสามารถทดลอง'],
};
export function nativeCatalogText(locale:Locale,key:Key){return copy[locale][keys.indexOf(key)];}
