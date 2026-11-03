import type {Locale} from '../i18n';
const keys=['browse','search','all','current','archived','more','empty','paths','queued','patch'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly string[]>={
  en:['Find conversations','Search titles','All workspaces','Current workspace','Include archived','Load more','No conversations found','Runtime paths','Queued','Download patch'],
  'zh-CN':['查找会话','搜索标题','全部工作空间','当前工作空间','包含已归档','加载更多','没有找到会话','运行时路径','待处理','下载补丁'],
  'zh-TW':['尋找對話','搜尋標題','全部工作空間','目前工作空間','包含已封存','載入更多','找不到對話','執行環境路徑','待處理','下載修補檔'],
  ja:['会話を探す','タイトルを検索','すべてのワークスペース','現在のワークスペース','アーカイブを含む','さらに読み込む','会話が見つかりません','実行環境のパス','処理待ち','パッチをダウンロード'],
  ko:['대화 찾기','제목 검색','모든 작업 공간','현재 작업 공간','보관된 대화 포함','더 불러오기','대화가 없습니다','런타임 경로','처리 대기','패치 다운로드'],
  fr:['Rechercher des conversations','Rechercher un titre','Tous les espaces','Espace actuel','Inclure les archives','Charger plus','Aucune conversation','Chemins du moteur','En attente','Télécharger le patch'],
  de:['Unterhaltungen suchen','Titel suchen','Alle Arbeitsbereiche','Aktueller Arbeitsbereich','Archivierte einschließen','Mehr laden','Keine Unterhaltungen gefunden','Laufzeitpfade','In Warteschlange','Patch herunterladen'],
  es:['Buscar conversaciones','Buscar títulos','Todos los espacios','Espacio actual','Incluir archivadas','Cargar más','No hay conversaciones','Rutas del motor','En espera','Descargar parche'],
  'pt-BR':['Buscar conversas','Pesquisar títulos','Todos os espaços','Espaço atual','Incluir arquivadas','Carregar mais','Nenhuma conversa encontrada','Caminhos do ambiente','Na fila','Baixar patch'],
  ru:['Найти беседы','Поиск по заголовку','Все рабочие области','Текущая рабочая область','Включить архивные','Загрузить ещё','Беседы не найдены','Пути среды','В очереди','Скачать патч'],
  ar:['البحث عن المحادثات','البحث في العناوين','كل مساحات العمل','مساحة العمل الحالية','تضمين المؤرشفة','تحميل المزيد','لا توجد محادثات','مسارات بيئة التشغيل','قيد الانتظار','تنزيل التصحيح'],
  hi:['बातचीत खोजें','शीर्षक खोजें','सभी कार्यस्थान','वर्तमान कार्यस्थान','संग्रहीत शामिल करें','और लोड करें','कोई बातचीत नहीं मिली','रनटाइम पथ','कतार में','पैच डाउनलोड करें'],
  id:['Cari percakapan','Cari judul','Semua ruang kerja','Ruang kerja saat ini','Sertakan arsip','Muat lagi','Percakapan tidak ditemukan','Jalur runtime','Dalam antrean','Unduh patch'],
  it:['Cerca conversazioni','Cerca titoli','Tutti gli spazi','Spazio attuale','Includi archiviate','Carica altro','Nessuna conversazione','Percorsi del motore','In coda','Scarica patch'],
  tr:['Konuşma bul','Başlık ara','Tüm çalışma alanları','Geçerli çalışma alanı','Arşivlenenleri dahil et','Daha fazla yükle','Konuşma bulunamadı','Çalışma zamanı yolları','Sırada','Yamayı indir'],
  vi:['Tìm cuộc trò chuyện','Tìm tiêu đề','Mọi không gian làm việc','Không gian hiện tại','Gồm mục lưu trữ','Tải thêm','Không tìm thấy cuộc trò chuyện','Đường dẫn môi trường','Đang chờ','Tải bản vá'],
  th:['ค้นหาการสนทนา','ค้นหาชื่อ','พื้นที่ทำงานทั้งหมด','พื้นที่ทำงานปัจจุบัน','รวมที่เก็บถาวร','โหลดเพิ่มเติม','ไม่พบการสนทนา','เส้นทางสภาพแวดล้อม','รอดำเนินการ','ดาวน์โหลดแพตช์'],
};
export function nativeSessionText(locale:Locale,key:Key){return copy[locale][keys.indexOf(key)];}
