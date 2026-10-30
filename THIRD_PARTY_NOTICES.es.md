<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.es.md)
<!-- doc-navigation:end -->

# Alcance de la licencia y avisos de terceros

Copyright © 2026 Weerocks LLC. La licencia raíz [MIT](LICENSE) cubre el código original Team AI Box y la documentación autorizada por su propietario. No otorga nuevas licencias de código de terceros, archivos ascendentes copiados/modificados, dependencias, modelos, firmware, sistemas operativos, fuentes o imágenes. Los archivos de copyright, LICENCIA y AVISO existentes tienen prioridad sobre su material respectivo. Los metadatos del paquete `license: MIT` se refieren al código original de ese paquete, no a todo lo incluido en una imagen implementada. `private: true` se conserva para evitar la publicación accidental del registro de paquetes; no revoca la concesión MIT.

## Inventario

El [inventario de componentes](docs/open-source/components.json) legible por máquina registra versiones o fuentes de versiones, pruebas de licencia, alcance de redistribución y obligaciones binarias no resueltas. El [inventario de dependencia](docs/open-source/dependencies.json) se genera a partir del archivo de bloqueo, los metadatos de dependencia instalados, los módulos Go y los archivos de requisitos de Python. Los metadatos de licencia que faltan se desconocen explícitamente, no se asumen MIT. Regenerarlo con `python3 tools/open_source_inventory.py`.

| Componente / material | Límite de licencia | Requisitos de distribución |
| --- | --- | --- |
| Receptor UxPlay y `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Conserve GPL, avisos, fuentes ascendentes exactas, parches y scripts de compilación con cualquier receptor binario; simplemente vincular a aguas arriba es insuficiente para una versión binaria. |
| gst-complementos-rs / `gst-webrtc-*.patch` | MPL-2.0 | Conservar los avisos y poner a disposición los archivos fuente cubiertos modificados. |
| Streamer | LGPL y licencias de complementos individuales | Inspeccione el conjunto de complementos real y cumpla con las obligaciones correspondientes. |
| SDK de servidor/navegador LiveKit | Apache-2.0 | Conserva los derechos de autor, la licencia y el AVISO aplicable. |
| Sepia / AOSP | Apache-2.0 y licencias por archivo, incluido el kernel GPL | Preservar los avisos ascendentes y la fuente correspondiente aplicable. AOSP no incluye una licencia de servicios de Google. |
| Controladores QEMU/Linux/EDK II/virtio | Licencias por proyecto y por archivo | Audite la compilación binaria, el firmware y los controladores reales; no etiquete de forma general MIT. |
| Guacamole | Apache-2.0 | Conserve la LICENCIA y el AVISO copiados por el complemento informático Dockerfile. |
| Árbol de dependencias de Nodo/React/Vite y JS | Licencias por paquete | Conserve los avisos de dependencia al distribuir la salida empaquetada. |
| Paquetes de sistema operativo PostgreSQL y contenedor | PostgreSQL / por paquete | Incluya registros de licencia de paquetes instalados en una versión binaria. |
| PyMuPDF / MuPDF utilizado por OCR | AGPL-3.0-or-later o licencia comercial | La distribución/servicio combinado de trabajadores de OCR no es general MIT; cumplir con las obligaciones de AGPL u obtener derechos comerciales. El código original puede conservar su concesión MIT. |
| Activos del modelo Qwen / LMT / Whisper / FLUX | Términos exactos del modelo | Los modelos son independientes de la concesión de origen MIT. Los términos FLUX **4B** no deben sustituirse por otro modelo FLUX. |
| Pesos HunyuanOCR | Licencia comunitaria Tencent Hunyuan | Licencia de modelo condicional; revise los términos de destinatario, territorio, uso, atribución y redistribución de cada lanzamiento. |
| NVIDIA software | NVIDIA y términos de terceros incluidos | Este paquete fuente no redistribuye la instalación existente de Docker/NVIDIA del host. Las bibliotecas CUDA/contenedores incluidas todavía necesitan su propia revisión. |
| Servicios móviles de Google/Play Store | Propietario | No forma parte del candidato de fuente pública. El código de integración en tiempo de ejecución no otorga derechos para distribuir imágenes GMS. |
| Medios de instalación de Windows, discos invitados, cuentas | No cubierto | Los usuarios proporcionan licencias y medios ISO autorizados. Nunca envíe discos de VM de prueba ni estados de invitado con sesión iniciada. |
| SDK de ViKey retirado | Propiedad/no se ha establecido ninguna subvención pública | SDK eliminado de la fuente de trabajo; Las confirmaciones históricas privadas y las copias del SDK retenidas no deben publicarse. No se requiere ninguna llave USB. |

Los avisos de casting exactos permanecen en [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Los avisos de transporte ADB permanecen al lado del cliente telefónico. No los retire mientras ministra o empaqueta. El aislamiento del contenedor por sí solo no cancela las obligaciones de copyleft. El análisis de distribución depende del artefacto combinado real.

## Marca y colaboradores

MIT otorga permiso de derechos de autor, no derechos de marca registrada ni respaldo. Team AI Box y los nombres/logotipos de Weerocks no deben implicar soporte oficial para un producto modificado. NVIDIA, DGX Spark, Android, Google Play, Windows y Apple/AirPlay pertenecen a sus respectivos propietarios. La compatibilidad no es certificación.

Los metadatos del autor local son un inventario, no una prueba de cesión de derechos de autor. Las categorías de propiedad revisadas se registran en [OWNERSHIP.md](docs/open-source/OWNERSHIP.es.md). La autorización del titular del proyecto se aplica a sus aportes originales; los contribuyentes deben enviar únicamente trabajos para los que tengan derecho a licencia. Atribución presuntamente faltante: teamaibox@weerocks.llc.
