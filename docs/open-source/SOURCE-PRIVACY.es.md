<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.es.md)
<!-- doc-navigation:end -->

# Límite de privacidad de fuente pública

El repositorio público de productos es una instantánea de la nueva fuente, no un espejo del historial de desarrollo privado. El sitio web de marketing tiene su propio repositorio privado y no está incluido aquí.

## Material eliminado

- Se corrigieron nombres y contraseñas de cuentas de prueba de implementación y listas de cuentas personales.
- Envoltorios y scripts de implementación/recuperación de un solo dispositivo que registraron identidades históricas de dispositivos o afirmaron resultados a partir de evidencia privada.
- Direcciones de host reales, directorios de inicio, identidades de contenedores/dispositivos e instantáneas de mantenimiento histórico. Las pruebas retenidas utilizan accesorios explícitamente sintéticos; Las herramientas operativas mantenidas requieren insumos específicos explícitos.
- Los discos invitados, el estado de inicio de sesión de Android, las sesiones del navegador, los paquetes de instalación, los pesos de los modelos y la evidencia privada están fuera de la distribución de fuentes públicas.

El archivo privado y las etiquetas de entrega originales permanecen intactos. Nada en esta limpieza de origen cambia las cuentas de dispositivos, los datos de los huéspedes, los servicios en ejecución o la implementación del sitio web. El valor predeterminado de fábrica `admin / admin` se conserva deliberadamente; no es una credencial privada. Los administradores deben cambiarlo antes de la exposición.

## Revisión y verificación

Revise tanto el árbol de trabajo como cada confirmación/etiqueta accesible en el repositorio que se está publicando. Utilice Gitleaks más `tools/open_source_sensitive.py`; ninguno de los dos es prueba por sí sola de que falten contraseñas de baja entropía o metadatos personales. Compare valores privados antiguos confirmados utilizando una lista de denegación externa privada, nunca un dispositivo de prueba comprometido. Revise los hallazgos restantes individualmente, incluidos los archivos de prueba.

Las comprobaciones de limpieza son comprobaciones de política de origen, regresión sintética, configuración y sintaxis. No inician sesión con las credenciales descubiertas, no reinstalan una caja ni repiten la aceptación del producto. La corrección anterior del paquete de API (incluida la fuente de interfaz de usuario compartida y la verificación del punto de entrada de solo importación) permanece en la fuente.

Los nuevos clones no deben importar confirmaciones, referencias o etiquetas retiradas. Al eliminar un repositorio no se recuperan las copias ya descargadas por otros. Ningún análisis puede establecer que nunca se copió una credencial desconocida; una credencial que realmente se utilizó debe ser rotada por su operador. Esta limpieza no pretende haberlo rotado.

Consulte [RELEASING.md](RELEASING.es.md) para obtener instrucciones de revisión y exportación de código fuente y [BUILDING.md](BUILDING.es.md) para conocer los requisitos previos de compilación y los activos obtenidos por separado.
