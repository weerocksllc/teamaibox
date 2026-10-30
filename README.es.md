<!-- Generated from docs/readme-locales/es.json by tools/render-readmes.mjs. -->
# Team AI Box — Software de código abierto para NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Convierte tu NVIDIA DGX Spark en el espacio de IA de tu equipo.** Ejecuta IA local, generación de imágenes y herramientas de documentos en NVIDIA DGX Spark. Team AI Box reúne archivos de equipo, mensajería y dispositivos virtuales en un espacio de código abierto desde el navegador.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

## ¿Por qué Team AI Box?

- **Un espacio integrado:** cuentas e interfaz coherentes para IA, colaboración y dispositivos.
- **Local primero:** inferencia en tu Spark; las API externas son opcionales y no se requiere llave USB.
- **Creado para DGX Spark:** Ubuntu ARM64, contenedores GPU NVIDIA y KVM, sin depender de la configuración del desarrollador.
- **Abierto a contribuciones:** código propio MIT, 17 idiomas, temas claro/oscuro y preferencias manuales guardadas. El idioma inicial es inglés.

## El espacio real

Captura real en español, no una maqueta. Se adapta al tema de GitHub; abajo están ambos originales. No incluye archivos de clientes ni credenciales. Los resultados del modelo, sistemas invitados y nombres personalizados tienen otros ajustes de idioma.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/es/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/es/workbench-light.jpg">
  <img src="docs/assets/screenshots/es/workbench-light.jpg" alt="Espacio Team AI Box para NVIDIA DGX Spark con aplicaciones de IA y herramientas de equipo — Español" width="1280">
</picture>

[Tema claro](docs/assets/screenshots/es/workbench-light.jpg) · [Tema oscuro](docs/assets/screenshots/es/workbench-dark.jpg)

## IA local y aplicaciones de equipo en DGX Spark

### Asistente de IA

Pregunta, redacta, revisa y resume información o documentos mediante una conversación. Usa modelos locales o conecta proveedores externos si lo deseas.

### Generación de imágenes

Genera y edita imágenes con instrucciones, guarda los resultados y consulta el progreso de las tareas.

### Reconocimiento de texto

Extrae texto y estructura de imágenes y documentos para revisarlos y reutilizarlos.

### Transcripción

Convierte audio y vídeo en texto con marcas de tiempo para actas, subtítulos y trabajo posterior.

### Traducción

Traduce texto y archivos compatibles. Los idiomas dependen del modelo instalado y son distintos de los idiomas de interfaz.

### Mensajería

Conversaciones privadas y grupos junto a los archivos del equipo. Gestiona mensajes y elimina chats mediante controles visibles.

### Disco de equipo

Sube, organiza, comparte y reutiliza archivos, seleccionándolos directamente en las aplicaciones compatibles.

### Proyección inalámbrica

Ve y escucha la pantalla de dispositivos Apple compatibles en un navegador e invita a compañeros. La detección requiere conectividad LAN adecuada.

### Teléfonos Android virtuales

Instala aplicaciones y conserva el estado de cada teléfono en el navegador. Cada dispositivo guarda sus propios datos; Google mantiene sus condiciones de compatibilidad y licencia.

### Ordenadores Windows y Linux virtuales

Sube una ISO ARM64 autorizada o selecciónala en el disco de equipo, monta la unidad óptica virtual e instala el sistema. El monitor muestra arranque y reinicios, con audio. Invita a observar o controlar, transfiere o comparte el control y recupéralo como propietario. El escritorio remoto es un modo adicional.

### Administración y tareas

Crea cuentas, gestiona accesos y observa la disponibilidad y el progreso. Cada aplicación se habilita cuando sus dependencias están listas; el primer inicio del modelo puede tardar.

## ¿Qué es NVIDIA DGX Spark?

NVIDIA DGX Spark es un sistema compacto de IA de escritorio con el superchip GB10 Grace Blackwell. La configuración de 128 GB combina una CPU Arm de 20 núcleos, una GPU Blackwell y 128 GB de memoria unificada del sistema con un ancho de banda de 273 GB/s. NVIDIA especifica hasta 1 PFLOP de cálculo de IA teórico en precisión FP4 con dispersión.

La memoria unificada es memoria compartida del sistema, no VRAM dedicada. Las especificaciones dependen de la configuración; el cálculo teórico no garantiza velocidad de las aplicaciones ni capacidad de usuarios simultáneos.

DGX Spark aporta el cálculo. Team AI Box añade una interfaz compartida para inferencia local, generación de imágenes, OCR, transcripción, traducción y colaboración. La primera instalación desde el código requiere descargas y compilaciones; no es instantánea.

[Especificaciones oficiales de NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box es un proyecto independiente de Weerocks LLC, no un producto, certificación o respaldo de NVIDIA. El hardware compatible se define en los requisitos de instalación que figuran a continuación.

<a id="install"></a>

## Instalar en un DGX Spark nuevo

Necesitas un **DGX Spark sin instalación previa, con Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, controladores y contenedores NVIDIA operativos, KVM, Git y Python 3.10+. Reserva varios cientos de GB temporales para modelos, compilaciones y paquete. No hagas una instalación nueva sobre datos existentes.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Ejecuta los comandos **en el Spark**. El script descarga entradas y modelos, construye imágenes, genera un paquete sin conexión completo y lo instala. La primera compilación necesita Internet y tiempo; clonar no equivale a instalar. Reutiliza Docker/NVIDIA sin copiar cuentas, discos ni credenciales de desarrollo.

### Comprobación y reanudación

`--check` comprueba requisitos. Si se interrumpe, conserva `/var/tmp/teamaibox-source-build` y repite **el mismo comando**: se reutilizan descargas verificadas y pasos completados. No borres la caché ni ejecutes compilaciones simultáneas. Por defecto usa fuentes oficiales. Si no son accesibles, consulta [la guía](install/SOURCE-INSTALL.es.md) para alternativas o transferencia de caché/paquete verificado; ningún espejo garantiza disponibilidad. Si cambia el código, usa otro `--work-dir`, sin eludir controles.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Después de instalar

1. Abre `https://<BOX_LAN_IP>/` con la dirección LAN actual y verifica el certificado HTTPS generado por tu dispositivo.
2. Entra con `admin` / `admin`, **cambia la contraseña inicial** y crea cuentas normales. No expongas las credenciales iniciales a Internet.
3. Espera a que cada aplicación esté lista y elige idioma/tema en el perfil. Estado: `/srv/teamaibox/installation/readiness.json`.
4. Aporta ISO ARM64 y licencias autorizadas de Windows/Linux. Para un destino sin conexión, prepara el paquete completo y sigue [la guía](install/README.es.md); preparar desde el código requiere conexión.

## Licencia y límites

Código propio y documentación son MIT, **no todos los binarios instalados**. Terceros, modelos, NVIDIA, firmware, Google y Windows conservan sus condiciones. Git no contiene pesos, discos invitados instalados, sesiones, ISO ni paquetes. Compatibilidad con Google no significa certificación Play Protect; proyección no incluye DRM ni certificación Apple. No se declara soporte para Windows 10 ARM64. Rendimiento y concurrencia dependen de la carga y del equipo. El sitio comercial permanece privado y separado; la interfaz del producto es pública.

## Construyámoslo juntos

Bienvenidos informes de errores, documentación, traducciones, accesibilidad, integraciones y código. Explica el problema en una issue, crea un fork y una rama enfocada y envía una PR con comprobaciones y capturas pertinentes. No necesitas Spark para documentación o componentes aislados; indica qué se verificó realmente en hardware. No publiques secretos, archivos personales ni imágenes con sesiones iniciadas. Comunica vulnerabilidades en privado según SECURITY.md. No hay CLA obligatorio ni permiso de pago.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.es.md) · [SECURITY](SECURITY.es.md)

## Más información

- [Instalación desde código y recuperación](install/SOURCE-INSTALL.es.md)
- [Paquete sin conexión](install/README.es.md)
- [Desarrollo y compilación](docs/open-source/BUILDING.es.md)
- [Cómo contribuir](CONTRIBUTING.es.md)
- [Avisos privados de seguridad](SECURITY.es.md)
- [Licencias de terceros y alcance de distribución](THIRD_PARTY_NOTICES.es.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Licencias de terceros y alcance de distribución](docs/open-source/RELEASING.es.md)
