<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.es.md)
<!-- doc-navigation:end -->

# Team AI Box paquete de instalación sin conexión

La licencia para el código original se encuentra en el paquete `LICENSE`. Los componentes de terceros conservan sus licencias originales; ver `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT no otorga derechos de redistribución adicionales para los servicios de Google, Windows, pesos de modelos o marcas de terceros. Pasar las comprobaciones de integridad del paquete no establece el permiso de redistribución para cada componente.

Este paquete es para un DGX Spark nuevo que conserva un sistema Linux de fábrica compatible. Utiliza el entorno de GPU Docker, Compose y NVIDIA existente sin reemplazarlos ni formatear el disco del sistema.

## Instalación

Verifique el archivo comprimido utilizando el archivo `.sha256` adjunto y luego extráigalo:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

La instalación normal no necesita acceso público a Internet ni ediciones manuales de variables de entorno. El instalador proporciona las herramientas incluidas necesarias, genera una configuración local independiente, inicializa una nueva base de datos e inicia los servicios. La carga inicial del modelo puede llevar tiempo; un indicador de carga no es una confirmación de una instalación exitosa.

Ejecute `sudo ./install.sh --check` para verificar el entorno y el paquete sin instalar. `./install.sh --verify-package` solo verifica el contenido del paquete y también puede ejecutarse en la estación de trabajo de empaquetado. Utilice `--installation-root /dedicated/path/installation` para especificar una nueva raíz de instalación; nunca apunte a datos existentes.

## Interrupciones y datos existentes

Después de una falla o interrupción, resuelva el problema informado y repita el comando original. No elimine el directorio de instalación. El instalador conserva la identidad y los datos que generó. Volver a ejecutar una instalación completa de la misma versión solo verifica su estado. Otras versiones utilizan la ruta de actualización formal, no el borrado y la reinstalación. No existe la opción de forzar sobrescritura.

## Primer uso

Abra la dirección HTTPS en la IP actual del dispositivo e inicie sesión:

- Nombre de usuario del administrador: `admin`
- Contraseña inicial: `admin`

El instalador crea este administrador automáticamente; no se necesita extracción de token de configuración ni registro manual. La contraseña inicial es pública y sencilla: cámbiela en la gestión de usuarios antes de la entrega/uso. Los usuarios normales no tienen una cuenta predeterminada y los crea el administrador. Esto se aplica sólo a una base de datos de cuenta vacía; reanudar, volver a ejecutar, reiniciar y actualizar nunca restablecer las cuentas o contraseñas existentes a los valores predeterminados. El código de recuperación del administrador generado de forma independiente se almacena en la raíz de instalación en `secrets/initial-owner-recovery.json` y solo puede ser leído por el usuario raíz. Nunca envíe códigos de recuperación a chats, tickets o registros públicos. Las instalaciones existentes no generan ni reemplazan códigos de recuperación. Para el certificado HTTPS emitido localmente, configure la confianza del navegador según las instrucciones de la CA del administrador. Un nombre en un certificado no garantiza la resolución DNS/mDNS de LAN. El certificado público de CA local normalmente está en `/srv/teamaibox/installation/https/ca.crt`. Distribuya solo ese certificado público, nunca la clave privada que está al lado.

La instalación no incluye máquinas virtuales existentes, estado de inicio de sesión de Google ni archivos de usuario. Los usuarios cargan ISO de Windows/Linux o los seleccionan desde la unidad del equipo y luego instalan los sistemas invitados ellos mismos. Google Play y las API externas requieren acceso a Internet y no están incluidas en la promesa de disponibilidad sin conexión.

Los textos de licencia de los componentes se conservan con sus recursos de lanzamiento. Copyright © Weerocks LLC. Contacto: teamaibox@weerocks.llc.
