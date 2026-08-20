# Documentación del Scraper

Scraper en TypeScript para el portal de jurisprudencia del Poder Judicial del Perú
(`jurisprudencia.pj.gob.pe`), desarrollado sin automatización de navegador:
solo requests HTTP con **axios** y parsing con **cheerio**.

---

## 1. Estrategia general

La idea central es **replicar el comportamiento de un navegador con requests HTTP**:

1. Explorar el sitio y capturar los eventos reales con las herramientas de
   desarrollador del navegador (DevTools): POST de búsqueda, apertura de la ficha
   y descargas.
2. Entender el protocolo JSF del portal (Mojarra/RichFaces): `ViewState`, cookies,
   respuestas `partial-response` con bloques `CDATA` y payloads form-urlencoded.
3. Replicar esos eventos con axios, manteniendo la misma sesión (cookies) y los
   mismos parámetros.
4. Hacer el scraper robusto: reintentos con backoff ante `429`/`5xx`, validación de
   los archivos descargados y registro de fallos para reintentarlos después.
5. Respetar al servidor: pausa configurable entre peticiones (4 segundos por defecto).

---

## 2. Pasos cortos de lo que hace el scraper

1. **GET a `inicio.xhtml`** → obtiene la página de búsqueda y la cookie de sesión
   (`JSESSIONID`).
2. **Extrae el formulario de búsqueda** (`formBuscador`): campos, opciones
   seleccionadas, botón "Buscar" y la URL de envío (que incluye `;jsessionid=…`).
3. **POST de búsqueda** a esa URL con todos los campos + los parámetros del botón
   (`forward=buscar`, orden, etc.). El servidor responde una redirección (302) a
   `resultado.xhtml`.
4. **GET a `resultado.xhtml`** (convirtiendo la redirección de `http://` a `https://`),
   guarda el nuevo `ViewState` y los campos del formulario de resultados.
5. **Parsea los recuadros** de resultados: tipo de recurso, expediente, especialidad,
   tipo y fecha de resolución, órgano jurisdiccional, pretensión, sumilla y palabras
   clave. También extrae el enlace **"Ver Resolución"** (descarga directa) y el botón
   **"Ver Ficha"** (RichFaces.ajax con los parámetros del caso).
6. Por cada recuadro:
   - **Descarga directa del PDF** (`ServletDescarga?uuid=…`) y lo guarda en su carpeta.
   - **Abre la ficha** (POST AJAX con `partial.event=click` y los parámetros del caso),
     extrae los datos completos (jueces, ponente, sala, régimen, etc.) y encuentra el
     segundo archivo: la resolución en **Word**.
   - **Descarga el Word** y lo guarda en la misma carpeta.
7. **Paginación**: si existe botón "siguiente" (DataScroller de RichFaces), solicita la
   siguiente página con `formBuscador:data2:page=next` y repite desde el paso 5.
8. **Guarda las salidas**: `documents.json` (datos + archivos de cada caso), `failed.json`
   (descargas fallidas) y las carpetas `pdfs/1/`, `pdfs/2/`, … con los archivos.

---

## 3. Herramientas y librerías

| Herramienta | Para qué se usa |
|---|---|
| **Node.js 18+** | Runtime de ejecución del scraper. |
| **TypeScript** | Lenguaje con tipos; el código fuente vive en `src/` y se compila a `dist/`. |
| **ts-node** | Permite ejecutar TypeScript directamente (`npm run dev`), sin compilar antes. |
| **axios** | Requests HTTP: `GET`/`POST`, cabeceras, cookies, `responseType: arraybuffer` para recibir bytes crudos y `maxRedirects: 0` para controlar redirecciones. |
| **cheerio** | Parsing del HTML/XML con selectores CSS: formularios, recuadros, popup de la ficha y bloques `CDATA`. |
| **node:fs/promises** | Crear carpetas (`mkdir recursive`), escribir PDFs/Word y los JSON de salida. |
| **URLSearchParams** | Construir los payloads `application/x-www-form-urlencoded` que exige el portal. |
| **TextDecoder** | Decodificar las respuestas: primero UTF-8 estricto y, si falla, Windows-1252 (el portal envía títulos en Latin-1 de un byte). |
| **Git / GitHub** | Control de versiones y entrega del repositorio público. |

---

## 4. Estructura del proyecto

```
src/
├── index.ts          Orquestación: sesión, páginas, descargas, salidas.
└── lib/
    ├── http.ts       Solicitudes con reintentos, cookies, decodificación, carpetas.
    └── parser.ts     Extracción: formularios, resultados, ficha, ViewState.
```

- **`src/lib/http.ts`**: `solicitudConReintentos()` (reintenta 429 y 5xx con backoff
  exponencial y respeta `Retry-After`), `decodificarTexto()`, `asegurarDirectorio()`,
  `pausa()` y el contenedor de cookies que se actualiza con cada respuesta.
- **`src/lib/parser.ts`**: funciones que extraen la información del HTML/XML:
  `parsearCamposFormulario()`, `parsearBotonBusqueda()`, `parsearResultados()`,
  `parsearFicha()`, `extraerEstadoVista()` y `extraerSiguientePagina()`.
- **`src/index.ts`**: el flujo completo, con cada función importante comentada y
  numerada (1 a 12).

---

## 5. Detalles técnicos importantes

### Sesión JSF (ViewState y cookies)

El portal es una aplicación JSF (Mojarra/RichFaces). Cada página tiene un campo oculto
`javax.faces.ViewState` que debe enviarse en cada POST. Las respuestas AJAX devuelven el
nuevo ViewState dentro de:

```xml
<update id="javax.faces.ViewState"><![CDATA[123:456]]></update>
```

El scraper lo extrae de la **respuesta cruda** (antes de desempaquetar los CDATA) y lo
reutiliza en las siguientes peticiones, junto con la cookie `JSESSIONID`.

### La búsqueda usa `jsessionid` en la URL

El formulario de `inicio.xhtml` envía el POST a una URL que incluye
`;jsessionid=…`. Si se omite, el servidor responde 500; por eso el scraper usa la
`action` del formulario tal como viene. La redirección resultante apunta a
`http://…/resultado.xhtml`, que se convierte a `https://` antes del GET.

### Payloads exactos

Los campos se replican tal como los envía el navegador:

- Campos de texto, ocultos y selects con su opción seleccionada.
- Checkboxes **marcados** únicamente (los desmarcados no se envían).
- **No** se envían los botones imagen sin hacer clic (provocan 500).
- Para la ficha se incluye `javax.faces.partial.event=click` y los parámetros propios
  del caso (`uuid`, `recurso`, `nroexp`, `palabras`, `pretensiones`, `normaDI`,
  `tipoResolucion`, `fechaResolucion`, `sala`, `sumilla`).

### Codificación de caracteres

El portal declara `ISO-8859-1` pero puede enviar texto Latin-1 de un byte. Las
respuestas se piden como bytes crudos (`arraybuffer`) y se decodifican con UTF-8
estricto; si falla, se usa Windows-1252. Así los títulos como "Análisis" no se
corrompen en "An�lisis".

### Validación de archivos

Antes de guardar, se revisa que la respuesta no sea una página HTML (por ejemplo, una
sesión expirada): si empieza con `<?xml`, `<!DOCTYPE` o `<html`, se descarta y se
registra el fallo.

### Rate limiting (429)

`solicitudConReintentos()` reintenta automáticamente los `429 Too Many Requests` y los
errores transitorios `5xx` con backoff exponencial, respetando `Retry-After` cuando el
servidor lo envía. Si el error persiste, el documento se guarda en `failed.json` y el
scraper continúa con el siguiente. Con `RETRY_FAILED=1` se reintentan después.

---

## 6. Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `START_URL` | `inicio.xhtml` | Página inicial de búsqueda. |
| `OUTPUT_DIR` | `scraped` | Carpeta de salida. |
| `MAX_PAGES` | `0` | Límite de páginas (`0` = todas). |
| `MAX_DOWNLOAD_ATTEMPTS` | `0` | Límite de casos a procesar (`0` = todos). |
| `REQUEST_DELAY_MS` | `4000` | Pausa entre peticiones. |
| `SESSION_ATTEMPTS` | `5` | Reintentos al establecer la sesión. |
| `RETRY_FAILED` | `0` | Con `1`, solo reintenta las descargas de `failed.json`. |

---

## 7. Cómo ejecutar

```bash
npm install        # instala dependencias
npm run build      # compila TypeScript a dist/
npm run dev        # ejecuta desde TypeScript (recomendado)
# o
npm start          # ejecuta el compilado
```

Sin variables, descarga todo de todas las páginas con pausa de 4 segundos:

```powershell
npm run dev
```

Ejemplo con límites:

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

---

## 8. Ejemplos

### Petición de la ficha (resumen del payload)

```text
formBuscador=formBuscador
javax.faces.ViewState=<estado de vista>
formBuscador:buCorte=1
formBuscador:buTipoRecurso=0
formBuscador:buOrden=21
formBuscador:buOrdenForma=DESC
javax.faces.source=formBuscador:repeat:0:j_idt491
javax.faces.partial.event=click
javax.faces.partial.execute=formBuscador:repeat:0:j_idt491 @component
javax.faces.partial.render=@component
uuid=340aa907-8fb9-4f53-9a65-698036bcf92c
recurso=Apelación
nroexp=037233-2025
pretensiones=Acción de Amparo
tipoResolucion=Ejecutoria Suprema
fechaResolucion=14/08/2026
sala=Quinta Sala de Derecho Constitucional y Social Transitoria
org.richfaces.ajax.component=formBuscador:repeat:0:j_idt491
AJAX:EVENTS_COUNT=1
javax.faces.partial.ajax=true
```

### Extracción de un recuadro con cheerio

```ts
const $ = cheerio.load(html);
$('div.rf-p[id^="formBuscador:repeat:"]').each((_, panelEl) => {
  const panel = $(panelEl);
  const tipo = panel.find('.rf-p-hdr span[style*="font-weight:bold"]').eq(0).text().trim();
  const expediente = panel.find('.rf-p-hdr span[style*="font-weight:bold"]').eq(1).text().trim();
  const enlacePdf = panel.find('a[href*="ServletDescarga"]').first().attr('href');
});
```

### Descarga directa de un archivo

```ts
const respuesta = await axios.get(
  'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=<uuid>',
  { responseType: 'arraybuffer', headers: { cookie: sesion } }
);
await writeFile('scraped/pdfs/1/resolucion.pdf', Buffer.from(respuesta.data));
```

---

## 9. Entregable

Repositorio público:

https://github.com/gogonta83/scraper-challenge
