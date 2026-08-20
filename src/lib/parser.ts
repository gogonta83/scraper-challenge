import * as cheerio from 'cheerio';

export type CamposFormulario = Record<string, string>;

export type RegistroResultado = {
  index: number;
  grupo: number;
  tipoRecurso?: string;
  nroexp?: string;
  especialidad?: string;
  tipoResolucion?: string;
  fechaResolucion?: string;
  organoJurisdiccional?: string;
  pretension?: string;
  sumilla?: string;
  palabrasClave?: string;
  uuid?: string;
  rutaDescarga?: string;
  fichaSourceId?: string;
  fichaParams: Record<string, string>;
};

export type DescargaFicha = { uuid: string; formato: 'pdf' | 'doc' };

export type DatosFicha = Record<string, string>;

function limpiar(valor: string | undefined): string | undefined {
  const texto = valor?.replace(/\s+/g, ' ').trim();
  return texto ? texto : undefined;
}

function decodificarEntidades(valor: string): string {
  return valor
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Une el contenido de los bloques CDATA de una respuesta parcial JSF.
// No se decodifican entidades aquí: &quot; dentro de atributos como
// onclick="...&quot;RichFaces.ajax(...)&quot;..." debe seguir escapado hasta
// que cheerio parsea el fragmento, o el valor del atributo se truncaría.
function extraerCdata(html: string): string {
  const bloquesCdata = Array.from(html.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/gi));
  return bloquesCdata.length === 0 ? html : bloquesCdata.map((coincidencia) => coincidencia[1]).join('\n');
}

// Desescapa una cadena JavaScript: \\u002D -> -, \\\/ -> /, \\n -> salto de línea, etc.
function desescaparCadenaJs(valor: string): string {
  return valor
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// El servidor escapa las comillas simples dentro de los onclick (ej. \'formBuscador\').
function normalizarComillasSimples(onclick: string): string {
  return onclick.replace(/\\'/g, "'");
}

// Parsea los parámetros de un onclick de mojarra.jsfcljs.
function parsearParametrosMojarra(onclick: string): Record<string, string> {
  const parametros: Record<string, string> = {};
  const codigoJs = normalizarComillasSimples(onclick);
  const coincidencia = codigoJs.match(/mojarra\.jsfcljs\(document\.getElementById\('([^']+)'\),\{([\s\S]*?)\},''\)/i);
  if (!coincidencia) return parametros;

  const entradas = Array.from(coincidencia[2].matchAll(/'([^']+)'\s*:\s*'([^']*)'/g));
  for (const [, clave, valor] of entradas) {
    parametros[clave] = valor;
  }
  return parametros;
}

// Parsea los parámetros de una llamada RichFaces.ajax (objeto "parameters").
function parsearParametrosRichFaces(onclick: string): Record<string, string> {
  const parametros: Record<string, string> = {};
  const codigoJs = onclick.replace(/\\"/g, '"');
  const coincidencia = codigoJs.match(/RichFaces\.ajax\([^\{]*\{\s*"parameters"\s*:\s*\{([\s\S]*?)\}\s*,\s*"incId"/i);
  if (!coincidencia) return parametros;

  const entradas = Array.from(coincidencia[1].matchAll(/"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g));
  for (const [, clave, valor] of entradas) {
    parametros[clave] = desescaparCadenaJs(valor);
  }
  return parametros;
}

// Las respuestas parciales JSF traen el siguiente view state en un elemento update:
//   <update id="javax.faces.ViewState"><![CDATA[123:456]]></update>
// Debe leerse de la respuesta cruda, porque extraer los CDATA destruye el elemento.
function extraerEstadoVistaParcial(html: string): string | undefined {
  const coincidencia = html.match(/<update\s+id="javax\.faces\.ViewState"[^>]*>([\s\S]*?)<\/update>/i);
  if (!coincidencia) return undefined;

  const interno = coincidencia[1]
    .replace(/^\s*<!\[CDATA\[\s*/, '')
    .replace(/\s*\]\]>\s*$/, '')
    .trim();
  return interno ? decodificarEntidades(interno) : undefined;
}

// Obtiene el ViewState de una página completa o de una respuesta parcial JSF.
export function extraerEstadoVista(html: string): string {
  const estadoVistaParcial = extraerEstadoVistaParcial(html);
  if (estadoVistaParcial) return estadoVistaParcial;

  const $ = cheerio.load(extraerCdata(html));
  return (
    $('input[name="javax.faces.ViewState"]').attr('value') ??
    $('update[id="javax.faces.ViewState"]').text().trim() ??
    ''
  );
}

// Extrae los campos de un formulario JSF tal como los enviaría un navegador:
// texto, ocultos, selects (opción seleccionada) y checkboxes marcados.
// Los botones imagen y los checkboxes sin marcar NO se incluyen.
export function parsearCamposFormulario(html: string, idFormulario: string): CamposFormulario {
  const $ = cheerio.load(html);
  const campos: CamposFormulario = {};
  const formulario = $(`form#${idFormulario}`);

  formulario.find('input').each((_, el) => {
    const nombre = $(el).attr('name');
    const tipo = $(el).attr('type') ?? '';
    if (!nombre) return;
    if (tipo === 'image') return;
    if (tipo === 'checkbox' && $(el).attr('checked') === undefined) return;
    campos[nombre] = $(el).attr('value') ?? '';
  });

  formulario.find('select').each((_, el) => {
    const nombre = $(el).attr('name');
    if (!nombre) return;
    const seleccionada = $(el).find('option[selected]').first().attr('value');
    campos[nombre] = seleccionada ?? $(el).find('option').first().attr('value') ?? '';
  });

  formulario.find('textarea').each((_, el) => {
    const nombre = $(el).attr('name');
    if (nombre) campos[nombre] = $(el).text().trim();
  });

  return campos;
}

export function parsearAccionFormulario(html: string, idFormulario: string): string {
  const $ = cheerio.load(html);
  return $(`form#${idFormulario}`).attr('action') ?? '';
}

// Busca el botón "Buscar" del formulario (mojarra.jsfcljs con forward=buscar).
// Prefiere el que incluye el parámetro "busqueda" (búsqueda especializada).
export function parsearBotonBusqueda(
  html: string,
  idFormulario: string
): { nombre: string; params: Record<string, string> } {
  const $ = cheerio.load(html);
  let mejor: { nombre: string; params: Record<string, string> } | undefined;

  $(`form#${idFormulario} input[type="image"][onclick*="mojarra.jsfcljs"]`).each((_, el) => {
    const nombre = $(el).attr('name');
    if (!nombre) return;
    const params = parsearParametrosMojarra($(el).attr('onclick') ?? '');
    if (params['forward'] !== 'buscar') return;
    if (params['busqueda'] || !mejor) mejor = { nombre, params };
  });

  return mejor ?? { nombre: '', params: {} };
}

// Extrae los recuadros de resultado.xhtml. Cada recuadro es una resolución con
// sus detalles, el enlace "Ver Resolución" (descarga directa) y el botón
// "Ver Ficha" (RichFaces.ajax con los parámetros del caso).
export function parsearResultados(html: string, grupoInicial = 0): RegistroResultado[] {
  const $ = cheerio.load(extraerCdata(html));
  const resultados: RegistroResultado[] = [];
  let numeroGrupo = grupoInicial;

  $('div.rf-p[id^="formBuscador:repeat:"]').each((_indicePanel, panelEl) => {
    numeroGrupo += 1;
    const panel = $(panelEl);
    const cabeceras = panel.find('.rf-p-hdr span[style*="font-weight:bold"]');

    const resultado: RegistroResultado = {
      index: resultados.length,
      grupo: numeroGrupo,
      tipoRecurso: limpiar(cabeceras.eq(0).text()),
      nroexp: limpiar(cabeceras.eq(1).text()),
      fichaParams: {},
    };

    // Detalles del cuerpo: pares etiqueta/valor
    const etiquetaACampo: Record<
      string,
      | 'tipoRecurso'
      | 'especialidad'
      | 'tipoResolucion'
      | 'fechaResolucion'
      | 'organoJurisdiccional'
      | 'pretension'
      | 'sumilla'
      | 'palabrasClave'
    > = {
      'especialidad': 'especialidad',
      'tipo resolucion': 'tipoResolucion',
      'fecha resolucion': 'fechaResolucion',
      'organo jurisdiccional': 'organoJurisdiccional',
      'pretencion / delito': 'pretension',
      'sumilla': 'sumilla',
      'palabras clave': 'palabrasClave',
    };
    panel.find('.rf-p-b .txtbold').each((_, el) => {
      const etiqueta = limpiar($(el).text())?.toLowerCase().replace(/:$/, '').trim();
      if (!etiqueta) return;
      const campo = etiquetaACampo[etiqueta];
      if (!campo) return;
      const valor = limpiar($(el).next().text());
      if (valor) resultado[campo] = valor;
    });

    // Botón "Ver Ficha"
    const enlaceFicha = panel.find('a[title="Ver"]').first();
    if (enlaceFicha.length > 0) {
      resultado.fichaSourceId = enlaceFicha.attr('id');
      resultado.fichaParams = parsearParametrosRichFaces(enlaceFicha.attr('onclick') ?? '');
    }

    // Enlace "Ver Resolución" (descarga directa)
    const enlaceDescarga = panel.find('a[href*="ServletDescarga"]').first();
    if (enlaceDescarga.length > 0) {
      const href = enlaceDescarga.attr('href') ?? '';
      resultado.rutaDescarga = href;
      try {
        resultado.uuid = new URL(href, 'https://jurisprudencia.pj.gob.pe').searchParams.get('uuid') ?? undefined;
      } catch {
        resultado.uuid = undefined;
      }
    }

    resultados.push(resultado);
  });

  return resultados;
}

// Extrae el contenido del popup de la ficha: datos etiqueta/valor y los enlaces
// de descarga (PDF y Word) dentro de "Archivo de la Resolución".
export function parsearFicha(html: string): { datos: DatosFicha; descargas: DescargaFicha[] } {
  const coincidencia = html.match(
    /<update\s+id="([^"]*popupResolucion[^"]*)"[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]><\/update>/i
  );
  const contenido = coincidencia?.[2] ?? '';
  const $ = cheerio.load(contenido);
  const datos: DatosFicha = {};

  $('.txtbold').each((_, el) => {
    const etiqueta = limpiar($(el).text());
    if (!etiqueta) return;
    const contenedorValor = $(el).next();
    const valor = limpiar(contenedorValor.find('.data').first().text() || contenedorValor.text());
    if (valor) datos[etiqueta] = valor;
  });

  const descargas: DescargaFicha[] = [];
  $('a[href*="ServletDescarga"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    try {
      const uuid = new URL(href, 'https://jurisprudencia.pj.gob.pe').searchParams.get('uuid');
      if (!uuid) return;
      const imagen =
        $(el).find('img').attr('src') ?? $(el).find('input[type="image"]').attr('src') ?? '';
      descargas.push({ uuid, formato: imagen.toLowerCase().includes('word') ? 'doc' : 'pdf' });
    } catch {
      // URL inválida: se ignora
    }
  });

  return { datos, descargas };
}

// Indica si la página tiene un botón "siguiente" en el DataScroller de RichFaces.
export function extraerSiguientePagina(html: string): { siguientePagina?: string } {
  const $ = cheerio.load(extraerCdata(html));
  const existeBotonSiguiente = $('a.rf-ds-btn.rf-ds-btn-next').length > 0;
  return { siguientePagina: existeBotonSiguiente ? 'next' : undefined };
}
