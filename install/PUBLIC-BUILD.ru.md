<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.ru.md)
<!-- doc-navigation:end -->

# Создайте устройство из общедоступного источника

Новая точка входа оркестрации описана в [SOURCE-INSTALL.md](SOURCE-INSTALL.ru.md). Он автоматизирует приведенные ниже рецепты; Там указан его статус полной проверки устройства. Эти ручные рецепты остаются доступными для специалистов по техническому обслуживанию и индивидуальной диагностике.

Это путь от источника к пакету. Он не импортирует предыдущую установку Team AI Box, ее контейнеры, учетные записи, сертификаты, гостей или базу данных. Сборочной машине необходим доступ в Интернет; полученный полный пакет устанавливается в автономном режиме. Заказчик предоставляет установочный носитель Windows/Linux отдельно.

Используйте Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 и достаточно места на диске для загрузки исходного кода, слоев сборки и окончательного несжатого пакета. Для квантования модели также требуется совместимый графический процессор NVIDIA с достаточным количеством свободной памяти. Не останавливайте другие рабочие нагрузки, чтобы получить эту память без разрешения владельца компьютера. Docker и NVIDIA являются обязательными компонентами, а не компонентами, заменяемыми установщиком.

Запускайте команды из новой общедоступной проверки. Установите для `BUILD` новый, абсолютный каталог сборки **вне** оформления заказа. Результаты, модели и отчеты не должны быть зафиксированы. Каждый помощник отказывается от занятого вывода, если он не документирует конкретную операцию возобновления. Используйте ссылки/идентификаторы успешного отчета, а не имена изображений, скопированные с чужого компьютера. Локальный идентификатор содержимого Docker не является загружаемой ссылкой на реестр; Родительским аргументам Dockerfile нужен соответствующий локальный тег или квалифицированный восходящий дайджест.

## 1. Сервисы и приложения

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

`--network host` влияет на онлайновые **сборки**, а не на установленную сеть служб. На этапах зависимости узла допускается 2 секунды на попытку подключения вместо 250 мс, установленных для узла по умолчанию. Это позволяет использовать официальные загрузки npm по каналам с более высокой задержкой, включая VPN, управляемые пользователями, без переключения реестров, отключения IPv6 или ослабления проверок целостности TLS/пакетов. Этот параметр является аргументом на этапе сборки, а не изменением среды в установленном приложении. Для более медленного соединения прямые сборки Docker могут переопределить `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. Веб-образ создает свои собственные заблокированные зависимости и ресурсы. Сервисы Node используют недавно созданное закрытие зависимостей API. OCR включает в себя общедоступный адаптер; ему не нужен неопубликованный рабочий пакет из другого проекта. В переводе используется закрепленный общедоступный образ vLLM NVIDIA. Встраивание, пакетное ASR и медиа-трансляции намеренно делятся соответствующими общедоступными образами среды выполнения. В образе компьютера создается QEMU 11.1.1 с проверенной подписью и поддержкой ARM TPM/PPI, KVM, VNC и PulseAudio, сохраняя при этом возможности исходной среды выполнения Windows. Debian предоставляет библиотеки времени выполнения, но его старый пакет QEMU не должен заменять этот исполняемый файл. Окончательное изображение проверяет как свойство ARM TIS `ppi`, так и серверную часть PulseAudio, и включает соответствующее ПЗУ кадрового буфера RAM. См. [руководство по работе с виртуальными компьютерами](../deploy/windows-computer/README.ru.md) для проверки ограниченной среды выполнения и требований к обновлению с сохранением данных.

Каждая роль имеет журнал. Неудачный отчет сохраняет успешные выходные данные роли; создайте только неудачную роль и объедините успешные отчеты позже. Не заменяйте отсутствующий образ работающим контейнером разработки.

## 2. Android без учетной записи и работа камеры

Замки закрепляют сборку AOSP Google, пакет хоста, входные данные ядра и версии исходного кода. Загрузки проверяются перед использованием. Во время сборки ни один гость не загружается.

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

Для APK-патча камеры установите общедоступные инструменты командной строки Android от Google, платформу `android-36.1`, инструменты сборки `36.1.0` и JDK, поддерживающий выпуск Java.
8. Установите `ANDROID_SDK_ROOT` and `JDK_HOME` в эти каталоги инструментов. Эти инструменты представляют собой зависимости сборки, а не экспортированные профили пользователей Android. В ARM64 Linux пакет Google `zipalign` может быть только для x86: установите пакет ARM64 Ubuntu `zipalign` и передайте `--zipalign /usr/bin/zipalign` ниже. D8 и apksigner — это программы Java. Альтернативно сборка APK может работать на отдельном поддерживаемом хосте SDK; передавайте только два выходных файла (`Camera2.apk`, `camera-preview.json`), а не настройки Android или профиль пользователя этого хоста.

Извлеките стандартный APK из чистой сборки AOSP (выходной каталог должен существовать и быть доступен для записи контейнером сборки):

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

В APK хранится известная **публичная подписывающая сторона теста AOSP**, а не закрытый ключ продукта. Помощник проверяет исходный и полученный сертификат и неизмененные ресурсы APK, а также удаляет временные материалы для подписи. Это не учетная запись или идентификатор устройства Google.

Текущий контракт на полную установку также включает экспериментальный вариант Google Android. Его общедоступная блокировка ввода и проверка подписи **не** предоставляют Google права на сертификацию или распространение. Создавайте/используйте его только в рамках применимых сторонних условий; не публикуйте полученный полный пакет для неограниченной загрузки MIT.

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

## 3. Файлы модели издателя и рецепт публичного квантования

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

Все загрузки моделей используют неизменяемые версии в `deploy/compute/*profile*` и хэши Git/LFS издателя. Необязательный `--cache <directory>` доступен только для чтения и принимает файлы только в том случае, если их байты соответствуют издателю. Это не способ без разбора импортировать каталог установленной модели. Автономный текст MIT ASR прикреплен к исходной версии Whisper, поскольку в преобразованном снимке модели указывается только лицензия. OCR сохраняет собственную лицензию, а не MIT. Закрепленные карточки моделей перевода и внедрения объявляют Apache-2.0 без отправки отдельного текста; их помощниками являются лицензия Apache с контрольной суммой и запись о происхождении после проверки этого заявления.

Прерванная соответствующая загрузка поддерживает `--resume`. `--transfer ranges` использует ограниченные возобновляемые диапазоны HTTP; `--transfer huggingface` требует официальных пакетов `huggingface_hub`/`hf_xet` и отключает использование токенов. Частичные файлы и кэши загрузки остаются за пределами каталогов моделей, доступных для публикации. Контрольные суммы обязательны при каждой транспортировке. Не ослабляйте их для HTML-страниц входа/вызова или усеченных загрузок.

Квантование выполняется в автономном режиме в отдельном контейнере сборки с использованием общедоступных синтетических калибровочных данных ModelOpt, а не истории чата. Только выходы, для которых в `build.json` указано `quantized`, могут обеспечивать `assistant-model` and `translation-model`; выберите их подкаталоги `model/`, а не необработанные источники или всю рабочую область сборки. После проверки входных данных сборки Linux советуют ядру освободить кэшированные страницы этих конкретных файлов. Это позволяет избежать ошибочных показаний немедленного освобождения памяти графического процессора в общей памяти GB10; он не удаляет веса, не очищает кэши всего хоста и не останавливает рабочие нагрузки. Для одного графического процессора GB10 помощник выделяет бюджет Linux `MemAvailable` и резервирует мощности для калибровки и хоста. Он отказывается от недостаточной мощности, вместо того чтобы молча принять сборку с использованием преимущественно процессора. Когда полная модель подходит, явные бюджеты ModelOpt позволяют избежать ненужного пути экспорта Accelerate с разгрузкой ЦП. Контейнер сборки также устанавливает неограниченную заблокированную память и стек объемом 64 МБ в соответствии с требованиями [NVIDIA к запуску квантования](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Эти параметры относятся к контейнеру сборки, а не к ограничениям на уровне хоста.

## 4. Полные входные данные пакета

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

В отчете о слиянии должна быть указана **41 роль и ни одна недостающая роль**. Он проверяет архитектуру изображения/идентификаторы контента и отклоняет конфликтующие выходные данные. Ресурсы содержат только исходную прошивку UEFI (включая новый шаблон хранилища переменных), ISO-драйвер virtio с закрепленной контрольной суммой, среду выполнения исходного чертежа и уведомления Android, привязанные к вновь созданным образам. ISO не является установочным носителем Windows. Его зеркало Microsoft OpenVMM, идентичное контрольной сумме, позволяет избежать использования интерактивной страницы загрузки Fedora.

Соберите пакеты хоста с помощью `collect_host_packages.py`, как описано в [README.md](README.ru.md), затем сгенерируйте шаблон с помощью `prepare-release.py --template`. Заполните его карту изображений из `images.json`; заполните все 12 ролей активов из выходных данных модели, `resources/assets.json` and `guest-tools`. Установите `sourceCommit` для оформления заказа и фактической версии агента. Никакие заполнители или предыдущая конфигурация установки недопустимы.

Запустите `prepare-release.py --inputs … --output …`, затем `build-package.sh`, используя подготовленный выпуск. Измененные/незафиксированные источники требуют явного флага кандидата `--allow-working-tree`; они не являются выпущенным коммитом. См. [PACKAGE-README.md](PACKAGE-README.ru.md) для установки. Новая пустая база данных учетных записей получает `admin/admin`; все учетные данные службы и идентификаторы устройств генерируются независимо. Сами по себе сборки не доказывают, что установка прошла успешно.

## Исторические многоуровневые рецепты и проверки публикаций

Старые диагностические/многоуровневые файлы Docker сохраняются для обслуживания исходного кода и не используются этим конвейером. Их аргументы `BUILD_PARENT_N` намеренно не имеют личного изображения по умолчанию. Предоставьте созданный вами совместимый родительский элемент или используйте общедоступный конвейер, указанный выше; не угадывайте недоступный дайджест разработки.

Перед публикацией запустите защиту исходного кода и секретный сканер, просмотрите историю отдельно и исключите все каталоги сборки, пакеты, гостевые диски, данные учетной записи и частный веб-сайт. Отчеты, содержащие локальные пути, находятся за пределами общедоступного дерева. Проверка этой работы ограничивается закрытием ввода сборки, идентификацией артефакта, установкой и вновь установленными минимальными путями обслуживания; он не повторяет несвязанную коммерческую приемку.
