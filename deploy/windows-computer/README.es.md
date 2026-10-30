<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.es.md)
<!-- doc-navigation:end -->

# Tiempo de ejecución de computadora virtual ARM

`Public.Dockerfile` crea la misma capacidad de presencia física (PPI) de ARM TPM requerida por el tiempo de ejecución original `windows-arm64-ppi`. Construye QEMU 11.1.1 a partir del lanzamiento oficial después de verificar su firma separada con la huella digital del administrador de lanzamiento fijada. Debian proporciona las bibliotecas y herramientas del contenedor, no el ejecutable QEMU utilizado para ejecutar invitados.

No reemplace este ejecutable con un paquete QEMU de distribución anterior. Los perfiles de Windows habilitan `tpm-tis-device,...,ppi=on`; una compilación sin esa propiedad ARM sale antes de que se inicie el firmware. Quitar `ppi=on`, deshabilitar el TPM o restablecer el TPM de un invitado no es una reparación compatible.

La compilación de la imagen final verifica la compatibilidad con ARM TIS PPI y PulseAudio e incluye la ROM del framebuffer RAM correspondiente. En un host KVM ARM, el `python3 /usr/local/bin/probe-ppi` incluido realiza una verificación QEMU/TPM en pausa y sin disco. No monta discos invitados existentes ni prueba que se haya completado la instalación de Windows. El arranque de Windows debe comprobarse por separado en un invitado de prueba designado explícitamente.

Para una instalación existente, utilice la política de actualización del tiempo de ejecución de la plataforma y el resumen de la imagen del perfil del Agente de Nodo correspondiente. Preservar el disco, el firmware, la identidad y el estado del TPM. No vuelva a crear invitados ni cambie las imágenes de invitados de Linux en ejecución simplemente para reparar el tiempo de ejecución de Windows. Registre las imágenes creadas localmente como no publicadas hasta que se confirmen y publiquen los cambios de origen.

Conserve la propiedad de la configuración instalada y los permisos de lectura al actualizarla. Si se vuelve a crear Platform API para cargar la política de actualización en tiempo de ejecución, también se vuelven a crear sus dependientes del espacio de nombres de red (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` y `maintenance-controller`) a partir de sus imágenes sin cambios. Deben unirse al espacio de nombres de red del nuevo contenedor API. Este no es un reinicio de invitado, demonio Docker o trabajador de IA. Espere a que el latido autenticado normal del nodo restablezca la preparación antes de enviar una operación de inicio de Windows.
