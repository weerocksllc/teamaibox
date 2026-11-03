import type {Locale} from '../i18n';
const keys=['projects','projectName','initializeGit','initializeConfirm','searchFiles','searchText','search','noResults','invalidWorkspace'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly [string,string,string,string,string,string,string,string,string]>={
  en:['Projects','Project name','Initialize Git','Initialize a Git repository in this workspace? Existing files are kept.','Find files','Search file contents','Search','No results','Choose an existing directory inside /workspace.'],
  'zh-CN':['项目','项目名称','初始化 Git','在此工作空间初始化 Git 仓库？现有文件会保留。','查找文件','搜索文件内容','搜索','没有结果','请选择 /workspace 内的现有目录。'],
  'zh-TW':['專案','專案名稱','初始化 Git','在此工作空間初始化 Git 儲存庫？現有檔案會保留。','尋找檔案','搜尋檔案內容','搜尋','沒有結果','請選擇 /workspace 內的現有目錄。'],
  ja:['プロジェクト','プロジェクト名','Git を初期化','このワークスペースで Git リポジトリを初期化しますか？既存のファイルは保持されます。','ファイルを探す','ファイル内容を検索','検索','結果なし','/workspace 内の既存のディレクトリを選択してください。'],
  ko:['프로젝트','프로젝트 이름','Git 초기화','이 작업 공간에 Git 저장소를 초기화할까요? 기존 파일은 유지됩니다.','파일 찾기','파일 내용 검색','검색','결과 없음','/workspace 안의 기존 디렉터리를 선택하세요.'],
  fr:['Projets','Nom du projet','Initialiser Git','Initialiser un dépôt Git dans cet espace ? Les fichiers existants sont conservés.','Rechercher des fichiers','Rechercher dans les fichiers','Rechercher','Aucun résultat','Choisissez un répertoire existant dans /workspace.'],
  de:['Projekte','Projektname','Git initialisieren','Git-Repository in diesem Arbeitsbereich initialisieren? Vorhandene Dateien bleiben erhalten.','Dateien finden','Dateiinhalte durchsuchen','Suchen','Keine Ergebnisse','Wählen Sie ein vorhandenes Verzeichnis unter /workspace.'],
  es:['Proyectos','Nombre del proyecto','Inicializar Git','¿Inicializar un repositorio Git aquí? Se conservan los archivos existentes.','Buscar archivos','Buscar contenido de archivos','Buscar','Sin resultados','Seleccione un directorio existente en /workspace.'],
  'pt-BR':['Projetos','Nome do projeto','Inicializar Git','Inicializar um repositório Git neste espaço? Os arquivos existentes serão mantidos.','Encontrar arquivos','Pesquisar conteúdo dos arquivos','Pesquisar','Nenhum resultado','Escolha um diretório existente dentro de /workspace.'],
  ru:['Проекты','Название проекта','Инициализировать Git','Создать репозиторий Git в этой рабочей области? Существующие файлы сохранятся.','Найти файлы','Поиск по содержимому','Поиск','Нет результатов','Выберите существующий каталог внутри /workspace.'],
  ar:['المشاريع','اسم المشروع','تهيئة Git','تهيئة مستودع Git في مساحة العمل هذه؟ ستبقى الملفات الحالية.','البحث عن ملفات','البحث في محتوى الملفات','بحث','لا توجد نتائج','اختر مجلدًا موجودًا داخل /workspace.'],
  hi:['प्रोजेक्ट','प्रोजेक्ट का नाम','Git प्रारंभ करें','इस कार्यस्थान में Git रिपॉज़िटरी प्रारंभ करें? मौजूदा फ़ाइलें सुरक्षित रहेंगी।','फ़ाइलें खोजें','फ़ाइल की सामग्री खोजें','खोजें','कोई परिणाम नहीं','/workspace के अंदर मौजूदा डायरेक्टरी चुनें।'],
  id:['Proyek','Nama proyek','Inisialisasi Git','Inisialisasi repositori Git di ruang kerja ini? Berkas yang ada tetap disimpan.','Cari berkas','Cari isi berkas','Cari','Tidak ada hasil','Pilih direktori yang sudah ada di dalam /workspace.'],
  it:['Progetti','Nome del progetto','Inizializza Git','Inizializzare un repository Git in questa area? I file esistenti saranno conservati.','Trova file','Cerca nei contenuti dei file','Cerca','Nessun risultato','Scegli una directory esistente in /workspace.'],
  tr:['Projeler','Proje adı','Git başlat','Bu çalışma alanında Git deposu başlatılsın mı? Mevcut dosyalar korunur.','Dosya bul','Dosya içeriğinde ara','Ara','Sonuç yok','/workspace içinde mevcut bir dizin seçin.'],
  vi:['Dự án','Tên dự án','Khởi tạo Git','Khởi tạo kho Git trong không gian này? Các tệp hiện có được giữ nguyên.','Tìm tệp','Tìm nội dung tệp','Tìm kiếm','Không có kết quả','Chọn thư mục hiện có trong /workspace.'],
  th:['โครงการ','ชื่อโครงการ','เริ่มต้น Git','เริ่มต้นคลัง Git ในพื้นที่นี้หรือไม่? ไฟล์เดิมจะยังคงอยู่','ค้นหาไฟล์','ค้นหาเนื้อหาไฟล์','ค้นหา','ไม่พบผลลัพธ์','เลือกไดเรกทอรีที่มีอยู่ภายใน /workspace'],
};
export const nativeProjectKeys=keys;
export function nativeProjectText(locale:Locale,key:Key){return copy[locale][keys.indexOf(key)];}
