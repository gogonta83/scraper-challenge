import { readFile, writeFile } from 'node:fs/promises';
import {
  asegurarDirectorio,
  decodificarTexto,
  pausa,
  sanitizarNombreArchivo,
  solicitudConReintentos,
  type Cabeceras,
} from './lib/http.js';
import {
  extraerEstadoVista,
  extraerSiguientePagina,
  parsearDocumentos,
  type RegistroDocumento,
} from './lib/parser.js';

// Constantes en español; los nombres de las variables de entorno se mantienen
// en inglés para no romper los comandos ya existentes.
const URL_INICIO =
  process.env.START_URL ?? 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/analisis-jurisprudencial.xhtml';
const DIRECTORIO_SALIDA = process.env.OUTPUT_DIR ?? 'scraped';
const MAX_PAGINAS = Number(process.env.MAX_PAGES ?? '0');
const RETARDO_PETICION_MS = Number(process.env.REQUEST_DELAY_MS ?? '4000');
const MAX_INTENTOS_DESCARGA = Number(process.env.MAX_DOWNLOAD_ATTEMPTS ?? '0');
const INTENTOS_SESION = Number(process.env.SESSION_ATTEMPTS ?? '5');
const REINTENTAR_FALLIDOS = process.env.RETRY_FAILED === '1';

type ContenedorCookies = { valor: string };

type Sesion = {
  html: string;
  estadoVista: string;
  cookies: ContenedorCookies;
};

type RegistroExtraido = RegistroDocumento & {
  pdfFile?: string;
};

type RegistroFallido = {
  title: string;
  grupo?: number;
  number?: string;
  uuid?: string;
  rutaDoc?: string;
  downloadButtonName?: string;
  error: string;
  attemptedAt: string;
};

// 1. Punto de entrada: recorre las páginas, descarga los PDFs y guarda las salidas.
async function main(): Promise<void> {
  await asegurarDirectorio(DIRECTORIO_SALIDA);
  await asegurarDirectorio(`${DIRECTORIO_SALIDA}/pdfs`);

  if (REINTENTAR_FALLIDOS) {
    await reintentarDescargasFallidas();
    return;
  }

  let intentosDescarga = 0;
  let descargasExitosas = 0;
  let totalEncontrados = 0;
  let totalGrupos = 0;
  const documentos: RegistroExtraido[] = [];
  const descargasFallidas: RegistroFallido[] = [];
  let sesion = await establecerSesion();
  let numeroPagina = 1;

  while (true) {
    const documentosPagina = parsearDocumentos(sesion.html, totalGrupos);
    console.log(`Página ${numeroPagina}: ${documentosPagina.length} documentos`);
    totalEncontrados += documentosPagina.length;

    for (let i = 0; i < documentosPagina.length; i += 1) {
      const documento = documentosPagina[i];
      if (MAX_INTENTOS_DESCARGA > 0 && intentosDescarga >= MAX_INTENTOS_DESCARGA) {
        console.log(`Se alcanzó MAX_DOWNLOAD_ATTEMPTS=${MAX_INTENTOS_DESCARGA}`);
        await guardarSalidas(documentos, descargasFallidas);
        return;
      }

      intentosDescarga += 1;
      try {
        const archivoGuardado = await descargarDocumento(documento, sesion.estadoVista, sesion.cookies);
        documentos.push({ ...documento, pdfFile: archivoGuardado });
        descargasExitosas += 1;
        console.log(`Descargado: ${documento.title} -> ${archivoGuardado}`);
      } catch (error) {
        const motivo = error instanceof Error ? error.message : String(error);
        console.error(`Fallo "${documento.title}": ${motivo}`);
        let recuperado = false;
        if (esErrorDeSesion(motivo)) {
          try {
            console.log('Reintentando con una sesión nueva...');
            sesion = await establecerSesion();
            const archivoGuardado = await descargarDocumento(documento, sesion.estadoVista, sesion.cookies);
            documentos.push({ ...documento, pdfFile: archivoGuardado });
            descargasExitosas += 1;
            recuperado = true;
            console.log(`Descargado (reintento): ${documento.title} -> ${archivoGuardado}`);
          } catch (errorReintento) {
            const motivoReintento = errorReintento instanceof Error ? errorReintento.message : String(errorReintento);
            console.error(`Fallo en el reintento "${documento.title}": ${motivoReintento}`);
          }
        }
        if (!recuperado) {
          descargasFallidas.push(crearRegistroFallido(documento, motivo));
        }
      }

      await pausa(RETARDO_PETICION_MS);
    }

    await guardarSalidas(documentos, descargasFallidas);
    totalGrupos = documentosPagina.reduce((maximo, documento) => Math.max(maximo, documento.grupo ?? 0), totalGrupos);

    if (MAX_PAGINAS > 0 && numeroPagina >= MAX_PAGINAS) break;

    const siguiente = extraerSiguientePagina(sesion.html);
    if (!siguiente.siguientePagina) break;

    try {
      sesion.html = await obtenerSiguientePagina(sesion.estadoVista, sesion.cookies);
      sesion.estadoVista = extraerEstadoVista(sesion.html) || sesion.estadoVista;
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.error(`No se pudo avanzar a la página ${numeroPagina + 1}: ${motivo}`);
      break;
    }
    numeroPagina += 1;
    await pausa(RETARDO_PETICION_MS);
  }

  console.log(
    `\nResumen: ${totalEncontrados} documentos encontrados, ${descargasExitosas} PDFs descargados, ${descargasFallidas.length} fallidos.`
  );
  console.log(`Datos extraídos: ${DIRECTORIO_SALIDA}/documents.json`);
  console.log(`Descargas fallidas: ${DIRECTORIO_SALIDA}/failed.json`);
}

// 2. Reintenta las descargas fallidas registradas en failed.json.
async function reintentarDescargasFallidas(): Promise<void> {
  const rutaFallidos = `${DIRECTORIO_SALIDA}/failed.json`;
  let fallidas: RegistroFallido[] = [];
  try {
    fallidas = JSON.parse(await readFile(rutaFallidos, 'utf8')) as RegistroFallido[];
  } catch {
    console.log(`No existe ${rutaFallidos}; no hay descargas fallidas que reintentar.`);
    return;
  }

  const pendientes = fallidas.filter(
    (registro) => registro.downloadButtonName && (registro.uuid || registro.rutaDoc)
  );
  if (pendientes.length === 0) {
    console.log('No hay descargas fallidas pendientes.');
    return;
  }

  console.log(`Reintentando ${pendientes.length} descargas fallidas...`);
  const sesion = await establecerSesion();
  const restantes: RegistroFallido[] = [];
  let exitosos = 0;

  for (const registro of pendientes) {
    const documento: RegistroDocumento = {
      index: -1,
      grupo: registro.grupo,
      kind: registro.uuid ? 'resolucion' : 'analisis',
      title: registro.title,
      number: registro.number,
      uuid: registro.uuid,
      rutaDoc: registro.rutaDoc,
      downloadButtonName: registro.downloadButtonName,
      detailParams: {},
    };
    try {
      const archivoGuardado = await descargarDocumento(documento, sesion.estadoVista, sesion.cookies);
      exitosos += 1;
      console.log(`Reintento OK: ${registro.title} -> ${archivoGuardado}`);
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.error(`Reintento fallido "${registro.title}": ${motivo}`);
      restantes.push({ ...registro, error: motivo, attemptedAt: new Date().toISOString() });
    }
    await pausa(RETARDO_PETICION_MS);
  }

  await escribirJson(rutaFallidos, restantes);
  console.log(`Reintentos: ${exitosos} OK, ${restantes.length} siguen fallando.`);
}

// 3. Guarda los datos extraídos (documents.json) y las descargas fallidas (failed.json).
async function guardarSalidas(
  documentos: RegistroExtraido[],
  descargasFallidas: RegistroFallido[]
): Promise<void> {
  await escribirJson(`${DIRECTORIO_SALIDA}/documents.json`, documentos);
  await escribirJson(`${DIRECTORIO_SALIDA}/failed.json`, descargasFallidas);
}

// 4. Escribe un archivo JSON con formato legible.
async function escribirJson(ruta: string, datos: unknown): Promise<void> {
  await writeFile(ruta, JSON.stringify(datos, null, 2));
}

// 5. Establece una sesión JSF válida (GET inicial + búsqueda AJAX) con reintentos.
async function establecerSesion(): Promise<Sesion> {
  for (let intento = 1; intento <= INTENTOS_SESION; intento += 1) {
    const cookies: ContenedorCookies = { valor: '' };
    try {
      const paginaInicial = await obtenerPagina(URL_INICIO, cookies);
      let estadoVista = extraerEstadoVista(paginaInicial.html);
      const html = await obtenerResultadosIniciales(estadoVista, cookies);
      estadoVista = extraerEstadoVista(html) || estadoVista;
      if (!estadoVista) {
        throw new Error('No se pudo extraer el ViewState de la sesión');
      }
      console.log(`Listo. ViewState: ${estadoVista ? 'sí' : 'no'}`);
      return { html, estadoVista, cookies };
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.warn(`No se pudo establecer la sesión (intento ${intento}/${INTENTOS_SESION}): ${motivo}`);
      if (intento === INTENTOS_SESION) throw error;
      await pausa(2000);
    }
  }
  throw new Error('No se pudo establecer la sesión');
}

// 6. Obtiene la página inicial del portal.
async function obtenerPagina(url: string, cookies: ContenedorCookies): Promise<{ html: string }> {
  console.log(`GET ${url}`);
  const respuesta = await solicitudConReintentos(url, {
    metodo: 'GET',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    cookies,
    reintento: { reintentos: 5, esperaBaseMs: 1500, esperaMaximaMs: 30000 },
  });

  return {
    html: decodificarTexto(respuesta.datos),
  };
}

// 7. Ejecuta la búsqueda inicial (POST AJAX) que carga el listado de resultados.
async function obtenerResultadosIniciales(estadoVista: string, cookies: ContenedorCookies): Promise<string> {
  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('javax.faces.ViewState', estadoVista ?? '');
  payload.set('formBoletin:txtTitulo', '');
  payload.set('formBoletin:buTipPublicacion', '7');
  payload.set('formBoletin:buEspecialidad', '0');
  payload.set('javax.faces.source', 'j_idt203');
  payload.set('javax.faces.partial.execute', 'j_idt203 @component');
  payload.set('javax.faces.partial.render', '@component');
  payload.set('org.richfaces.ajax.component', 'j_idt203');
  payload.set('j_idt203', 'j_idt203');
  payload.set('AJAX:EVENTS_COUNT', '1');
  payload.set('javax.faces.partial.ajax', 'true');

  const respuesta = await solicitudConReintentos(URL_INICIO, {
    metodo: 'POST',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/xml, text/xml, */*; q=0.01',
      'faces-request': 'partial/ajax',
      origin: 'https://jurisprudencia.pj.gob.pe',
      referer: URL_INICIO,
    },
    datos: payload.toString(),
    cookies,
    reintento: { reintentos: 5, esperaBaseMs: 1500, esperaMaximaMs: 30000 },
  });

  const html = decodificarTexto(respuesta.datos);
  verificarRespuestaSinError(html);
  return html;
}

// 8. Solicita la siguiente página del listado usando el DataScroller de RichFaces.
async function obtenerSiguientePagina(estadoVista: string, cookies: ContenedorCookies): Promise<string> {
  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('formBoletin:txtTitulo', '');
  payload.set('formBoletin:buTipPublicacion', '7');
  payload.set('formBoletin:buEspecialidad', '0');
  payload.set('javax.faces.ViewState', estadoVista ?? '');
  payload.set('javax.faces.source', 'formBoletin:data2');
  payload.set('javax.faces.partial.event', 'rich:datascroller:onscroll');
  payload.set('javax.faces.partial.execute', 'formBoletin:data2 @component');
  payload.set('javax.faces.partial.render', '@component');
  payload.set('formBoletin:data2:page', 'next');
  payload.set('org.richfaces.ajax.component', 'formBoletin:data2');
  payload.set('formBoletin:data2', 'formBoletin:data2');
  payload.set('AJAX:EVENTS_COUNT', '1');
  payload.set('javax.faces.partial.ajax', 'true');

  const respuesta = await solicitudConReintentos(URL_INICIO, {
    metodo: 'POST',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/xml, text/xml, */*; q=0.01',
      'faces-request': 'partial/ajax',
    },
    datos: payload.toString(),
    cookies,
    reintento: { reintentos: 5, esperaBaseMs: 1500, esperaMaximaMs: 30000 },
  });

  const html = decodificarTexto(respuesta.datos);
  verificarRespuestaSinError(html);
  return html;
}

// 9. Descarga el PDF de un documento (análisis completo o resolución) y valida el resultado.
async function descargarDocumento(
  documento: RegistroDocumento,
  estadoVista: string,
  cookies: ContenedorCookies
): Promise<string> {
  if (!estadoVista) {
    throw new Error('No hay ViewState para descargar (sesión inválida)');
  }

  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('formBoletin:txtTitulo', '');
  payload.set('formBoletin:buTipPublicacion', '7');
  payload.set('formBoletin:buEspecialidad', '0');
  payload.set('javax.faces.ViewState', estadoVista);
  if (documento.downloadButtonName) {
    payload.set(documento.downloadButtonName, documento.downloadButtonName);
  }
  if (documento.uuid) {
    payload.set('uuid', documento.uuid);
  }
  if (documento.rutaDoc) {
    payload.set('ruta_doc', documento.rutaDoc);
  }

  const respuesta = await solicitudConReintentos(URL_INICIO, {
    metodo: 'POST',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      origin: 'https://jurisprudencia.pj.gob.pe',
      referer: URL_INICIO,
    },
    datos: payload.toString(),
    cookies,
    reintento: { reintentos: 5, esperaBaseMs: 2000, esperaMaximaMs: 60000 },
  });

  if (respuesta.codigo >= 400) {
    const cuerpoError = Buffer.from(respuesta.datos).subarray(0, 300).toString('latin1');
    throw new Error(`HTTP ${respuesta.codigo} ${cuerpoError}`);
  }

  const carpeta = String(documento.grupo ?? 'sin-grupo');
  await asegurarDirectorio(`${DIRECTORIO_SALIDA}/pdfs/${carpeta}`);

  const nombreArchivo =
    documento.kind === 'analisis'
      ? `${sanitizarNombreArchivo(documento.title)}_documento-completo.pdf`
      : obtenerNombreArchivoDeCabeceras(respuesta.cabeceras) ?? `${sanitizarNombreArchivo(documento.title)}.pdf`;
  const cuerpo = Buffer.from(respuesta.datos);
  if (cuerpo.length < 5 || cuerpo.toString('latin1', 0, 5) !== '%PDF-') {
    throw new Error('La respuesta no es un PDF (sesión/ViewState expirado o error del servidor)');
  }
  const rutaArchivo = `${carpeta}/${nombreArchivo}`;
  await writeFile(`${DIRECTORIO_SALIDA}/pdfs/${rutaArchivo}`, cuerpo);
  return rutaArchivo;
}

// 10. Convierte un documento fallido en su registro para failed.json.
function crearRegistroFallido(documento: RegistroDocumento, error: string): RegistroFallido {
  return {
    title: documento.title,
    grupo: documento.grupo,
    number: documento.number,
    uuid: documento.uuid,
    rutaDoc: documento.rutaDoc,
    downloadButtonName: documento.downloadButtonName,
    error,
    attemptedAt: new Date().toISOString(),
  };
}

// 11. Obtiene el nombre del archivo desde la cabecera content-disposition.
function obtenerNombreArchivoDeCabeceras(cabeceras: Cabeceras): string | undefined {
  const cruda = cabeceras['content-disposition'];
  const valor = Array.isArray(cruda) ? cruda[0] : cruda;
  const coincidencia = valor?.match(/filename="?([^"]+)"?/i);
  return coincidencia?.[1];
}

// 12. Lanza un error si la respuesta AJAX contiene un error del servidor (ViewExpired, etc.).
function verificarRespuestaSinError(html: string): void {
  const nombreError = html.match(/<partial-response>\s*<error>[\s\S]*?<error-name>([^<]*)</i)?.[1];
  if (nombreError) {
    throw new Error(`Respuesta parcial con error del servidor: ${nombreError.trim()}`);
  }
}

// 13. Indica si un error requiere reestablecer la sesión antes de reintentar.
function esErrorDeSesion(motivo: string): boolean {
  return (
    motivo.includes('ViewState') ||
    motivo.includes('ViewExpired') ||
    motivo.includes('no es un PDF') ||
    motivo.includes('Respuesta parcial')
  );
}

void main().catch((error) => {
  const mensaje = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(mensaje);
  process.exitCode = 1;
});
