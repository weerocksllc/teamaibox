<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.es.md)
<!-- doc-navigation:end -->

# Contribuyendo

Gracias por ayudar a mejorar Team AI Box. Damos la bienvenida a quienes contribuyen por primera vez: los informes de errores, las traducciones, la documentación, la accesibilidad, las integraciones de aplicaciones y los cambios de código específicos cuentan. No necesita un DGX Spark para mejorar documentos o componentes que se pueden verificar de forma independiente.

## De una idea a una solicitud de extracción

1. Busque [problemas existentes](https://github.com/weerocksllc/teamaibox/issues). Describa el problema del usuario, el comportamiento esperado, el comportamiento real y la versión relevante. Analice cambios más importantes antes de invertir en una implementación.
2. Bifurca el repositorio público y clona tu bifurcación. Cree una rama enfocada; no incluya el sitio web de marketing privado, los datos de tiempo de ejecución ni los modelos descargados.
3. Siga [EDIFICIO](docs/open-source/BUILDING.es.md) para compilaciones de componentes locales, pnpm y nodos. El instalador de dispositivos nuevos es un flujo de trabajo diferente: nunca lo ejecute en una máquina que contenga datos comerciales solo para desarrollar la interfaz de usuario.
4. Realice el cambio coherente más pequeño, actualice la documentación afectada y realice las comprobaciones pertinentes. Explique cualquier comprobación dependiente del hardware que no haya podido ejecutar.
5. Abra una solicitud de extracción que describa el problema, la solución, el impacto de la compatibilidad y las comprobaciones. Incluya capturas de pantalla desinfectadas para cambios visibles. Responder a los comentarios de revisión; Los mantenedores revisan antes de fusionarse.

Un espacio de trabajo local de OpenSpec es opcional y no se publica en este repositorio. Los contribuyentes públicos pueden incluir una propuesta y criterios de aceptación directamente en un número o PR; No se requiere ninguna especificación privada faltante para participar.

## Traducciones y capturas de pantalla

Los 17 idiomas de los productos tienen un archivo README. Edite `docs/readme-locales/<locale>.json` y luego ejecute `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. No edite manualmente los archivos README generados. La lista de configuración regional proviene de `packages/ui-system/src/locale-registry.mjs`. Las guías vinculadas de instalación, compilación, contribución, seguridad y licencias utilizan los mismos 17 idiomas. Su lista de documentos está en `docs/document-locales/manifest.json`. Edite la página del idioma de origen y las traducciones de párrafos en `docs/document-locales/<locale>.json`, luego ejecute `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. Las claves de traducción son hashes SHA-256 de párrafos fuente; un cambio de fuente falla en el renderizador hasta que se actualizan las traducciones correspondientes. Los ejemplos de código se comparten palabra por palabra y se generan enlaces a documentos para el idioma seleccionado. Las nuevas traducciones son borradores asistidos por máquina con código y enlaces protegidos; Se agradece la revisión lingüística y terminológica. La generación y las comprobaciones se ejecutan localmente, sin servicio de traducción, clave API ni acceso a un dispositivo. Consulte [la política de captura de pantalla](docs/assets/screenshots/README.es.md) antes de agregar imágenes públicas. Las traducciones, incluida la terminología y la redacción natural, son contribuciones de revisión bienvenidas.

## Reglas de contribución

- Las contribuciones originales se envían bajo la licencia MIT del repositorio. Conserve los encabezados de terceros e indique la fuente/licencia del material copiado. No se requiere CLA obligatorio por separado ni permiso de colaborador pagado.
- Utilice el Nodo 24 y la versión pnpm fijada en `package.json`. Los requisitos de Python y Go se describen en [EDIFICIO](docs/open-source/BUILDING.es.md).
- Ejecute solo pruebas relevantes para su cambio e informe exactamente lo que se ejecutó. Un dispositivo local no es un reclamo de aceptación real del dispositivo. No repita ni borre los resultados históricos de aceptación simplemente para cerrar un cambio de documentación.
- Nunca pruebes la eliminación, reinstalación o recuperación con los datos de un usuario. Utilice accesorios sintéticos o recursos temporales explícitamente designados.
- No se permiten claves privadas, tokens, cookies, mensajes/archivos de clientes, imágenes de invitados registrados, instantáneas de implementación privadas ni capturas de pantalla personales en problemas/PR. Consulte [SEGURIDAD](SECURITY.es.md) para obtener informes privados.
- Mantener `private: true` en los paquetes del espacio de trabajo. Nunca reescribas el historial de Git compartido, ni muevas etiquetas de entrega ni publiques artefactos de compilación privados como parte de un PR.

Documente pruebas, migraciones y cambios de comportamiento relevantes en su contribución. Las comprobaciones dependientes del hardware deben identificar la configuración y los límites reales.
