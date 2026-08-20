import { readFile, writeFile } from 'node:fs/promises';
import {
  asegurarDirectorio,
  decodificarTexto,
  pausa,
  solicitudConReintentos,
  type Cabeceras,
} from './lib/http.js';
import {
  extraerEstadoVista,
  extraerSiguientePagina,
  parsearAccionFormulario,
  parsearBotonBusqueda,
  parsearCamposFormulario,
  parsearFicha,
  parsearResultados,
  type CamposFormulario,
  type DatosFicha,
  type RegistroResultado,
} from './lib/parser.js';

// Constantes en español; los nombres de las variables de entorno se mantienen
// en inglés para no romper los comandos ya existentes.
const URL_INICIO =
  process.env.START_URL ??
  'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/inicio.xhtml';
const URL_BASE = 'https://jurisprudencia.pj.gob.pe';
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
  urlResultado: string;
  camposResultado: CamposFormulario;
};

type RegistroExtraido = RegistroResultado & {
  ficha?: DatosFicha;
  archivos?: string[];
};

type RegistroFallido = {
  titulo: string;
  grupo?: number;
  uuid: string;
  tipo: 'pdf' | 'doc';
  error: string;
  attemptedAt: string;
};

// 1. Punto de entrada: recorre las páginas, descarga los PDFs/Word y guarda salidas.
async function main(): Promise<void> {
  await asegurarDirectorio(DIRECTORIO_SALIDA);
  await asegurarDirectorio(`${DIRECTORIO_SALIDA}/pdfs`);

  if (REINTENTAR_FALLIDOS) {
    await reintentarDescargasFallidas();
    return;
  }

  let intentosDescarga = 0;
  let procesados = 0;
  let totalEncontrados = 0;
  let totalGrupos = 0;
  const documentos: RegistroExtraido[] = [];
  const descargasFallidas: RegistroFallido[] = [];
  let sesion = await establecerSesion();
  let numeroPagina = 1;

  while (true) {
    const resultadosPagina = parsearResultados(sesion.html, totalGrupos);
    console.log(`Página ${numeroPagina}: ${resultadosPagina.length} resultados`);
    totalEncontrados += resultadosPagina.length;

    for (const resultado of resultadosPagina) {
      if (MAX_INTENTOS_DESCARGA > 0 && intentosDescarga >= MAX_INTENTOS_DESCARGA) {
        console.log(`Se alcanzó MAX_DOWNLOAD_ATTEMPTS=${MAX_INTENTOS_DESCARGA}`);
        await guardarSalidas(documentos, descargasFallidas);
        return;
      }

      intentosDescarga += 1;
      try {
        const registro = await procesarResultado(resultado, sesion, descargasFallidas);
        documentos.push(registro);
        procesados += 1;
        const titulo = `${resultado.tipoRecurso ?? ''} ${resultado.nroexp ?? ''}`.trim();
        console.log(`Procesado [${resultado.grupo}] ${titulo} -> ${registro.archivos?.join(', ') ?? 'sin archivos'}`);
      } catch (error) {
        const motivo = error instanceof Error ? error.message : String(error);
        console.error(`Fallo [${resultado.grupo}] "${resultado.nroexp ?? resultado.index}": ${motivo}`);
        if (resultado.uuid) {
          descargasFallidas.push({
            titulo: `${resultado.tipoRecurso ?? ''} ${resultado.nroexp ?? ''}`.trim() || `resultado-${resultado.grupo}`,
            grupo: resultado.grupo,
            uuid: resultado.uuid,
            tipo: 'pdf',
            error: motivo,
            attemptedAt: new Date().toISOString(),
          });
        }
      }

      await pausa(RETARDO_PETICION_MS);
    }

    await guardarSalidas(documentos, descargasFallidas);
    totalGrupos = resultadosPagina.reduce((maximo, resultado) => Math.max(maximo, resultado.grupo), totalGrupos);

    if (MAX_PAGINAS > 0 && numeroPagina >= MAX_PAGINAS) break;

    const siguiente = extraerSiguientePagina(sesion.html);
    if (!siguiente.siguientePagina) break;

    try {
      sesion.html = await obtenerSiguientePagina(sesion);
      sesion.estadoVista = extraerEstadoVista(sesion.html) || sesion.estadoVista;
      sesion.camposResultado = parsearCamposFormulario(sesion.html, 'formBuscador');
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.error(`No se pudo avanzar a la página ${numeroPagina + 1}: ${motivo}`);
      break;
    }
    numeroPagina += 1;
    await pausa(RETARDO_PETICION_MS);
  }

  console.log(
    `\nResumen: ${totalEncontrados} resultados encontrados, ${procesados} procesados, ${descargasFallidas.length} descargas fallidas.`
  );
  console.log(`Datos extraídos: ${DIRECTORIO_SALIDA}/documents.json`);
  console.log(`Descargas fallidas: ${DIRECTORIO_SALIDA}/failed.json`);
}

// 2. Procesa un recuadro: descarga directa de la resolución y, si es posible,
//    abre la ficha para extraer detalles y descargar el archivo Word.
async function procesarResultado(
  resultado: RegistroResultado,
  sesion: Sesion,
  descargasFallidas: RegistroFallido[]
): Promise<RegistroExtraido> {
  const carpeta = String(resultado.grupo);
  await asegurarDirectorio(`${DIRECTORIO_SALIDA}/pdfs/${carpeta}`);
  const archivos: string[] = [];
  let ficha: DatosFicha | undefined;

  // Descarga directa de la resolución (PDF)
  if (resultado.rutaDescarga) {
    const rutaArchivo = await descargarArchivo(resultado.rutaDescarga, carpeta, sesion.cookies);
    archivos.push(rutaArchivo);
  }

  // Ficha: abre los detalles y busca el archivo Word
  if (resultado.fichaSourceId) {
    try {
      const respuestaFicha = await solicitarFicha(resultado, sesion);
      ficha = respuestaFicha.datos;
      for (const descarga of respuestaFicha.descargas) {
        if (descarga.formato !== 'doc') continue;
        try {
          const rutaArchivo = await descargarArchivo(
            `/jurisprudenciaweb/ServletDescarga?uuid=${descarga.uuid}`,
            carpeta,
            sesion.cookies
          );
          archivos.push(rutaArchivo);
        } catch (error) {
          const motivo = error instanceof Error ? error.message : String(error);
          console.error(`Fallo Word [${resultado.grupo}]: ${motivo}`);
          descargasFallidas.push({
            titulo: `${resultado.tipoRecurso ?? ''} ${resultado.nroexp ?? ''}`.trim() || `resultado-${resultado.grupo}`,
            grupo: resultado.grupo,
            uuid: descarga.uuid,
            tipo: 'doc',
            error: motivo,
            attemptedAt: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.warn(`Ficha no disponible [${resultado.grupo}]: ${motivo}`);
    }
  }

  return { ...resultado, ficha, archivos };
}

// 3. Establece la sesión: GET a inicio.xhtml, POST de búsqueda (con jsessionid
//    en la URL) y GET a resultado.xhtml siguiendo la redirección.
async function establecerSesion(): Promise<Sesion> {
  for (let intento = 1; intento <= INTENTOS_SESION; intento += 1) {
    const cookies: ContenedorCookies = { valor: '' };
    try {
      const paginaInicio = await obtenerPagina(URL_INICIO, cookies);
      const accion = parsearAccionFormulario(paginaInicio.html, 'formBuscador');
      const campos = parsearCamposFormulario(paginaInicio.html, 'formBuscador');
      const boton = parsearBotonBusqueda(paginaInicio.html, 'formBuscador');
      if (!boton.nombre || !accion) {
        throw new Error('No se encontró el formulario de búsqueda en inicio.xhtml');
      }

      const payload = new URLSearchParams();
      for (const [clave, valor] of Object.entries(campos)) payload.set(clave, valor);
      for (const [clave, valor] of Object.entries(boton.params)) payload.set(clave, valor);

      const urlAccion = accion.startsWith('http') ? accion : `${URL_BASE}${accion}`;
      const respuesta = await solicitudConReintentos(urlAccion, {
        metodo: 'POST',
        cabeceras: {
          'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          origin: URL_BASE,
          referer: URL_INICIO,
        },
        datos: payload.toString(),
        cookies,
        reintento: { reintentos: 5, esperaBaseMs: 1500, esperaMaximaMs: 30000 },
      });

      const ubicacion = extraerCabecera(respuesta.cabeceras, 'location');
      if (respuesta.codigo >= 300 && respuesta.codigo < 400 && ubicacion) {
        const urlResultado = ubicacion.replace(/^http:\/\//i, 'https://');
        const paginaResultado = await obtenerPagina(urlResultado, cookies);
        const estadoVista = extraerEstadoVista(paginaResultado.html);
        if (!estadoVista) {
          throw new Error('No se pudo extraer el ViewState de resultado.xhtml');
        }
        console.log('Listo. Sesión establecida en resultado.xhtml');
        return {
          html: paginaResultado.html,
          estadoVista,
          cookies,
          urlResultado,
          camposResultado: parsearCamposFormulario(paginaResultado.html, 'formBuscador'),
        };
      }

      throw new Error(`La búsqueda devolvió HTTP ${respuesta.codigo}`);
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.warn(`No se pudo establecer la sesión (intento ${intento}/${INTENTOS_SESION}): ${motivo}`);
      if (intento === INTENTOS_SESION) throw error;
      await pausa(2000);
    }
  }
  throw new Error('No se pudo establecer la sesión');
}

// 4. Obtiene una página por GET y la decodifica.
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
  return { html: decodificarTexto(respuesta.datos) };
}

// 5. Solicita la siguiente página del listado usando el DataScroller de RichFaces.
async function obtenerSiguientePagina(sesion: Sesion): Promise<string> {
  const payload = new URLSearchParams();
  for (const [clave, valor] of Object.entries(sesion.camposResultado)) payload.set(clave, valor);
  payload.set('javax.faces.ViewState', sesion.estadoVista);
  payload.set('javax.faces.source', 'formBuscador:data2');
  payload.set('javax.faces.partial.event', 'rich:datascroller:onscroll');
  payload.set('javax.faces.partial.execute', 'formBuscador:data2 @component');
  payload.set('javax.faces.partial.render', '@component');
  payload.set('formBuscador:data2:page', 'next');
  payload.set('org.richfaces.ajax.component', 'formBuscador:data2');
  payload.set('formBuscador:data2', 'formBuscador:data2');
  payload.set('AJAX:EVENTS_COUNT', '1');
  payload.set('javax.faces.partial.ajax', 'true');

  const respuesta = await solicitudConReintentos(sesion.urlResultado, {
    metodo: 'POST',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/xml, text/xml, */*; q=0.01',
      'faces-request': 'partial/ajax',
    },
    datos: payload.toString(),
    cookies: sesion.cookies,
    reintento: { reintentos: 5, esperaBaseMs: 1500, esperaMaximaMs: 30000 },
  });

  const html = decodificarTexto(respuesta.datos);
  verificarRespuestaSinError(html);
  return html;
}

// 6. Abre la ficha de una resolución (RichFaces.ajax) y devuelve sus datos
//    y las descargas disponibles (PDF y Word).
async function solicitarFicha(
  resultado: RegistroResultado,
  sesion: Sesion
): Promise<{ datos: DatosFicha; descargas: { uuid: string; formato: 'pdf' | 'doc' }[] }> {
  const fuente = resultado.fichaSourceId ?? '';
  const payload = new URLSearchParams();
  for (const [clave, valor] of Object.entries(sesion.camposResultado)) payload.set(clave, valor);
  payload.set('javax.faces.ViewState', sesion.estadoVista);
  payload.set('javax.faces.source', fuente);
  payload.set('javax.faces.partial.event', 'click');
  payload.set('javax.faces.partial.execute', `${fuente} @component`);
  payload.set('javax.faces.partial.render', '@component');
  for (const [clave, valor] of Object.entries(resultado.fichaParams)) payload.set(clave, valor);
  payload.set('org.richfaces.ajax.component', fuente);
  payload.set(fuente, fuente);
  payload.set('AJAX:EVENTS_COUNT', '1');
  payload.set('javax.faces.partial.ajax', 'true');

  const respuesta = await solicitudConReintentos(sesion.urlResultado, {
    metodo: 'POST',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      accept: '*/*',
      'faces-request': 'partial/ajax',
      origin: URL_BASE,
      referer: sesion.urlResultado,
    },
    datos: payload.toString(),
    cookies: sesion.cookies,
    reintento: { reintentos: 3, esperaBaseMs: 2000, esperaMaximaMs: 30000 },
  });

  const html = decodificarTexto(respuesta.datos);
  verificarRespuestaSinError(html);
  return parsearFicha(html);
}

// 7. Descarga un archivo (ServletDescarga) y valida que no sea una página HTML.
async function descargarArchivo(
  ruta: string,
  carpeta: string,
  cookies: ContenedorCookies
): Promise<string> {
  const respuesta = await solicitudConReintentos(`${URL_BASE}${ruta}`, {
    metodo: 'GET',
    cabeceras: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      accept: '*/*',
    },
    cookies,
    reintento: { reintentos: 5, esperaBaseMs: 2000, esperaMaximaMs: 60000 },
  });

  if (respuesta.codigo >= 400) {
    throw new Error(`HTTP ${respuesta.codigo}`);
  }

  const cuerpo = Buffer.from(respuesta.datos);
  const inicio = cuerpo.subarray(0, 200).toString('latin1');
  if (
    cuerpo.length < 5 ||
    inicio.startsWith('<?xml') ||
    inicio.startsWith('<!DOCTYPE') ||
    inicio.startsWith('<html')
  ) {
    throw new Error('La respuesta no es un archivo válido (probable error del servidor)');
  }

  const nombre = obtenerNombreArchivoDeCabeceras(respuesta.cabeceras) ?? 'archivo';
  const rutaArchivo = `${carpeta}/${nombre}`;
  await writeFile(`${DIRECTORIO_SALIDA}/pdfs/${rutaArchivo}`, cuerpo);
  return rutaArchivo;
}

// 8. Reintenta las descargas fallidas registradas en failed.json.
async function reintentarDescargasFallidas(): Promise<void> {
  const rutaFallidos = `${DIRECTORIO_SALIDA}/failed.json`;
  let fallidas: RegistroFallido[] = [];
  try {
    fallidas = JSON.parse(await readFile(rutaFallidos, 'utf8')) as RegistroFallido[];
  } catch {
    console.log(`No existe ${rutaFallidos}; no hay descargas fallidas que reintentar.`);
    return;
  }

  const cookies: ContenedorCookies = { valor: '' };
  const restantes: RegistroFallido[] = [];
  let exitosos = 0;

  for (const registro of fallidas) {
    const carpeta = String(registro.grupo ?? 'sin-grupo');
    await asegurarDirectorio(`${DIRECTORIO_SALIDA}/pdfs/${carpeta}`);
    try {
      const rutaArchivo = await descargarArchivo(
        `/jurisprudenciaweb/ServletDescarga?uuid=${registro.uuid}`,
        carpeta,
        cookies
      );
      exitosos += 1;
      console.log(`Reintento OK [${registro.grupo}] ${registro.tipo}: ${rutaArchivo}`);
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.error(`Reintento fallido [${registro.grupo}] ${registro.tipo}: ${motivo}`);
      restantes.push({ ...registro, error: motivo, attemptedAt: new Date().toISOString() });
    }
    await pausa(RETARDO_PETICION_MS);
  }

  await escribirJson(rutaFallidos, restantes);
  console.log(`Reintentos: ${exitosos} OK, ${restantes.length} siguen fallando.`);
}

// 9. Guarda los datos extraídos (documents.json) y las descargas fallidas (failed.json).
async function guardarSalidas(
  documentos: RegistroExtraido[],
  descargasFallidas: RegistroFallido[]
): Promise<void> {
  await escribirJson(`${DIRECTORIO_SALIDA}/documents.json`, documentos);
  await escribirJson(`${DIRECTORIO_SALIDA}/failed.json`, descargasFallidas);
}

// 10. Escribe un archivo JSON con formato legible.
async function escribirJson(ruta: string, datos: unknown): Promise<void> {
  await writeFile(ruta, JSON.stringify(datos, null, 2));
}

// 11. Obtiene el nombre del archivo desde la cabecera content-disposition.
function obtenerNombreArchivoDeCabeceras(cabeceras: Cabeceras): string | undefined {
  const cruda = cabeceras['content-disposition'];
  const valor = Array.isArray(cruda) ? cruda[0] : cruda;
  const coincidencia = valor?.match(/filename="?([^"]+)"?/i);
  return coincidencia?.[1];
}

function extraerCabecera(cabeceras: Cabeceras, nombre: string): string | undefined {
  const cruda = cabeceras[nombre.toLowerCase()];
  return Array.isArray(cruda) ? cruda[0] : cruda;
}

// 12. Lanza un error si la respuesta AJAX contiene un error del servidor (ViewExpired, etc.).
function verificarRespuestaSinError(html: string): void {
  const nombreError = html.match(/<partial-response>\s*<error>[\s\S]*?<error-name>([^<]*)</i)?.[1];
  if (nombreError) {
    throw new Error(`Respuesta parcial con error del servidor: ${nombreError.trim()}`);
  }
}

void main().catch((error) => {
  const mensaje = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(mensaje);
  process.exitCode = 1;
});
