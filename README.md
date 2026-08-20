# Scraper Challenge

Scraper en TypeScript para extraer documentos y descargar PDFs del portal de jurisprudencia.

## Requisitos

- Node.js 18 o superior
- Acceso de red al sitio objetivo

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
- `MAX_DOWNLOAD_ATTEMPTS`: límite total de documentos a intentar descargar. Por defecto `1`.
- `REQUEST_DELAY_MS`: pausa entre requests en milisegundos. Por defecto `4000`.

Ejemplo:

```powershell
$env:MAX_DOWNLOAD_ATTEMPTS="2"
npm run dev
```

## Salida

- `scraped/pdfs/`: PDFs descargados.

## Manejo de 429

El scraper reintenta automáticamente los requests que devuelven `429 Too Many Requests` con backoff exponencial y respeta `Retry-After` cuando el servidor lo envía.

## Notas

El scraper está ajustado al flujo real del portal:

- `GET` inicial
- `POST` inicial para cargar resultados
- parseo del listado
- descarga por `POST` del PDF
- paginación por `next`
