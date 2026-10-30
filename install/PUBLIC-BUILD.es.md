<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.es.md)
<!-- doc-navigation:end -->

# Construir un dispositivo a partir de la fuente pública

El nuevo punto de entrada de la orquestación está documentado en [SOURCE-INSTALL.md](SOURCE-INSTALL.es.md). Automatiza las recetas siguientes; allí se indica su estado de verificación de dispositivo completo. Estas recetas manuales permanecen disponibles para los mantenedores y el diagnóstico de etapas individuales.

Esta es la ruta del origen al paquete. No importa una instalación anterior de Team AI Box, sus contenedores, cuentas, certificados, invitados o base de datos. La máquina de construcción necesita acceso a Internet; el paquete completo resultante se instala sin conexión. El cliente suministra los medios de instalación de Windows/Linux por separado.

Utilice Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 y suficiente espacio en disco para descargas de código fuente, capas de compilación y el paquete final sin comprimir. La cuantificación del modelo también requiere una GPU NVIDIA compatible con suficiente memoria libre. No detenga otras cargas de trabajo para obtener esa memoria sin el permiso del propietario de la máquina. Docker y NVIDIA son requisitos previos, no componentes reemplazados por el instalador.

Ejecute comandos desde una caja pública nueva. Establezca `BUILD` en un nuevo directorio de compilación absoluto **fuera** del proceso de pago. No se deben comprometer resultados, modelos e informes. Cada ayudante rechaza una salida ocupada a menos que documente una operación de reanudación específica. Utilice las referencias/ID del informe exitoso, no nombres de imágenes copiados de la máquina de otra persona. Un ID de contenido local de Docker no es una referencia de registro descargable; Los argumentos principales de Dockerfile necesitan la etiqueta local correspondiente o un resumen ascendente calificado.

## 1. Servicios y aplicaciones

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

`--network host` afecta a las **compilaciones** en línea, no a las redes de servicios instaladas. Las etapas de dependencia del nodo permiten 2 segundos por intento de conexión en lugar del valor predeterminado del nodo de 250 ms. Esto mantiene las descargas oficiales de npm utilizables en enlaces de mayor latencia, incluidas VPN administradas por el usuario, sin cambiar registros, deshabilitar IPv6 o debilitar las comprobaciones de integridad de paquetes/TLS. La configuración es un argumento de la etapa de compilación, no un cambio de entorno en la aplicación instalada. Para un enlace más lento, las compilaciones directas de Docker pueden anular `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. La imagen web construye sus propias dependencias y activos bloqueados. Los servicios de nodo comparten el cierre de dependencia de API recién creado. OCR incluye su adaptador público; no necesita un paquete de trabajo no publicado de otro proyecto. La traducción utiliza la imagen vLLM pública fijada NVIDIA. Los medios de incrustación, ASR por lotes y casting comparten deliberadamente sus respectivas imágenes públicas de tiempo de ejecución. La imagen de la computadora crea QEMU 11.1.1 con firma verificada y compatibilidad con ARM TPM/PPI, KVM, VNC y PulseAudio, preservando las capacidades del tiempo de ejecución original de Windows. Debian proporciona bibliotecas de tiempo de ejecución, pero su QEMU empaquetado más antiguo no debe reemplazar este ejecutable. La imagen final comprueba tanto la propiedad ARM TIS `ppi` como el backend de PulseAudio e incluye la ROM del framebuffer RAM correspondiente. Consulte [la guía de tiempo de ejecución de computadora virtual](../deploy/windows-computer/README.es.md) para conocer la sonda de tiempo de ejecución limitada y los requisitos de actualización para preservar datos.

Cada rol tiene un registro. Un informe fallido preserva los resultados exitosos de las funciones; cree solo el rol fallido y combine los informes exitosos más adelante. No sustituya la imagen faltante por un contenedor de desarrollo en ejecución.

## 2. Tiempo de ejecución de cámara y Android sin cuenta

Los bloqueos bloquean la compilación AOSP de Google, el paquete de host, las entradas del kernel y las revisiones de fuentes. Las descargas se verifican antes de su uso. Ningún invitado es expulsado durante el montaje.

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

Para el parche APK de la cámara, instale las herramientas públicas de línea de comandos de Android de Google, la plataforma `android-36.1`, las herramientas de compilación `36.1.0` y un JDK compatible con la versión Java.
8. Establezca `ANDROID_SDK_ROOT` and `JDK_HOME` en esos directorios de herramientas. Las herramientas son dependencias de compilación, no perfiles de usuario de Android exportados. En ARM64 Linux, el paquete `zipalign` de Google puede ser solo para x86: instale el paquete ARM64 `zipalign` de Ubuntu y pase `--zipalign /usr/bin/zipalign` a continuación. D8 y apksigner son programas Java. Alternativamente, la compilación del APK puede ejecutarse en un host SDK compatible independiente; transfiera solo sus dos archivos de salida (`Camera2.apk`, `camera-preview.json`), nunca la configuración de Android o el perfil de usuario de ese host.

Extraiga el APK estándar de la compilación AOSP limpia (el directorio de salida debe existir y el contenedor de compilación debe poder escribirlo):

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

El APK mantiene al **firmante de prueba público AOSP** conocido, no una clave de producto privada. El asistente verifica el certificado original y resultante y los recursos APK sin cambios, y elimina el material de firma temporal. Esta no es una cuenta ni una identidad de dispositivo de Google.

El contrato de instalación completo actual también incluye una variante experimental de Google Android. Su bloqueo de entrada pública y su inspección de firmas **no** otorgan a Google derechos de certificación o redistribución. Construirlo/utilizarlo únicamente dentro de los términos aplicables de terceros; no publique el paquete completo resultante como una descarga MIT sin restricciones.

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

## 3. Archivos de modelo de Publisher y receta de cuantificación pública

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

Todas las descargas de modelos utilizan las revisiones inmutables en `deploy/compute/*profile*` y los hashes Git/LFS del editor. El `--cache <directory>` opcional es de solo lectura y acepta archivos solo cuando sus bytes coinciden con el editor. No es una forma de importar indiscriminadamente un directorio de modelo instalado. El texto independiente de ASR MIT está fijado a la versión original de Whisper porque la instantánea del modelo convertido solo declara la licencia. OCR conserva su propia licencia, no MIT. Las tarjetas de modelo de inserción y traducción fijadas declaran Apache-2.0 sin enviar su texto independiente; sus ayudantes incluyen la licencia de Apache fijada con suma de verificación y un registro de procedencia después de verificar esa declaración.

Una descarga coincidente interrumpida admite `--resume`. `--transfer ranges` utiliza rangos HTTP reanudables limitados; `--transfer huggingface` requiere los paquetes oficiales `huggingface_hub`/`hf_xet` y deshabilita el uso de tokens. Los cachés parciales y de descarga permanecen fuera de los directorios de modelos publicables. Las sumas de verificación son obligatorias en cada transporte. No los debilite para páginas HTML de inicio de sesión/desafío o descargas truncadas.

La cuantificación se ejecuta sin conexión en un contenedor de compilación separado utilizando los datos públicos de calibración sintética de ModelOpt, nunca historiales de chat. Sólo las salidas cuyo `build.json` diga `quantized` pueden suministrar `assistant-model` and `translation-model`; seleccione sus subdirectorios `model/`, no las fuentes sin formato ni todo el espacio de trabajo de compilación. Después de validar las entradas, las compilaciones de Linux recomiendan al kernel que libere las páginas almacenadas en caché de esos archivos específicos. Esto evita lecturas engañosas de la memoria de la GPU que se libera inmediatamente en la memoria compartida del GB10; no elimina pesos, borra cachés de todo el host ni detiene cargas de trabajo. Para una GPU GB10, el asistente presupuesta desde Linux `MemAvailable` y reserva capacidad para la calibración y el host. Rechaza la capacidad insuficiente en lugar de aceptar silenciosamente una construcción compuesta principalmente por CPU. Cuando el modelo completo se ajusta, los presupuestos explícitos de ModelOpt evitan la ruta de exportación innecesaria de descarga de CPU de Accelerate. El contenedor de compilación también establece memoria bloqueada ilimitada y una pila de 64 MiB, siguiendo los requisitos de lanzamiento de cuantificación de [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Estas configuraciones tienen como alcance el contenedor de compilación, no los límites de todo el host.

## 4. Entradas del paquete completo

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

La fusión debe reportar **41 roles y ningún rol faltante**. Verifica la arquitectura de la imagen/ID de contenido y rechaza resultados conflictivos. Los recursos contienen solo firmware UEFI ascendente (incluida una nueva plantilla de almacenamiento de variables), un controlador ISO virtio fijado con suma de verificación, tiempo de ejecución de dibujo fuente y avisos de Android vinculados a las imágenes recién creadas. La ISO no es un medio de instalación de Windows. Su espejo Microsoft OpenVMM con suma de verificación idéntica evita depender de una página de descarga interactiva de Fedora.

Recopile paquetes de host con `collect_host_packages.py` como se describe en [README.md](README.es.md), luego genere la plantilla con `prepare-release.py --template`. Llene su mapa de imágenes desde `images.json`; llenar los 12 roles de activos de los resultados del modelo, `resources/assets.json` and `guest-tools`. Establezca `sourceCommit` en el pago y la versión real del agente. No se aceptan marcadores de posición ni configuraciones de instalación previas.

Ejecute `prepare-release.py --inputs … --output …` y luego `build-package.sh` usando esa versión preparada. Las fuentes modificadas/no confirmadas requieren el indicador de candidato `--allow-working-tree` explícito; no son un compromiso liberado. Consulte [PACKAGE-README.md](PACKAGE-README.es.md) para la instalación. Una nueva base de datos de cuentas en blanco obtiene `admin/admin`; Todas las credenciales de servicio y la identidad del dispositivo se generan de forma independiente. Las compilaciones por sí solas no prueban que la instalación haya sido exitosa.

## Recetas históricas en capas y verificaciones de publicaciones

Los Dockerfiles de diagnóstico/en capas más antiguos se conservan para el mantenimiento del código fuente y no se utilizan en esta canalización. Sus argumentos `BUILD_PARENT_N` intencionalmente no tienen una imagen privada predeterminada. Proporcione un padre compatible que haya creado o utilice la tubería pública anterior; No adivine un resumen de desarrollo no disponible.

Antes de publicar, ejecute la protección de código fuente y el escáner secreto, revise el historial por separado y excluya todos los directorios de compilación, paquetes, discos invitados, datos de cuentas y el sitio web privado. Los informes que contienen rutas locales pertenecen fuera del árbol público. La verificación de este trabajo se limita al cierre de entrada de la compilación, la identidad del artefacto, la instalación y las rutas de servicio mínimas recién instaladas; no vuelve a ejecutar la aceptación comercial no relacionada.
