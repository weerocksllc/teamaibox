<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.es.md)
<!-- doc-navigation:end -->

# Instalar desde un clon público

Este punto de entrada prepara las entradas públicas requeridas, crea las imágenes de la aplicación y produce un paquete completo antes de instalarlo. El progreso de la construcción se puede reanudar; sólo el resultado final de la preparación de la instalación indica un electrodoméstico instalado. El éxito de la descarga o de la verificación previa por sí solo no lo es.

Mantenga los modelos generados, imágenes de contenedores, paquetes de instalación, registros de prueba y credenciales fuera del repositorio. No se garantiza la disponibilidad de réplicas de terceros; Los cachés portátiles verificados y los paquetes fuera de línea se describen a continuación.

En un DGX Spark nuevo con Ubuntu 24.04, con Docker/Compose, NVIDIA y KVM, clone el repositorio público y ejecútelo desde su raíz:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Para una red de China continental donde no se puede llegar a los puntos finales de modelo/imagen ascendentes, utilice el mismo punto de entrada con fuentes de descarga regionales:

```sh
sudo bash install/from-source.sh --region cn
```

Esta es una **compilación de fuente en línea seguida de una instalación fuera de línea**, no una compilación de fuente fuera de línea. Prepara automáticamente las herramientas de compilación que faltan, descarga las seis entradas del modelo, compila y ensambla Android y todas las imágenes de aplicaciones, cuantifica los dos modelos fuente, recopila paquetes de firmware/host, crea el paquete completo fuera de línea y ejecuta su instalador existente. No reemplaza a Docker/NVIDIA, no reinicia el demonio de Docker, no borra una instalación existente ni cambia la configuración de enrutamiento del host, DNS o VPN. Los modelos, los estados de inicio de sesión de invitados y el sitio web de marketing privado no se toman de otra instalación.

El espacio de trabajo predeterminado es `/var/tmp/teamaibox-source-build`; descargue cachés y registros por etapa en vivo allí, fuera del clon. La instalación tiene como valor predeterminado `/srv/teamaibox/installation`. Espere grandes descargas y varios cientos de GB de uso temporal del disco. La carga del modelo y la cuantificación de la GPU pueden llevar mucho tiempo; no se promete ningún tiempo fijo de finalización.

## Reanudar la instalación y consultar el estado

Si se interrumpe, **vuelva a ejecutar exactamente el mismo comando**. Mantenga el espacio de trabajo. Una compilación en ejecución excluye a otro escritor; Los archivos e imágenes del escenario completados se verifican antes de su reutilización. Los intentos fallidos permanecen disponibles para el diagnóstico, mientras que el siguiente intento ejecuta solo la etapa fallida. Se conservan los rangos de bytes del modelo y los archivos verificados. `state.json` identifica la etapa actual y su directorio de registro. Las descargas de modelos oficiales utilizan simultaneidad de rango/archivo limitado; Las fuentes regionales utilizan concurrencia conservadora para reducir la limitación de tasas. Los informes de progreso de bytes por archivo se transfieren o reutilizan por separado de la verificación de hash final del editor. La compilación de la herramienta invitada también funciona bajo un servicio del sistema sin inicio de sesión: crea cachés de compilación aislados fuera de los activos de instalación resultantes.

Los cambios de fuente requieren un nuevo `--work-dir`; reutilice el caché de descarga con `--cache-dir /path/to/public-cache`. La huella digital de origen impide combinar silenciosamente salidas de diferentes códigos. Una instalación existente no es una invitación para restablecerla: solo se puede reanudar la instalación del mismo paquete de este espacio de trabajo; otras instalaciones deben utilizar su proceso de actualización.

Modos útiles:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` es de solo lectura y no afirma que las descargas se realizarán correctamente. Los programas de solo descarga y solo de compilación no afirman explícitamente que estén listos para la instalación.

## Fuentes regionales e integridad

El modo China utiliza `https://hf-mirror.com` para la transferencia de modelos y `https://docker.m.daocloud.io` para las entradas de Docker Hub ancladas en el resumen. Estos son espejos de terceros, no servicios operados por Weerocks o los editores de modelos. El modelo de confirmación de Git está fijado por el perfil del producto; su árbol Git verificado y sus punteros LFS establecen los tamaños de archivo y hashes esperados. La respuesta API del espejo por sí sola no puede generar confianza. Docker verifica los resúmenes de capas/manifiestos anclados. Las etiquetas no fijadas no se redirigen automáticamente (la herramienta de compilación Go tiene un bloqueo de resumen explícito). NVIDIA imágenes permanecen en el registro de su editor. La verificación TLS permanece habilitada y no se envían tokens de cuenta a los espejos del modelo.

Puede seleccionar sus propios orígenes HTTPS usando `--model-endpoint` and `--registry-mirror`. Los valores de los puntos finales no deben incluir credenciales ni parámetros de consulta. El contenedor Docker con ámbito se aplica solo a este proceso de compilación, no al demonio del sistema ni a otros proyectos. Los archivos de licencia y metadatos del SDK aún provienen de sus editores HTTPS autorizados; un espejo no puede inventar hashes.

Los espejos pueden tener una tarifa limitada o no estar disponibles. Las descargas de modelos se ejecutan con simultaneidad limitada y respetan los tiempos de reutilización. Ningún script puede garantizar la conectividad a todos los canales ascendentes de cada red. Si ambas rutas no están disponibles, prepare las descargas o el paquete completo en una máquina compatible accesible y cópielas:

- `--download-models-only --cache-dir <public-cache>` prepara archivos de modelo verificados y cachés reanudables. Copie ese directorio y luego páselo con `--cache-dir` en el destino. Cada modelo reutilizado se compara con su identidad fijada. Este caché **no** es un paquete de instalación completo sin conexión.
- `--build-only` prepara el paquete completo para la instalación sin conexión. Copie su tar y su suma de verificación, verifique y descomprima, luego ejecute `sudo ./install.sh` dentro de él. Esta es la ruta confiable de host desconectado; No requiere una VPN en el objetivo ni acceso a una caja de desarrollo.

Nunca copie un directorio de datos de Docker activo, discos de invitados, perfiles de navegador, bases de datos de cuentas, credenciales o cachés privados como sustituto de entradas públicas. No desactive las sumas de verificación ni acepte una página de inicio de sesión/desafío como archivo de modelo.

## Licencia y primer uso

Revise `THIRD_PARTY_NOTICES.md`, los términos del SDK de Android y las licencias de modelos individuales antes de compilar. La descarga de componentes de terceros no los convierte en MIT activos ni otorga a Google derechos de certificación o redistribución. Los medios ISO de Windows/Linux todavía los proporciona el usuario. El inicio de sesión de fábrica sigue siendo `admin/admin`; cámbielo antes de exponer el aparato. El instalador existente genera credenciales de servicio independientes e informa sobre la preparación real.

Una vez completado, abra `https://<BOX_LAN_IP>/` en la misma LAN; sustituya la dirección de red física actual de Spark, no un puente Docker o una dirección VPN. Los registros del espacio de trabajo de origen `state.json` registran el progreso de la compilación. El `/srv/teamaibox/installation/readiness.json` instalado registra las comprobaciones de instalación. Ni una compilación exitosa ni una verificación del estado del contenedor de escucha sustituyen la operación visible de un extremo a otro de una aplicación.

El tiempo de ejecución de la transmisión debe contener el receptor UxPlay, los ejecutables privados de descubrimiento D-Bus y Avahi, así como sus complementos multimedia. La creación final de la imagen pública verifica estos ejecutables; una biblioteca cliente por sí sola es insuficiente. Una instalación nueva registra el proxy de escritorio y la puerta de enlace con los otros dependientes del espacio de nombres de red API para que las actualizaciones de API agrupadas puedan conservar la ruta de conexión del escritorio. No vuelva a crear solo un subconjunto de ese grupo durante el mantenimiento.
