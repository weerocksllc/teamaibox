<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.es.md)
<!-- doc-navigation:end -->

# Capturas de pantalla públicas del producto

Estas son capturas reales del banco de trabajo Team AI Box, una imagen clara y otra oscura para cada una de las 17 configuraciones regionales de la interfaz de usuario. Son activos de documentación del producto, no la fuente, las plantillas o los resultados de compilación del sitio web de marketing privado.

## Reglas de captura

- Utilice el idioma real del producto y los controles temáticos; no traduzca etiquetas a una captura de pantalla en inglés ni invente un resultado exitoso.
- Utilice una cuenta de demostración e inspeccione cada imagen en busca de mensajes personales, nombres de archivos, credenciales, PIN de receptor, direcciones de red y navegador Chrome. Nunca publique un disco invitado con sesión iniciada o una exportación de sesión/cookie con imágenes.
- Las capturas actuales del banco de trabajo muestran solo el estado de la tarea de demostración genérica y la cuenta de administrador genérica. No exponen cargas útiles de tareas.
- Mantenga la configuración del producto como estaba después de la captura. No elimine datos de usuario ni vuelva a ejecutar cargas de trabajo comerciales para obtener una captura de pantalla.
- `workbench-light.jpg` and `workbench-dark.jpg` son los originales. La mayoría utiliza la captura de página completa. El árabe utiliza la ventana gráfica real porque la captura RTL de página completa del navegador desplazó la página; no se modificaron etiquetas ni resultados.
- Algunas palabras de estado de tareas en vivo todavía están en inglés en vistas localizadas. Estas imágenes preservan intencionalmente la interfaz de usuario enviada en lugar de retocarla. Los sistemas operativos invitados, las respuestas de los modelos y los nombres definidos por el usuario tienen configuraciones de idioma independientes y el selector de interfaz de usuario no los traduce.

El procesador README requiere ambas imágenes para cada configuración regional del producto y falla en lugar de recurrir silenciosamente a una captura de pantalla en inglés. Al actualizar la interfaz de usuario, reemplace ambos temas y regenere el manifiesto de imagen con `node tools/screenshot-manifest.mjs`. Mantenga los identificadores de red/dispositivo y los registros de captura local fuera de este directorio público.
