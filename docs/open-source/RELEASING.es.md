<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.es.md)
<!-- doc-navigation:end -->

# Liberar límites

## Artefactos separados

1. **MIT fuente candidata**: código original, especificaciones actuales, herramientas de compilación/prueba revisadas y avisos; sin historial de Git ni evidencia de laboratorio privado.
2. **Material de terceros**: fuente/binarios/modelos ascendentes exactos con su propia licencia y atribución. Las obligaciones de fuente copyleft viajan con binarios.
3. **Paquete completo de dispositivos sin conexión**: creado por `install/`; no tiene licencia automática para su redistribución pública. Los componentes GMS, HunyuanOCR, NVIDIA y las licencias de firmware/invitado requieren una revisión específica del artefacto. No publique el paquete privado, los paquetes de modelos ni las imágenes iniciadas bajo la etiqueta MIT.
4. **Sitio web de marketing**: `website/`, incluidas sus plantillas de artículos, contenido, recursos de diseño, análisis y configuración de implementación, permanece en el repositorio privado de GitHub `weerocksllc/teamaibox.com`. GitLab es un archivo histórico, no un repositorio de desarrollo de sitios web. El sitio web no forma parte de la distribución de fuentes públicas del producto. La interfaz de usuario del navegador del dispositivo en `apps/` sigue siendo parte del producto de código abierto.

Los scripts históricos de implementación, recuperación y registro de evidencia en un solo dispositivo no son herramientas de producto reutilizables. La política de publicación excluye scripts e instantáneas retirados; no los restaure desde el archivo privado. Las herramientas retenidas requieren objetivos explícitos proporcionados por el operador en lugar de hosts, cuentas, contenedores o archivos de evidencia de un desarrollador. Ejecute el análisis confidencial complementario, así como Gitleaks: los ID de dispositivos, ID de contenedores, hashes GSF y nombres de cuentas personales están probando metadatos incluso cuando no son credenciales de inicio de sesión utilizables. La limpieza del historial público requiere la autorización explícita del propietario y nunca debe reescribir el archivo privado ni sus etiquetas de entrega. Después de una reescritura autorizada, utilice un clon público nuevo en lugar de fusionar el historial retirado nuevamente en el repositorio mantenido.

El repositorio de desarrollo interno y sus etiquetas permanecen intactos. Su historial accesible contiene registros de implementación antiguos y activos de SDK propietarios retirados; no debe hacerse público sin cambios. Un árbol recién exportado proporciona al público un punto de partida sin reescribir silenciosamente el historial de entrega original.

## Preparación local

Utilice **Gitleaks 8.30.1**, descargado de su versión oficial de GitHub y verifique su suma de comprobación. La herramienta de auditoría nunca instala paquetes del sistema ni carga datos. La salida privada se ignora `.runtime/open-source-audit/`, no un PR público.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Los resultados deben ser nuevos caminos; las herramientas nunca sobrescriben a los candidatos anteriores. Revise las ubicaciones redactadas, no solo los recuentos. Documente los accesorios sintéticos, las credenciales de arranque públicas, los falsos positivos de identificadores y las credenciales privadas reales/posibles por separado. Los escaneos de patrones no pueden validar credenciales ni capturas de pantalla de OCR. Los artefactos binarios se excluyen y no se declaran limpios y escaneados. El exportador de origen solo admite archivos conocidos de Git y entradas explícitas sin seguimiento en [release-policy.json](release-policy.json). Es necesario revisar las nuevas entradas sin seguimiento. Rechaza enlaces simbólicos y recorridos de rutas y emite SHA-256 plus por archivo. `website/` siempre se excluye, incluso si se realiza un seguimiento o figura como una entrada sin seguimiento. Nunca copie el directorio `.git` del repositorio privado en una caja pública. Antes de publicar, verifique que tanto el árbol como todas las confirmaciones públicas accesibles no contengan archivos de sitio web; eliminar archivos en una confirmación posterior no elimina el historial anterior.

La verificación complementaria incluye mensajes de confirmación/etiqueta accesibles, credenciales de baja entropía y literales de inicio de sesión, identidades de dispositivos y direcciones de desarrollo. Las pruebas no están exentas automáticamente: explique por qué cada elemento retenido es sintético. Los valores privados conocidos se pueden proporcionar con `--denylist` como una matriz JSON externa de registros `{id, value, word?}`. Utilice identificaciones opacas y no confidenciales; mantenga este archivo fuera del proceso de pago de origen. Los informes muestran ubicaciones y hashes, nunca los valores. Una coincidencia de marcador conocido hace que la verificación falle. Utilice `--scope worktree` mientras limpia; inspeccione `--scope all` en el nuevo repositorio de versiones sin padres antes de publicar. No publique el historial antiguo ni los informes de revisión privados.

El único valor predeterminado intencional del administrador de fábrica es `admin / admin`; cámbielo durante el despliegue. Las herramientas de implementación/prueba del navegador deben recibir las credenciales de la cuenta existente a través de una entrada local protegida. Las cuentas de prueba de humo recién creadas utilizan credenciales aleatorias y se desactivan durante la limpieza. Una limpieza fallida es una prueba fallida, no una ejecución exitosa. La terminación abrupta del proceso puede impedir la limpieza; Los operadores deberán conciliar sus cuentas temporales tras dicha interrupción. Ningún documento público afirma que una credencial de prueba sea válida actualmente.

Solo el punto de entrada `install/` mantenido es una ruta de instalación limpia del dispositivo. La evaluación de propiedad del componente se encuentra en [OWNERSHIP.md](OWNERSHIP.es.md).

Ningún comando aquí impulsa a Git, cambia la visibilidad, reescribe el historial, rota las credenciales activas, cambia un dispositivo ni otorga derechos de redistribución a terceros. La publicación pública requiere un destino público elegido explícitamente y una revisión final del artefacto. Conserve `delivery-2026-10-22` en el repositorio privado.
