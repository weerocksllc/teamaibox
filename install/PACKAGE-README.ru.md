<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.ru.md)
<!-- doc-navigation:end -->

# Team AI Box пакет автономной установки

Лицензия на исходный код находится в комплекте `LICENSE`. Сторонние компоненты сохраняют свои исходные лицензии; см. `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT не предоставляет никаких дополнительных прав на распространение сервисов Google, Windows, весов моделей или сторонних брендов. Прохождение проверок целостности пакета не устанавливает разрешения на перераспределение для каждого компонента.

Этот пакет предназначен для новой версии DGX Spark, сохраняющей совместимую заводскую систему Linux. Он использует существующую среду Docker, Compose и NVIDIA GPU, не заменяя их и не форматируя системный диск.

## Установка

Проверьте архив, используя прилагаемый файл `.sha256`, затем распакуйте его:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Обычная установка не требует ни общедоступного доступа в Интернет, ни ручного редактирования переменных среды. Установщик предоставляет необходимые встроенные инструменты, генерирует независимую локальную конфигурацию, инициализирует новую базу данных и запускает службы. Первоначальная загрузка модели может занять некоторое время; индикатор загрузки не является подтверждением успешной установки.

Запустите `sudo ./install.sh --check`, чтобы проверить среду и пакет без установки. `./install.sh --verify-package` проверяет только содержимое пакета и также может работать на рабочей станции по упаковке. Используйте `--installation-root /dedicated/path/installation`, чтобы указать новый корень установки; никогда не направляйте его на существующие данные.

## Прерывания и существующие данные

После сбоя или прерывания устраните указанную проблему и повторите исходную команду. Не удаляйте каталог установки. Установщик сохраняет идентификационные данные и сгенерированные им данные. При повторном запуске полной установки той же версии проверяется только ее состояние. В других версиях используется формальный путь обновления, а не удаление и переустановка. Опция принудительной перезаписи отсутствует.

## Первое использование

Откройте HTTPS-адрес по текущему IP-адресу устройства и войдите в систему:

- Имя пользователя администратора: `admin`
- Начальный пароль: `admin`

Установщик автоматически создает этого администратора; не требуется извлечение токена настройки или ручная регистрация. Исходный пароль общедоступен и прост: измените его в управлении пользователями перед доставкой/использованием. Обычные пользователи не имеют учетной записи по умолчанию и создаются администратором. Это применимо только к пустой базе данных аккаунтов; возобновление, повторный запуск, перезагрузка и обновление никогда не сбрасывают существующие учетные записи или пароли к значениям по умолчанию. Независимо созданный код восстановления администратора хранится в корне установки по адресу `secrets/initial-owner-recovery.json` и доступен для чтения только пользователю root. Никогда не отправляйте коды восстановления в чаты, заявки или публичные журналы. Существующие установки не генерируют и не заменяют коды восстановления. Для локально выданного сертификата HTTPS настройте доверие браузера в соответствии с инструкциями центра сертификации администратора. Имя в сертификате не гарантирует разрешение LAN DNS/mDNS. Публичный сертификат локального центра сертификации обычно находится по адресу `/srv/teamaibox/installation/https/ca.crt`. Распространяйте только этот открытый сертификат, а не прилагаемый к нему закрытый ключ.

Установка не включает существующие виртуальные машины, состояние входа в Google или файлы пользователя. Пользователи загружают ISO-образы Windows/Linux или выбирают их на общем диске, а затем самостоятельно устанавливают гостевые системы. Google Play и внешние API требуют доступа к Интернету и не включены в обещание автономной доступности.

Тексты лицензий на компоненты сохраняются вместе с ресурсами их выпуска. Авторское право © Weerocks LLC. Контакт: teamaibox@weerocks.llc.
