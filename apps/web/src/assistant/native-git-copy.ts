import type {Locale} from '../i18n';
const keys=['title','working','branch','refresh','empty','gitRequired','unavailable'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly [string,string,string,string,string,string,string]>={
  en:['Git changes','Uncommitted changes','Compare with default branch','Refresh','No changes','Open a Git project to view changes.','No default branch is available for comparison.'],
  'zh-CN':['Git 更改','未提交的更改','与默认分支比较','刷新','没有更改','打开 Git 项目以查看更改。','没有可用于比较的默认分支。'],
  'zh-TW':['Git 變更','尚未提交的變更','與預設分支比較','重新整理','沒有變更','開啟 Git 專案以檢視變更。','沒有可用於比較的預設分支。'],
  ja:['Git の変更','未コミットの変更','既定ブランチと比較','更新','変更なし','変更を見るには Git プロジェクトを開いてください。','比較できる既定ブランチがありません。'],
  ko:['Git 변경 사항','커밋하지 않은 변경 사항','기본 브랜치와 비교','새로고침','변경 사항 없음','변경 사항을 보려면 Git 프로젝트를 여세요.','비교할 기본 브랜치가 없습니다.'],
  fr:['Modifications Git','Modifications non validées','Comparer à la branche par défaut','Actualiser','Aucune modification','Ouvrez un projet Git pour voir les modifications.','Aucune branche par défaut disponible pour la comparaison.'],
  de:['Git-Änderungen','Nicht committete Änderungen','Mit Standardbranch vergleichen','Aktualisieren','Keine Änderungen','Öffnen Sie ein Git-Projekt, um Änderungen anzuzeigen.','Kein Standardbranch für den Vergleich verfügbar.'],
  es:['Cambios de Git','Cambios sin confirmar','Comparar con la rama predeterminada','Actualizar','Sin cambios','Abre un proyecto Git para ver los cambios.','No hay una rama predeterminada disponible para comparar.'],
  'pt-BR':['Alterações do Git','Alterações não commitadas','Comparar com o branch padrão','Atualizar','Nenhuma alteração','Abra um projeto Git para ver as alterações.','Nenhum branch padrão disponível para comparação.'],
  ru:['Изменения Git','Незакоммиченные изменения','Сравнить с основной веткой','Обновить','Нет изменений','Откройте проект Git для просмотра изменений.','Основная ветка для сравнения недоступна.'],
  ar:['تغييرات Git','تغييرات غير ملتزم بها','مقارنة بالفرع الافتراضي','تحديث','لا توجد تغييرات','افتح مشروع Git لعرض التغييرات.','لا يوجد فرع افتراضي متاح للمقارنة.'],
  hi:['Git परिवर्तन','कमिट नहीं किए गए परिवर्तन','डिफ़ॉल्ट शाखा से तुलना','रीफ़्रेश','कोई परिवर्तन नहीं','परिवर्तन देखने के लिए Git प्रोजेक्ट खोलें।','तुलना के लिए कोई डिफ़ॉल्ट शाखा उपलब्ध नहीं है।'],
  id:['Perubahan Git','Perubahan belum di-commit','Bandingkan dengan cabang bawaan','Muat ulang','Tidak ada perubahan','Buka proyek Git untuk melihat perubahan.','Tidak ada cabang bawaan untuk dibandingkan.'],
  it:['Modifiche Git','Modifiche non committate','Confronta con il ramo predefinito','Aggiorna','Nessuna modifica','Apri un progetto Git per visualizzare le modifiche.','Nessun ramo predefinito disponibile per il confronto.'],
  tr:['Git değişiklikleri','Commit edilmemiş değişiklikler','Varsayılan dalla karşılaştır','Yenile','Değişiklik yok','Değişiklikleri görmek için bir Git projesi açın.','Karşılaştırılacak varsayılan dal yok.'],
  vi:['Thay đổi Git','Thay đổi chưa commit','So sánh với nhánh mặc định','Làm mới','Không có thay đổi','Mở dự án Git để xem thay đổi.','Không có nhánh mặc định để so sánh.'],
  th:['การเปลี่ยนแปลง Git','การเปลี่ยนแปลงที่ยังไม่คอมมิต','เปรียบเทียบกับสาขาเริ่มต้น','รีเฟรช','ไม่มีการเปลี่ยนแปลง','เปิดโครงการ Git เพื่อดูการเปลี่ยนแปลง','ไม่มีสาขาเริ่มต้นสำหรับเปรียบเทียบ'],
};
export function nativeGitText(locale:Locale,key:Key){return copy[locale][keys.indexOf(key)];}
