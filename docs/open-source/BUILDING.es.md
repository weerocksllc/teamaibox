<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.es.md)
<!-- doc-navigation:end -->

# Construye la fuente

El artefacto público es una fuente, no una imagen de dispositivo fuera de línea prediseñada. Una compilación fuente puede descargar dependencias; la instalación utilizando un paquete completo preparado permanece fuera de línea. Ninguno de los procesos necesita un ViKey SDK o una llave USB.

Para una instalación completa del dispositivo, comience con la raíz [inicio rápido](../../README.es.md#install) y [instalador de origen](../../install/SOURCE-INSTALL.es.md): `sudo bash install/from-source.sh` descargas, compilaciones, paquetes e instalaciones en un Spark nuevo compatible. La compilación web de desarrollo a continuación no es ese instalador y no inicia el producto completo.

## Desarrollo

Utilice Node.js 24, pnpm 11.1.3 (ver raíz `package.json`), Python 3.10+ y la versión Go declarada en cada `go.mod` (node-agent actualmente 1.26). En una máquina de construcción:

Una exportación de origen deliberadamente no tiene un historial privado de Git. Antes de ejecutar herramientas fuente en ese árbol exportado, inicialice su propio repositorio y confirme su árbol revisado (`git init`, `git add .`, `git commit`). Un clon público normal de Git no necesita este paso. Utilice esa nueva confirmación como identidad de compilación; No reclame un árbol modificado y exportado es el compromiso de entrega anterior.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

La construcción web es una verificación de compilación, no una aceptación del producto. Los servicios de tiempo de ejecución utilizan los Dockerfiles en `deploy/`. La ejecución de DGX Spark requiere Linux ARM64 y el entorno NVIDIA/Docker existente. Una compra de fuente de escritorio no reemplaza ese hardware. No utilice scripts de laboratorio históricos como instaladores.

Los ayudantes de compilación de la fábrica de Python también requieren PyYAML; consulte la verificación previa de dependencia del instalador. No se requiere ningún disco de sistema operativo instalado ni cuenta de desarrollador.

## Entradas compiladas excluidas

El exportador omite los archivos binarios, incluso cuando su extensión parece inofensiva:

- Compile `services/node-agent` y su ayudante `cmd/factory-worker-spec` desde la fuente Go; el ejecutable raíz del repositorio `node-agent` no es una entrada de origen.
- Los APK de dispositivos Android y los archivos de firma no se envían. Su fuente y manifiestos en `tools/fixtures/` permanecen disponibles para compilaciones de prueba locales.
- La compilación de conversión del dispositivo actual utiliza `deploy/appliance/wireless-casting-plugin.Dockerfile`. No necesita los archivos del antiguo paquete Alpine. Si utiliza el complemento independiente Dockerfile, obtenga los paquetes exactos identificados en [su manifiesto de suma de comprobación ascendente](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) y verifique sus valores SHA-256 antes de compilarlos. Nunca sustituya un paquete arbitrario cuando el artefacto ascendente anclado no esté disponible.
- El módulo del navegador LiveKit y su licencia permanecen en el directorio de fuentes públicas del complemento; el archivo redundante npm `.tgz` no se envía.

Estas son exclusiones de distribución de origen, no cambios en el dispositivo en ejecución.

## Paquete completo sin conexión

Comience con [la canalización de fuente pública](../../install/PUBLIC-BUILD.es.md). Proporciona imágenes principales públicas y dependencias de tiempo de ejecución creadas en el código fuente; No se requiere una instalación previa del desarrollador. Las recetas históricas de imágenes en capas no son el punto de entrada para una nueva instalación.

Siga [install/README.md](../../install/README.es.md) para compilaciones de imágenes de aplicaciones, herramientas de host invitado, paquetes de host fuera de línea, recopilación de activos y embalaje final. El dispositivo de destino no recupera dependencias ni reemplaza Docker/NVIDIA. Establezca entradas de compilación para su confirmación de fuente real, ID de contenido ARM64 OCI y rutas de activos limpias. No se requiere IP, cuenta, certificado o volumen del host de desarrollo. Los pesos del modelo y los activos de invitado/tiempo de ejecución se obtienen por separado de las fuentes ascendentes exactas identificadas en [components.json](components.json) y los bloqueos del repositorio. Preservar sus licencias y avisos de fuentes requeridos.

**La disponibilidad de la fuente no es una autorización de redistribución binaria.** El contrato actual completo del paquete fuera de línea incluye un tiempo de ejecución de Google Android; su evidencia de instalación privada no es permiso para distribuir GMS. El empaquetador existente se conserva sin cambios, pero dicho paquete no es una descarga pública aprobada a menos que se obtengan esos derechos. Una edición binaria pública exclusiva de AOSP sería un cambio de paquete con alcance separado, que no se sustituiría silenciosamente aquí. Los archivos ISO de Windows/Linux los proporciona cada usuario; Ningún invitado de prueba instalado ni estados de cuenta son entradas de compilación públicas.
