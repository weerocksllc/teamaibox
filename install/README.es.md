<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.es.md)
<!-- doc-navigation:end -->

# Team AI Box herramientas de paquete fuera de línea

El instalador original tiene licencia MIT. Los paquetes incluyen la licencia raíz, el inventario de terceros y los textos de la licencia en su inventario de hash de archivos. Esto no renueva la licencia de modelos, servicios de Google, controladores ni dependencias de contenedores como MIT. Lea los [límites de publicación](../docs/open-source/RELEASING.es.md) antes de la distribución; un paquete de prueba completo existente no tiene automáticamente autorización de redistribución.

Los clientes ejecutan **`sudo ./install.sh` dentro del paquete preparado**. Los mantenedores crean ese paquete con `build-package.sh`. Los clientes sin conexión no necesitan Git, Node, Go, pip ni repositorios de paquetes públicos.

Para descargar, compilar e instalar automáticamente desde un clon público, ejecute `sudo bash install/from-source.sh`. Las redes en China pueden usar `--region cn`. Consulte [SOURCE-INSTALL.md](SOURCE-INSTALL.es.md) para conocer el funcionamiento, la reanudación y la transferencia sin conexión. Se admite el currículum; sólo el resultado final de preparación establece la finalización de la instalación. Una verificación previa o una descarga exitosa no es suficiente.

El objetivo es un DGX Spark nuevo con su sistema Ubuntu 24.04 ARM64 de fábrica y Docker Engine, Compose v2, NVIDIA Container Toolkit/GPU y KVM en funcionamiento. El instalador no reemplaza Docker/NVIDIA, no reinicia Docker ni copia las cuentas, la base de datos, las claves o las máquinas virtuales de un dispositivo de desarrollo.

> Los registros de aceptación de instalaciones privadas permanecen en el depósito de desarrollo histórico. No son archivos fuente públicos ni entradas de compilación. La evidencia existente de primera instalación, reanudación y recuperación de arranque no se vuelve a ejecutar simplemente para la publicación del código fuente y no califica imágenes arbitrarias recién creadas ni otorga derechos de redistribución para archivos binarios de terceros.

## Mantenedores: preparar entradas de lanzamiento

**Para una nueva compilación pública de GitHub, comience con [PUBLIC-BUILD.md](PUBLIC-BUILD.es.md).** Cubre imágenes públicas, tiempos de ejecución de cámaras, descargas/cuantización de modelos y firmware sin requerir imágenes de un dispositivo de desarrollo. Los ayudantes de imágenes en capas a continuación admiten actualizaciones incrementales de artefactos verificados; no son requisitos previos para una nueva construcción.

La preparación puede utilizar Internet. La instalación desde el paquete entregado no debe descargar dependencias. El host de empaquetado necesita Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` y suficiente almacenamiento. Los modelos y las imágenes pueden ser grandes; el empaquetador conserva tanto el árbol extraído como `.tar`, estimando el espacio a partir de las entradas reales. No escanea un dispositivo de desarrollo completo ni exporta capas grabables desde contenedores en ejecución.

1. Prepare imágenes ARM64 a partir de **una versión** para todas las funciones requeridas. Utilice los puntos de entrada de compilación en `deploy/images/`, `deploy/appliance/` y los directorios de invitados/modelos correspondientes. La API de plataforma, el agente de nodo, el programador y el controlador del agente deben admitir ID de imagen locales; la imagen de PostgreSQL debe contener el manifiesto de migración actual, incluida la migración 116. El empaquetador no compila una imagen antigua arbitraria en una actual. Con imágenes principales verificadas de la misma versión, use `build_runtime_images.py --bases … --node-agent-binary … --output …` para crear las cinco imágenes sucesoras. `--bases` es un mapa JSON de rol a ID de imagen completa. Primero cree Node Agent con `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Este asistente prohíbe extracciones/construcción de redes, registra identidades principales/fuentes y crea nuevas imágenes sin implementar ni cambiar etiquetas activas. Las ROM limpias de Android también necesitan el adaptador de red de control actual. Utilice `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` para agregar `phone_network.py` a ambas capas sucesoras de ROM sin acceso a la red ni cambios en los datos de la ROM. Registra identificaciones de imágenes exactas y resúmenes de fuentes. Vincula el sidecar de Android a ambas ID nuevas, no a las anteriores. Crea la web y nueve aplicaciones oficiales usando `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Primero cree la web según lo especificado por `apps/web/package.json`. El asistente utiliza Dockerfiles de producción, corrige el directorio web en `/opt/teamaibox/web` y compara archivos de imagen con hashes de entrada de compilación actuales. No asuma que una imagen de contenedor de desarrollo es una compilación web completa: puede depender de variables de directorio estático adicionales o contener un directorio antiguo. Este asistente sin conexión no se implementa. Coloque las diez nuevas identificaciones de imágenes en las entradas de lanzamiento.
2. Recopile directorios completos y limpios para seis modelos: configuración, fragmentos, tokenizadores, código requerido y licencias. También prepare dos imágenes limpias de Android, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` y los scripts de tiempo de ejecución del dibujo. No recopile directorios de instancias telefónicas, discos de usuarios, estados de inicio de sesión de Google, ISO de usuarios ni credenciales globales. Las ROM de Android ya están dentro de `phone-runtime` / `phone-google-runtime`; no copie un segundo disco. Los directorios de activos `android-standard` / `android-google` contienen solo procedencia, licencias y `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` y `runtimeImageId: "sha256:…"`. El ID debe coincidir con la imagen de tiempo de ejecución exportada. El directorio del controlador contiene solo `virtio.iso`; se rechaza un directorio de desarrollo que también contenga `windows.iso`.
3. Compile las dos herramientas de host Linux ARM64 incluidas sin instalarlas en el host de compilación:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. En un host de compilación ARM64 conectado a Internet, recopile las dependencias de las herramientas del host utilizando una imagen local explícita de Ubuntu 24.04. Utilice la ID de imagen verificada en ese host, no una ID copiada de un dispositivo de desarrollo:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Recopile solo dependencias para cryptsetup, ext4, USB/cámaras, herramientas de imagen QEMU, redes y pequeñas utilidades del sistema. Los paquetes Docker, Containerd, NVIDIA, CUDA y de reemplazo del kernel están prohibidos. La instalación suministra únicamente las herramientas que faltan; apt lee el repositorio de archivos local del paquete con `--no-download --no-remove`, sin un respaldo en línea.

5. Genere el manifiesto de entrada de lanzamiento y proporcione **rutas de artefactos explícitas e ID de contenido de imagen local**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   La plantilla incluye los 41 roles de imagen y 12 categorías de activos externos; Otro activo de fábrica es generado por las herramientas. Los marcadores de posición no pueden ingresar a un paquete. `sourceCommit` debe coincidir con el pago, `agentVersion` la compilación real del Agente y `hostPackageCollection` el paso 4 `collection.json`. Las rutas de compilación-host son entradas de colección, no configuración de tiempo de ejecución del cliente. Utilice el generador de fábrica actual: las rutas `drawing.automatic` / `drawing.fast` de la interfaz de usuario del dibujo deben coincidir con la configuración del modelo local. La salud del trabajador o una llamada directa al modelo por sí solas no establecen la preparación para la solicitud. El embalaje rechaza las plantillas de fábrica obsoletas a las que les faltan estas asignaciones.

El contrato de rol de imagen lo informa `python3 install/package.py --describe-contract`:

- Núcleo, web, unidad de equipo, mensajería, puertas de enlace, programador, mantenimiento, complementos, entornos limitados de agentes dinámicos y puertas de enlace de origen de paquetes.
- Nueve complementos de aplicaciones, seis trabajadores modelo de oficina y tiempos de ejecución de altavoces/ASR bajo demanda.
- Android estándar, Google Android, tiempo de ejecución de computadora y puertas de enlace de audio/visualización web.
- Receptor de casting, procesamiento de medios y SFU.

Dos roles pueden compartir una ID de contenido de imagen; su archivo se exporta sólo una vez. Los índices de fragmentos de modelo también se verifican: los hashes de archivos coincidentes no excusan la falta de un fragmento. Las herramientas del host deben ser archivos binarios ARM64 ELF reales.

## Construye el paquete

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Las salidas son `teamaibox-<releaseId>-linux-arm64.tar`, su archivo `.sha256` y el directorio extraído. La copia, la exportación de imágenes, el hash y el archivado se realizan en un directorio temporal antes de que se publique la suma de verificación final. Las salidas existentes no se sobrescriben; una compilación interrumpida no debe parecer una versión completa. Para cambios exclusivos del instalador con identidades de imagen sin cambios, use `--image-cache <previous-extracted-package>`. Todo el paquete antiguo se verifica antes de que sus archivos se reutilicen mediante la identificación de la imagen real y el nuevo paquete se verifica nuevamente. No se toman datos de una instalación antigua o de una capa grabable de contenedor. Esto evita volver a exportar cientos de GB de imágenes idénticas.

Una versión normal requiere que los archivos fuente incluidos pertenezcan al compromiso de Git declarado. Un `--allow-working-tree` explícito crea un candidato de desarrollo; su manifiesto registra `candidate: true` y archivos modificados. Pasar la aceptación enfocada no convierte una fuente no confirmada en una versión publicada.

Diseño del paquete:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Verifique de forma independiente con `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Esto verifica la integridad; no demuestra un arranque exitoso en hardware nuevo.

## Clientes: instalación sin conexión y reanudación

Lea la [guía de instalación del paquete](PACKAGE-README.es.md). La raíz predeterminada es `/srv/teamaibox/installation`. LUKS/ext4 se crea solo dentro del nuevo `volume/data.img`, no en el disco del sistema ni en los discos existentes. El grupo de datos utiliza el almacenamiento disponible menos un margen de seguridad física, no un límite fijo de 256 GiB. Los modelos, archivos comerciales y datos de los huéspedes residen en el volumen cifrado; Docker existente gestiona las imágenes del contenedor.

Una instalación nueva crea el administrador `admin` con la contraseña inicial `admin`. Los usuarios normales son creados por el administrador. Cambie la contraseña inicial antes de la entrega/uso. Esto se aplica solo a una base de datos de cuentas vacía: reanudar, ejecutar, reiniciar y actualizar no restablecen cuentas ni contraseñas existentes. La identidad del dispositivo, las credenciales de servicio, los certificados y los códigos de recuperación del administrador se generan de forma independiente, no se copian desde otro dispositivo. La preparación inicial de la caché del kernel de la GPU se ejecuta en el dispositivo utilizando herramientas y modelos incluidos; Se conservan las cachés compatibles. La recuperación de arranque restaura primero los datos y los servicios del dispositivo, luego los servicios principales y los trabajadores de IA individuales. El instalador se ejecuta únicamente durante la instalación; no agrega ningún administrador de instalación residente.

Después de la interrupción, repita el comando original. Se verifican los pasos completados; no oculte conflictos eliminando datos o recreando contenedores. Volver a ejecutar una instalación completa de la misma versión solo la verifica; Diferentes versiones utilizan la ruta de actualización formal. Los detalles del error se encuentran en `install-state.json`, `readiness.json` y en los registros de etapa en la raíz de instalación.

## Límites de verificación

Las pruebas específicas del instalador utilizan pequeños artefactos estructurales, archivos temporales y bases de datos aisladas fuera de línea/demonios Docker. No deben acceder a bases de datos comerciales ni montar discos de VM existentes. Una instalación nueva real requiere un DGX Spark compatible designado explícitamente para ese propósito; no borre un dispositivo comercial. La aceptación cubre el inicio mínimo, la reanudación y la recuperación de arranque para la nueva instalación, no pruebas comerciales no relacionadas. La preparación del lanzamiento del código fuente en sí no borra, reinstala ni implementa dispositivos existentes.

En un host de compilación, ejecute `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` para importar el paquete completo a un demonio Docker independiente con una caché vacía y sin red pública. No invoca el script de nueva instalación, no utiliza una GPU, no monta directorios de clientes ni reinicia el sistema Docker. Su informe no afirma explícitamente la instalación completa del hardware. Las imágenes de prueba permanecen en el directorio de prueba dedicado, necesitan espacio adicional en el disco y no ingresan al almacén de imágenes de Docker del sistema.
