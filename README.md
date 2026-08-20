# Scraper Challenge

Scraper en TypeScript (sin automatización de navegador) para el portal de jurisprudencia.
Flujo real: `inicio.xhtml` → búsqueda → `resultado.xhtml` (recuadros con los detalles de
cada resolución) → apertura de la ficha de cada caso para descargar la resolución en
**PDF** y en **Word**, navegando por todas las páginas. Usa únicamente `axios` (requests
HTTP) y `cheerio` (parsing).

## Requisitos

- Node.js 18 o superior
- Acceso de red al sitio objetivo (requiere VPN a Perú)

## Instalación

```bash
npm install
```

## Uso

```bash
npm run dev
```

## Variables de entorno

Los nombres de las variables de entorno se mantienen en inglés para no romper los
comandos existentes; en el código, las constantes correspondientes están en español.

- `START_URL`: URL inicial (página de búsqueda). Por defecto
  `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/inicio.xhtml`.
- `OUTPUT_DIR`: carpeta de salida. Por defecto `scraped`.
- `MAX_PAGES`: límite opcional de páginas a recorrer.
- `MAX_DOWNLOAD_ATTEMPTS`: límite total de documentos a intentar descargar. Por defecto
  `0` (sin límite: descarga todo).
- `REQUEST_DELAY_MS`: pausa entre requests en milisegundos. Por defecto `4000`.
- `SESSION_ATTEMPTS`: reintentos al establecer la sesión JSF si el servidor devuelve
  `ViewExpiredException`. Por defecto `5`.
- `RETRY_FAILED=1`: en lugar de hacer un scrape nuevo, reintenta únicamente las descargas
  registradas en `scraped/failed.json`.

Ejemplo:

```powershell
npm run dev
```

Sin variables de entorno el scraper descarga todos los documentos de todas las páginas
(con pausa de 4 segundos entre peticiones). Para limitar, por ejemplo a 5 páginas y
10 descargas:

```powershell
$env:MAX_PAGES="5"
$env:MAX_DOWNLOAD_ATTEMPTS="10"
npm run dev
```

Reintentar descargas fallidas:

```powershell
$env:RETRY_FAILED="1"
npm run dev
```

## Salida

- `scraped/pdfs/`: archivos descargados, organizados en una carpeta numerada por recuadro
  del listado (`1/`, `2/`, `3/`, …). Dentro de cada carpeta quedan la resolución en PDF
  (`Resolucion_*.pdf`) y en Word (`Resolucion_*.doc`) de ese caso.
- `scraped/documents.json`: datos estructurados únicamente de los documentos
  procesados (tipo de recurso, expediente, especialidad, tipo y fecha de resolución,
  órgano jurisdiccional, pretensión, sumilla, palabras clave, datos completos de la
  ficha y los archivos descargados). Si una descarga falla, se registra en `failed.json`.
- `scraped/failed.json`: documentos cuya descarga falló, con el motivo, para poder
  reintentarlos después con `RETRY_FAILED=1`.

## Manejo de 429

El scraper reintenta automáticamente los requests que devuelven `429 Too Many Requests`
o errores transitorios `5xx` con backoff exponencial y respeta `Retry-After` cuando el
servidor lo envía. Si el error persiste tras varios intentos, registra el documento en
`failed.json` y continúa con el siguiente.

## Notas

El scraper está ajustado al flujo real del portal:

- `GET` a `inicio.xhtml` y POST de búsqueda (los parámetros del botón "Buscar" se
  extraen del propio formulario; el POST usa la URL con `jsessionid`)
- `GET` a `resultado.xhtml` siguiendo la redirección (HTTP → HTTPS)
- parseo de los recuadros con `cheerio` (tipo de recurso, expediente, detalles)
- descarga directa de la resolución en PDF (`ServletDescarga?uuid=…`)
- apertura de la ficha (`RichFaces.ajax`) para extraer los detalles completos y
  descargar la resolución en Word
- paginación por `next` con el DataScroller de RichFaces

Los archivos descargados se validan (no se guardan páginas HTML como si fueran
archivos) y las respuestas se decodifican respetando el charset real del portal.
