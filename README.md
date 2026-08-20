# Scraper Challenge

Scraper en TypeScript (sin automatización de navegador) para extraer los datos de los
documentos del portal de jurisprudencia, navegar por todas las páginas y descargar los
PDFs asociados: el documento completo de cada análisis y las resoluciones individuales.
Usa únicamente `axios` (requests HTTP) y `cheerio` (parsing).

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

- `START_URL`: URL inicial del listado. Por defecto usa el portal del desafío.
- `OUTPUT_DIR`: carpeta de salida. Por defecto `scraped`.
- `MAX_PAGES`: límite opcional de páginas a recorrer.
- `MAX_DOWNLOAD_ATTEMPTS`: límite total de documentos a intentar descargar. Por defecto `1`;
  usa `0` para descargar todos.
- `REQUEST_DELAY_MS`: pausa entre requests en milisegundos. Por defecto `4000`.
- `SESSION_ATTEMPTS`: reintentos al establecer la sesión JSF si el servidor devuelve
  `ViewExpiredException`. Por defecto `5`.
- `RETRY_FAILED=1`: en lugar de hacer un scrape nuevo, reintenta únicamente las descargas
  registradas en `scraped/failed.json`.

Ejemplo:

```powershell
$env:MAX_DOWNLOAD_ATTEMPTS="0"
$env:MAX_PAGES="5"
npm run dev
```

Reintentar descargas fallidas:

```powershell
$env:RETRY_FAILED="1"
npm run dev
```

## Salida

- `scraped/pdfs/`: PDFs descargados — `*_documento-completo.pdf` para el análisis
  completo de cada tarjeta y `Resolucion_*.pdf` para cada resolución individual.
- `scraped/documents.json`: datos estructurados de todos los documentos encontrados
  (título, número de recurso, sala, fecha, resumen, especialidad, uuid, parámetros de
  detalle y nombre del PDF descargado).
- `scraped/failed.json`: documentos cuya descarga falló, con el motivo, para poder
  reintentarlos después con `RETRY_FAILED=1`.

## Manejo de 429

El scraper reintenta automáticamente los requests que devuelven `429 Too Many Requests`
o errores transitorios `5xx` con backoff exponencial y respeta `Retry-After` cuando el
servidor lo envía. Si el error persiste tras varios intentos, registra el documento en
`failed.json` y continúa con el siguiente.

## Notas

El scraper está ajustado al flujo real del portal:

- `GET` inicial
- `POST` AJAX inicial para cargar resultados (Mojarra/RichFaces)
- parseo del listado con `cheerio`
- descarga por `POST` del PDF (con `javax.faces.ViewState` obligatorio)
- paginación por `next` con el DataScroller de RichFaces

El ViewState se extrae de la respuesta AJAX (`<update id="javax.faces.ViewState">`)
para que el POST de descarga no devuelva la página HTML en lugar del PDF. Las respuestas
de descarga se validan contra la cabecera mágica `%PDF-` antes de guardarse.
