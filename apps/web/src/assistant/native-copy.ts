import type {Locale} from '../i18n';
const keys=['settings','save','project','agent','model','once','always','reject','restore','uncertain'] as const;
type Key=typeof keys[number];
const copy:Record<Locale,readonly string[]>={
  en:['Assistant settings','Save','Open workspace','Default agent','Default model','Allow once','Always allow','Reject','Restore draft','Delivery could not be confirmed. Check the conversation before sending again.'],
  'zh-CN':['助手设置','保存','打开工作空间','默认 Agent','默认模型','仅允许一次','始终允许','拒绝','恢复草稿','无法确认消息是否送达。再次发送前请先检查会话。'],
  'zh-TW':['助手設定','儲存','開啟工作空間','預設 Agent','預設模型','僅允許一次','一律允許','拒絕','還原草稿','無法確認訊息是否送達。再次傳送前請先檢查對話。'],
  ja:['アシスタント設定','保存','ワークスペースを開く','既定のエージェント','既定のモデル','今回のみ許可','常に許可','拒否','下書きを復元','送信を確認できませんでした。再送信する前に会話を確認してください。'],
  ko:['어시스턴트 설정','저장','작업 공간 열기','기본 에이전트','기본 모델','한 번 허용','항상 허용','거부','초안 복원','전송 여부를 확인할 수 없습니다. 다시 보내기 전에 대화를 확인하세요.'],
  fr:['Paramètres de l’assistant','Enregistrer','Ouvrir l’espace de travail','Agent par défaut','Modèle par défaut','Autoriser une fois','Toujours autoriser','Refuser','Restaurer le brouillon','Envoi non confirmé. Vérifiez la conversation avant de renvoyer.'],
  de:['Assistenteneinstellungen','Speichern','Arbeitsbereich öffnen','Standardagent','Standardmodell','Einmal erlauben','Immer erlauben','Ablehnen','Entwurf wiederherstellen','Zustellung nicht bestätigt. Prüfen Sie das Gespräch vor dem erneuten Senden.'],
  es:['Ajustes del asistente','Guardar','Abrir espacio de trabajo','Agente predeterminado','Modelo predeterminado','Permitir una vez','Permitir siempre','Rechazar','Restaurar borrador','No se confirmó el envío. Revise la conversación antes de reenviar.'],
  'pt-BR':['Configurações do assistente','Salvar','Abrir espaço de trabalho','Agente padrão','Modelo padrão','Permitir uma vez','Sempre permitir','Recusar','Restaurar rascunho','Envio não confirmado. Verifique a conversa antes de reenviar.'],
  ru:['Настройки ассистента','Сохранить','Открыть рабочую область','Агент по умолчанию','Модель по умолчанию','Разрешить один раз','Всегда разрешать','Отклонить','Восстановить черновик','Доставка не подтверждена. Проверьте разговор перед повторной отправкой.'],
  ar:['إعدادات المساعد','حفظ','فتح مساحة العمل','الوكيل الافتراضي','النموذج الافتراضي','السماح مرة واحدة','السماح دائمًا','رفض','استعادة المسودة','لم يتأكد إرسال الرسالة. راجع المحادثة قبل إعادة الإرسال.'],
  hi:['सहायक सेटिंग','सहेजें','कार्यस्थान खोलें','डिफ़ॉल्ट एजेंट','डिफ़ॉल्ट मॉडल','एक बार अनुमति दें','हमेशा अनुमति दें','अस्वीकार करें','ड्राफ़्ट बहाल करें','संदेश पहुँचने की पुष्टि नहीं हुई। दोबारा भेजने से पहले बातचीत जाँचें।'],
  id:['Pengaturan asisten','Simpan','Buka ruang kerja','Agen bawaan','Model bawaan','Izinkan sekali','Selalu izinkan','Tolak','Pulihkan draf','Pengiriman belum terkonfirmasi. Periksa percakapan sebelum mengirim ulang.'],
  it:['Impostazioni assistente','Salva','Apri area di lavoro','Agente predefinito','Modello predefinito','Consenti una volta','Consenti sempre','Rifiuta','Ripristina bozza','Invio non confermato. Controlla la conversazione prima di inviare di nuovo.'],
  tr:['Asistan ayarları','Kaydet','Çalışma alanını aç','Varsayılan ajan','Varsayılan model','Bir kez izin ver','Her zaman izin ver','Reddet','Taslağı geri yükle','Teslimat doğrulanamadı. Yeniden göndermeden önce konuşmayı kontrol edin.'],
  vi:['Cài đặt trợ lý','Lưu','Mở không gian làm việc','Tác nhân mặc định','Mô hình mặc định','Cho phép một lần','Luôn cho phép','Từ chối','Khôi phục bản nháp','Chưa xác nhận đã gửi. Hãy kiểm tra cuộc trò chuyện trước khi gửi lại.'],
  th:['การตั้งค่าผู้ช่วย','บันทึก','เปิดพื้นที่ทำงาน','เอเจนต์เริ่มต้น','โมเดลเริ่มต้น','อนุญาตครั้งเดียว','อนุญาตเสมอ','ปฏิเสธ','กู้คืนฉบับร่าง','ยังยืนยันการส่งไม่ได้ โปรดตรวจสอบการสนทนาก่อนส่งอีกครั้ง'],
};
const workspaceKeys=['files','terminal','rename','delete','fork','changes','tasks','children','command','skills','context','compact','reconnect','closeTerminal','deleteConfirm','binary','parent','back','forward','undo','redo'] as const;
type WorkspaceKey=typeof workspaceKeys[number];
const workspaceCopy:Record<Locale,readonly string[]>={
  en:['Files','Terminal','Rename','Delete conversation','Branch conversation','Changes','Tasks','Subsessions','Command','Skills','Context','Compact context','Reconnect','End terminal','Delete this conversation? This cannot be undone.','Binary file','Parent conversation','Back','Forward','Revert to this message','Undo revert'],
  'zh-CN':['文件','终端','重命名','删除会话','创建分支','更改','任务','子会话','命令','技能','上下文','压缩上下文','重新连接','结束终端','删除此会话？此操作无法撤销。','二进制文件','上级会话','返回','前进','回退到此消息','撤销回退'],
  'zh-TW':['檔案','終端機','重新命名','刪除對話','建立分支','變更','任務','子對話','命令','技能','上下文','壓縮上下文','重新連線','結束終端機','刪除此對話？此操作無法復原。','二進位檔案','上層對話','返回','前進','還原至此訊息','取消還原'],
  ja:['ファイル','ターミナル','名前変更','会話を削除','会話を分岐','変更','タスク','子セッション','コマンド','スキル','コンテキスト','コンテキストを圧縮','再接続','ターミナルを終了','この会話を削除しますか？元に戻せません。','バイナリファイル','親の会話','戻る','進む','このメッセージまで戻す','取り消しを戻す'],
  ko:['파일','터미널','이름 변경','대화 삭제','대화 분기','변경 사항','작업','하위 세션','명령','스킬','컨텍스트','컨텍스트 압축','다시 연결','터미널 종료','이 대화를 삭제할까요? 되돌릴 수 없습니다.','바이너리 파일','상위 대화','뒤로','앞으로','이 메시지로 되돌리기','되돌리기 취소'],
  fr:['Fichiers','Terminal','Renommer','Supprimer la conversation','Créer une branche','Modifications','Tâches','Sous-sessions','Commande','Compétences','Contexte','Compacter le contexte','Reconnecter','Fermer le terminal','Supprimer cette conversation ? Cette action est irréversible.','Fichier binaire','Conversation parente','Retour','Suivant','Revenir à ce message','Annuler le retour'],
  de:['Dateien','Terminal','Umbenennen','Gespräch löschen','Gespräch verzweigen','Änderungen','Aufgaben','Untersitzungen','Befehl','Skills','Kontext','Kontext komprimieren','Neu verbinden','Terminal beenden','Dieses Gespräch unwiderruflich löschen?','Binärdatei','Übergeordnetes Gespräch','Zurück','Weiter','Zu dieser Nachricht zurücksetzen','Zurücksetzen rückgängig machen'],
  es:['Archivos','Terminal','Renombrar','Eliminar conversación','Crear rama','Cambios','Tareas','Subsesiones','Comando','Habilidades','Contexto','Compactar contexto','Reconectar','Cerrar terminal','¿Eliminar esta conversación? No se puede deshacer.','Archivo binario','Conversación principal','Atrás','Adelante','Revertir a este mensaje','Deshacer reversión'],
  'pt-BR':['Arquivos','Terminal','Renomear','Excluir conversa','Criar ramificação','Alterações','Tarefas','Subsessões','Comando','Habilidades','Contexto','Compactar contexto','Reconectar','Encerrar terminal','Excluir esta conversa? Esta ação não pode ser desfeita.','Arquivo binário','Conversa principal','Voltar','Avançar','Reverter até esta mensagem','Desfazer reversão'],
  ru:['Файлы','Терминал','Переименовать','Удалить разговор','Создать ветку','Изменения','Задачи','Дочерние сеансы','Команда','Навыки','Контекст','Сжать контекст','Переподключить','Завершить терминал','Удалить этот разговор? Отменить действие нельзя.','Двоичный файл','Родительский разговор','Назад','Вперёд','Вернуться к сообщению','Отменить возврат'],
  ar:['الملفات','الطرفية','إعادة تسمية','حذف المحادثة','تفريع المحادثة','التغييرات','المهام','الجلسات الفرعية','الأمر','المهارات','السياق','ضغط السياق','إعادة الاتصال','إنهاء الطرفية','حذف هذه المحادثة؟ لا يمكن التراجع.','ملف ثنائي','المحادثة الأصلية','رجوع','تقدم','العودة إلى هذه الرسالة','إلغاء العودة'],
  hi:['फ़ाइलें','टर्मिनल','नाम बदलें','बातचीत हटाएँ','बातचीत की शाखा बनाएँ','बदलाव','कार्य','उपसत्र','कमांड','कौशल','संदर्भ','संदर्भ संक्षिप्त करें','फिर कनेक्ट करें','टर्मिनल समाप्त करें','यह बातचीत हटाएँ? इसे वापस नहीं लाया जा सकता।','बाइनरी फ़ाइल','मूल बातचीत','पीछे','आगे','इस संदेश तक वापस जाएँ','वापसी रद्द करें'],
  id:['Berkas','Terminal','Ganti nama','Hapus percakapan','Cabangkan percakapan','Perubahan','Tugas','Subsesi','Perintah','Keterampilan','Konteks','Ringkas konteks','Hubungkan ulang','Akhiri terminal','Hapus percakapan ini? Tindakan ini tidak dapat dibatalkan.','Berkas biner','Percakapan induk','Kembali','Maju','Kembalikan ke pesan ini','Batalkan pengembalian'],
  it:['File','Terminale','Rinomina','Elimina conversazione','Crea diramazione','Modifiche','Attività','Sottosessioni','Comando','Competenze','Contesto','Compatta contesto','Riconnetti','Termina terminale','Eliminare questa conversazione? Non è reversibile.','File binario','Conversazione principale','Indietro','Avanti','Ripristina a questo messaggio','Annulla ripristino'],
  tr:['Dosyalar','Terminal','Yeniden adlandır','Konuşmayı sil','Konuşmayı dallandır','Değişiklikler','Görevler','Alt oturumlar','Komut','Beceriler','Bağlam','Bağlamı sıkıştır','Yeniden bağlan','Terminali sonlandır','Bu konuşma silinsin mi? Geri alınamaz.','İkili dosya','Üst konuşma','Geri','İleri','Bu mesaja geri dön','Geri dönüşü iptal et'],
  vi:['Tệp','Thiết bị đầu cuối','Đổi tên','Xóa cuộc trò chuyện','Tạo nhánh','Thay đổi','Tác vụ','Phiên phụ','Lệnh','Kỹ năng','Ngữ cảnh','Nén ngữ cảnh','Kết nối lại','Kết thúc đầu cuối','Xóa cuộc trò chuyện này? Không thể hoàn tác.','Tệp nhị phân','Cuộc trò chuyện gốc','Quay lại','Tiếp','Khôi phục đến tin nhắn này','Hoàn tác khôi phục'],
  th:['ไฟล์','เทอร์มินัล','เปลี่ยนชื่อ','ลบการสนทนา','แยกการสนทนา','การเปลี่ยนแปลง','งาน','เซสชันย่อย','คำสั่ง','ทักษะ','บริบท','ย่อบริบท','เชื่อมต่อใหม่','จบเทอร์มินัล','ลบการสนทนานี้หรือไม่? ไม่สามารถยกเลิกได้','ไฟล์ไบนารี','การสนทนาหลัก','ย้อนกลับ','ถัดไป','ย้อนกลับไปข้อความนี้','ยกเลิกการย้อนกลับ'],
};
const interactionKeys=['authenticate','disconnect','authReturn','authFailed','legacyHistory','legacyReadOnly','edit','reviewChanges'] as const;
type InteractionKey=typeof interactionKeys[number];
const interactionCopy:Record<Locale,readonly string[]>={
  en:['Sign in','Disconnect account','Return to AI Assistant to continue.','Authorization was not completed. Return to AI Assistant to try again.','Earlier conversations','Read-only history. Start a new conversation to continue.','Edit file','Review changes'],
  'zh-CN':['登录','断开账号','返回 AI 助手继续。','授权未完成。请返回 AI 助手重试。','早期会话','只读历史。开始新会话以继续。','编辑文件','检查更改'],
  'zh-TW':['登入','中斷帳號連線','返回 AI 助手繼續。','授權未完成。請返回 AI 助手重試。','先前對話','唯讀歷史。開始新對話以繼續。','編輯檔案','檢查變更'],
  ja:['ログイン','アカウントを切断','AI アシスタントに戻って続行してください。','認証が完了していません。AI アシスタントに戻って再試行してください。','以前の会話','読み取り専用の履歴です。続行するには新しい会話を開始してください。','ファイルを編集','変更を確認'],
  ko:['로그인','계정 연결 해제','AI 어시스턴트로 돌아가 계속하세요.','인증이 완료되지 않았습니다. AI 어시스턴트에서 다시 시도하세요.','이전 대화','읽기 전용 기록입니다. 계속하려면 새 대화를 시작하세요.','파일 편집','변경 검토'],
  fr:['Se connecter','Déconnecter le compte','Revenez à l’assistant IA pour continuer.','Autorisation incomplète. Réessayez depuis l’assistant IA.','Conversations antérieures','Historique en lecture seule. Démarrez une nouvelle conversation pour continuer.','Modifier le fichier','Vérifier les modifications'],
  de:['Anmelden','Konto trennen','Kehren Sie zum KI-Assistenten zurück.','Autorisierung nicht abgeschlossen. Versuchen Sie es im KI-Assistenten erneut.','Frühere Gespräche','Schreibgeschützter Verlauf. Beginnen Sie ein neues Gespräch.','Datei bearbeiten','Änderungen prüfen'],
  es:['Iniciar sesión','Desconectar cuenta','Vuelva al asistente de IA para continuar.','Autorización incompleta. Inténtelo de nuevo desde el asistente de IA.','Conversaciones anteriores','Historial de solo lectura. Inicie una nueva conversación para continuar.','Editar archivo','Revisar cambios'],
  'pt-BR':['Entrar','Desconectar conta','Volte ao assistente de IA para continuar.','Autorização incompleta. Tente novamente no assistente de IA.','Conversas anteriores','Histórico somente leitura. Inicie uma nova conversa para continuar.','Editar arquivo','Revisar alterações'],
  ru:['Войти','Отключить аккаунт','Вернитесь к ИИ-ассистенту, чтобы продолжить.','Авторизация не завершена. Повторите попытку в ИИ-ассистенте.','Предыдущие разговоры','История только для чтения. Начните новый разговор.','Изменить файл','Проверить изменения'],
  ar:['تسجيل الدخول','فصل الحساب','ارجع إلى مساعد الذكاء الاصطناعي للمتابعة.','لم يكتمل التفويض. أعد المحاولة من المساعد.','المحادثات السابقة','سجل للقراءة فقط. ابدأ محادثة جديدة للمتابعة.','تحرير الملف','مراجعة التغييرات'],
  hi:['साइन इन','खाता डिस्कनेक्ट करें','जारी रखने के लिए AI सहायक पर लौटें।','प्राधिकरण पूरा नहीं हुआ। AI सहायक से फिर प्रयास करें।','पिछली बातचीत','केवल पढ़ने योग्य इतिहास। जारी रखने के लिए नई बातचीत शुरू करें।','फ़ाइल संपादित करें','बदलाव जाँचें'],
  id:['Masuk','Putuskan akun','Kembali ke asisten AI untuk melanjutkan.','Otorisasi belum selesai. Coba lagi dari asisten AI.','Percakapan sebelumnya','Riwayat hanya baca. Mulai percakapan baru untuk melanjutkan.','Edit berkas','Tinjau perubahan'],
  it:['Accedi','Disconnetti account','Torna all’assistente IA per continuare.','Autorizzazione incompleta. Riprova dall’assistente IA.','Conversazioni precedenti','Cronologia in sola lettura. Inizia una nuova conversazione.','Modifica file','Esamina modifiche'],
  tr:['Oturum aç','Hesap bağlantısını kes','Devam etmek için AI asistanına dönün.','Yetkilendirme tamamlanmadı. AI asistanından tekrar deneyin.','Önceki konuşmalar','Salt okunur geçmiş. Devam etmek için yeni bir konuşma başlatın.','Dosyayı düzenle','Değişiklikleri incele'],
  vi:['Đăng nhập','Ngắt tài khoản','Quay lại trợ lý AI để tiếp tục.','Chưa hoàn tất ủy quyền. Hãy thử lại từ trợ lý AI.','Cuộc trò chuyện trước','Lịch sử chỉ đọc. Bắt đầu cuộc trò chuyện mới để tiếp tục.','Sửa tệp','Xem lại thay đổi'],
  th:['เข้าสู่ระบบ','ยกเลิกการเชื่อมต่อบัญชี','กลับไปที่ผู้ช่วย AI เพื่อดำเนินการต่อ','ยังอนุญาตไม่สำเร็จ โปรดลองอีกครั้งจากผู้ช่วย AI','การสนทนาก่อนหน้า','ประวัติอ่านอย่างเดียว เริ่มการสนทนาใหม่เพื่อดำเนินการต่อ','แก้ไขไฟล์','ตรวจสอบการเปลี่ยนแปลง'],
};
const customizationKeys=['customAgent','instructions','plugins','name','description','prompt','mode','enabled','paths','packages'] as const;
type CustomizationKey=typeof customizationKeys[number];
const customizationCopy:Record<Locale,readonly string[]>={
  en:['Custom agent','Project instructions','Plugins','Name','Description','Instructions / template','Mode','Enabled','Paths or URLs, one per line','Package or file URLs, one per line'],
  'zh-CN':['自定义 Agent','项目指令','插件','名称','说明','指令 / 模板','模式','启用','路径或网址，每行一个','包名称或文件网址，每行一个'],
  'zh-TW':['自訂 Agent','專案指令','外掛','名稱','說明','指令 / 範本','模式','啟用','路徑或網址，每行一個','套件名稱或檔案網址，每行一個'],
  ja:['カスタムエージェント','プロジェクト指示','プラグイン','名前','説明','指示 / テンプレート','モード','有効','パスまたは URL、1 行に 1 件','パッケージまたはファイル URL、1 行に 1 件'],
  ko:['사용자 지정 에이전트','프로젝트 지침','플러그인','이름','설명','지침 / 템플릿','모드','활성화','경로 또는 URL, 한 줄에 하나','패키지 또는 파일 URL, 한 줄에 하나'],
  fr:['Agent personnalisé','Instructions du projet','Extensions','Nom','Description','Instructions / modèle','Mode','Activé','Chemins ou URL, un par ligne','Paquets ou URL de fichier, un par ligne'],
  de:['Eigener Agent','Projektanweisungen','Plugins','Name','Beschreibung','Anweisungen / Vorlage','Modus','Aktiviert','Pfade oder URLs, einer pro Zeile','Pakete oder Datei-URLs, eines pro Zeile'],
  es:['Agente personalizado','Instrucciones del proyecto','Complementos','Nombre','Descripción','Instrucciones / plantilla','Modo','Activado','Rutas o URL, una por línea','Paquetes o URL de archivo, uno por línea'],
  'pt-BR':['Agente personalizado','Instruções do projeto','Plugins','Nome','Descrição','Instruções / modelo','Modo','Ativado','Caminhos ou URLs, um por linha','Pacotes ou URLs de arquivo, um por linha'],
  ru:['Свой агент','Инструкции проекта','Плагины','Имя','Описание','Инструкции / шаблон','Режим','Включено','Пути или URL, по одному в строке','Пакеты или URL файлов, по одному в строке'],
  ar:['وكيل مخصص','تعليمات المشروع','الإضافات','الاسم','الوصف','تعليمات / قالب','الوضع','مفعّل','مسارات أو روابط، واحد في كل سطر','حزم أو روابط ملفات، واحدة في كل سطر'],
  hi:['कस्टम एजेंट','प्रोजेक्ट निर्देश','प्लगइन','नाम','विवरण','निर्देश / टेम्पलेट','मोड','सक्षम','पथ या URL, हर पंक्ति में एक','पैकेज या फ़ाइल URL, हर पंक्ति में एक'],
  id:['Agen khusus','Instruksi proyek','Plugin','Nama','Deskripsi','Instruksi / templat','Mode','Aktif','Jalur atau URL, satu per baris','Paket atau URL berkas, satu per baris'],
  it:['Agente personalizzato','Istruzioni del progetto','Plugin','Nome','Descrizione','Istruzioni / modello','Modalità','Abilitato','Percorsi o URL, uno per riga','Pacchetti o URL di file, uno per riga'],
  tr:['Özel ajan','Proje yönergeleri','Eklentiler','Ad','Açıklama','Yönergeler / şablon','Mod','Etkin','Yollar veya URL’ler, her satıra bir tane','Paketler veya dosya URL’leri, her satıra bir tane'],
  vi:['Tác nhân tùy chỉnh','Chỉ dẫn dự án','Tiện ích','Tên','Mô tả','Chỉ dẫn / mẫu','Chế độ','Bật','Đường dẫn hoặc URL, mỗi dòng một mục','Gói hoặc URL tệp, mỗi dòng một mục'],
  th:['เอเจนต์แบบกำหนดเอง','คำสั่งโครงการ','ปลั๊กอิน','ชื่อ','คำอธิบาย','คำสั่ง / เทมเพลต','โหมด','เปิดใช้งาน','เส้นทางหรือ URL หนึ่งรายการต่อบรรทัด','แพ็กเกจหรือ URL ไฟล์ หนึ่งรายการต่อบรรทัด'],
};
const resumeCopy:Record<Locale,string>={en:'Continue original conversation','zh-CN':'继续原会话','zh-TW':'繼續原對話',ja:'元の会話を続ける',ko:'기존 대화 계속',fr:'Continuer la conversation',de:'Ursprüngliches Gespräch fortsetzen',es:'Continuar conversación original','pt-BR':'Continuar conversa original',ru:'Продолжить исходный диалог',ar:'متابعة المحادثة الأصلية',hi:'मूल बातचीत जारी रखें',id:'Lanjutkan percakapan asli',it:'Continua la conversazione originale',tr:'Özgün konuşmaya devam et',vi:'Tiếp tục cuộc trò chuyện gốc',th:'ดำเนินการสนทนาเดิมต่อ'};
const providerCopy:Record<Locale,[string,string]>={en:['Model provider','Authorization code'],'zh-CN':['模型提供方','授权码'],'zh-TW':['模型供應商','授權碼'],ja:['モデルプロバイダー','認証コード'],ko:['모델 제공업체','인증 코드'],fr:['Fournisseur de modèles','Code d’autorisation'],de:['Modellanbieter','Autorisierungscode'],es:['Proveedor de modelos','Código de autorización'],'pt-BR':['Provedor de modelos','Código de autorização'],ru:['Поставщик моделей','Код авторизации'],ar:['مزود النماذج','رمز التفويض'],hi:['मॉडल प्रदाता','प्राधिकरण कोड'],id:['Penyedia model','Kode otorisasi'],it:['Fornitore di modelli','Codice di autorizzazione'],tr:['Model sağlayıcısı','Yetkilendirme kodu'],vi:['Nhà cung cấp mô hình','Mã ủy quyền'],th:['ผู้ให้บริการโมเดล','รหัสอนุญาต']};
export const nativeCopyKeys=[...keys,...workspaceKeys,...interactionKeys,...customizationKeys,'resumeOriginal','provider','authorizationCode'] as const;
export function nativeText(locale:Locale,key:Key|WorkspaceKey|InteractionKey|CustomizationKey|'resumeOriginal'|'provider'|'authorizationCode') {
  if(key==='provider'||key==='authorizationCode')return providerCopy[locale][key==='provider'?0:1];
  if(key==='resumeOriginal')return resumeCopy[locale];
  const original=keys.indexOf(key as Key);
  if(original>=0)return copy[locale][original];
  const workspace=workspaceKeys.indexOf(key as WorkspaceKey);
  if(workspace>=0)return workspaceCopy[locale][workspace];
  const interaction=interactionKeys.indexOf(key as InteractionKey);
  return interaction>=0?interactionCopy[locale][interaction]:customizationCopy[locale][customizationKeys.indexOf(key as CustomizationKey)];
}
