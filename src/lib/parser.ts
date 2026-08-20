import * as cheerio from 'cheerio';

export type RegistroDocumento = {
  index: number;
  kind?: 'analisis' | 'resolucion';
  title: string;
  number?: string;
  room?: string;
  date?: string;
  summary?: string;
  especialidad?: string;
  uuid?: string;
  rutaDoc?: string;
  downloadButtonName?: string;
  detailParams: Record<string, string>;
};

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

function parsearParametrosDescarga(onclick: string): Record<string, string> {
  const parametros: Record<string, string> = {};
  const coincidencia = onclick.match(/mojarra\.jsfcljs\(document\.getElementById\('formBoletin'\),\{([\s\S]*?)\},''\)/i);
  if (!coincidencia) return parametros;

  const entradas = Array.from(coincidencia[1].matchAll(/'([^']+)'\s*:\s*'([^']*)'/g));
  for (const [, clave, valor] of entradas) {
    parametros[clave] = valor;
  }
  return parametros;
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

function parsearParametrosDetalle(onclick: string): Record<string, string> {
  const parametros: Record<string, string> = {};
  // El servidor escapa el código JS dentro del atributo onclick; tras decodificar
  // las entidades, las comillas conservan una barra invertida (\"clave\":\"valor\").
  // Se desescapan primero para poder localizar el objeto de parámetros.
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

// Extrae los documentos de una página: el análisis completo (ruta_doc) de cada
// tarjeta y las resoluciones individuales (uuid) de cada fila de su tabla.
export function parsearDocumentos(html: string): RegistroDocumento[] {
  const $ = cheerio.load(extraerCdata(html));
  const documentos: RegistroDocumento[] = [];
  const vistos = new Set<string>();

  $('div.rf-p[id^="formBoletin:repeat:"]').each((_indicePanel, panelEl) => {
    const panel = $(panelEl);
    const bloqueTitulo = panel.find('span[style*="text-decoration: underline"]').first();
    const especialidad = limpiar(
      panel
        .find('span[style*="color:#3b5998"]')
        .filter((_, el) => {
          const texto = $(el).text().trim();
          return texto.length > 0 && !/^especialidad\s*:?$/i.test(texto);
        })
        .first()
        .text()
    );
    const resumen = limpiar(panel.find('p').first().text());

    // Documento completo: botón "Descargar" del panel (parámetro ruta_doc)
    const botonDescargar = panel.find('input[type="submit"][onclick*="mojarra.jsfcljs"]').first();
    const parametrosPanel = parsearParametrosDescarga(botonDescargar.attr('onclick') ?? '');
    if (botonDescargar.length > 0 && parametrosPanel.ruta_doc) {
      const claveUnica = `analisis:${parametrosPanel.ruta_doc}`;
      if (!vistos.has(claveUnica)) {
        vistos.add(claveUnica);
        documentos.push({
          index: documentos.length,
          kind: 'analisis',
          title: limpiar(bloqueTitulo.text()) ?? `document-${documentos.length + 1}`,
          summary: resumen,
          especialidad,
          rutaDoc: parametrosPanel.ruta_doc,
          downloadButtonName: botonDescargar.attr('name'),
          detailParams: {},
        });
      }
    }

    // Resoluciones individuales: ícono PDF de cada fila (parámetro uuid)
    panel.find('table[id$="gridParticipante"] tbody tr').each((_indiceFila, tr) => {
      const fila = $(tr);
      const celdas = fila.find('td');
      const inputDescarga = fila.find('input[type="image"][onclick*="mojarra.jsfcljs"]').first();
      const submitDescarga = fila.find('input[type="submit"][onclick*="mojarra.jsfcljs"]').first();
      const enlaceDetalle = fila.find('a[onclick*="RichFaces.ajax"]').first();
      if (inputDescarga.length === 0 && submitDescarga.length === 0 && enlaceDetalle.length === 0) {
        return;
      }

      const parametrosDescarga = parsearParametrosDescarga(inputDescarga.attr('onclick') ?? '');
      const parametrosDetalle = parsearParametrosDetalle(enlaceDetalle.attr('onclick') ?? '');
      const claveUnica =
        parametrosDescarga.ruta_doc ||
        parametrosDetalle.uuid ||
        limpiar(celdas.eq(0).text()) ||
        `document-${documentos.length + 1}`;
      if (vistos.has(claveUnica)) return;
      vistos.add(claveUnica);

      documentos.push({
        index: documentos.length,
        kind: 'resolucion',
        title: limpiar(bloqueTitulo.text()) ?? limpiar(celdas.eq(0).text()) ?? `document-${documentos.length + 1}`,
        number: limpiar(celdas.eq(0).clone().find('input').remove().end().text()),
        room: limpiar(celdas.eq(1).text()),
        date: limpiar(celdas.eq(2).text()),
        summary: resumen,
        especialidad,
        uuid: parametrosDetalle.uuid || parametrosDescarga.uuid,
        rutaDoc: parametrosDescarga.ruta_doc,
        downloadButtonName: inputDescarga.attr('name') ?? submitDescarga.attr('name') ?? undefined,
        detailParams: parametrosDetalle,
      });
    });
  });

  if (documentos.length === 0) {
    // Plan B: si el parseo por panel falla, se buscan filas directamente por regex.
    const crudo = extraerCdata(html);
    const coincidencias = Array.from(crudo.matchAll(/<tr[^>]*id="[^"]*gridParticipante:[^"]*"[\s\S]*?<\/tr>/gi));
    for (const [indice, coincidencia] of coincidencias.entries()) {
      const htmlFila = coincidencia[0];
      const $fila = cheerio.load(htmlFila);
      const celdas = $fila('td');
      const inputDescarga = $fila('input[type="image"][onclick*="mojarra.jsfcljs"]').first();
      const submitDescarga = $fila('input[type="submit"][onclick*="mojarra.jsfcljs"]').first();
      const enlaceDetalle = $fila('a[onclick*="RichFaces.ajax"]').first();
      if (inputDescarga.length === 0 && submitDescarga.length === 0 && enlaceDetalle.length === 0) {
        continue;
      }
      const parametrosDescarga = parsearParametrosDescarga(inputDescarga.attr('onclick') ?? '');
      const parametrosDetalle = parsearParametrosDetalle(enlaceDetalle.attr('onclick') ?? '');
      const bloqueTitulo = $fila('span[style*="text-decoration: underline"]').first();
      const claveUnica =
        parametrosDescarga.ruta_doc ||
        parametrosDetalle.uuid ||
        limpiar(celdas.eq(0).text()) ||
        `document-${indice + 1}`;
      if (vistos.has(claveUnica)) continue;
      vistos.add(claveUnica);

      documentos.push({
        index: indice,
        kind: 'resolucion',
        title: limpiar(bloqueTitulo.text()) ?? limpiar(celdas.eq(0).text()) ?? `document-${indice + 1}`,
        number: limpiar(celdas.eq(0).clone().find('input').remove().end().text()),
        room: limpiar(celdas.eq(1).text()),
        date: limpiar(celdas.eq(2).text()),
        summary: limpiar($fila('p').first().text()),
        uuid: parametrosDetalle.uuid || parametrosDescarga.uuid,
        rutaDoc: parametrosDescarga.ruta_doc,
        downloadButtonName: inputDescarga.attr('name') ?? submitDescarga.attr('name') ?? undefined,
        detailParams: parametrosDetalle,
      });
    }
  }

  return documentos;
}

// Indica si la página tiene un botón "siguiente" en el DataScroller de RichFaces.
export function extraerSiguientePagina(html: string): { siguientePagina?: string } {
  const $ = cheerio.load(extraerCdata(html));
  const existeBotonSiguiente = $('a.rf-ds-btn.rf-ds-btn-next').length > 0;
  return { siguientePagina: existeBotonSiguiente ? 'next' : undefined };
}
