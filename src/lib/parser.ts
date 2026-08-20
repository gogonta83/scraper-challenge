import * as cheerio from 'cheerio';

export type DocumentRecord = {
  index: number;
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

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function unwrapPartialResponse(html: string): string {
  const cdataBlocks = Array.from(html.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/gi));
  // Do NOT decode HTML entities here: &quot; inside an attribute like
  // onclick="...&quot;RichFaces.ajax(...)&quot;..." must stay escaped until
  // cheerio parses the fragment, otherwise the attribute value is truncated.
  return cdataBlocks.length === 0 ? html : cdataBlocks.map((match) => match[1]).join('\n');
}

function parseDownloadParams(onclick: string): Record<string, string> {
  const params: Record<string, string> = {};
  const match = onclick.match(/mojarra\.jsfcljs\(document\.getElementById\('formBoletin'\),\{([\s\S]*?)\},''\)/i);
  if (!match) return params;

  const entries = Array.from(match[1].matchAll(/'([^']+)'\s*:\s*'([^']*)'/g));
  for (const [, key, value] of entries) {
    params[key] = value;
  }
  return params;
}

function unescapeJsString(value: string): string {
  return value
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseDetailParams(onclick: string): Record<string, string> {
  const params: Record<string, string> = {};
  // The server HTML-escapes the JS source inside the onclick attribute, so after
  // entity decoding the quotes still carry a backslash (\"key\":\"value\"). Unescape
  // those first so the JSON-ish parameters object can be matched normally.
  const jsSource = onclick.replace(/\\"/g, '"');
  const match = jsSource.match(/RichFaces\.ajax\([^\{]*\{\s*"parameters"\s*:\s*\{([\s\S]*?)\}\s*,\s*"incId"/i);
  if (!match) return params;

  const entries = Array.from(match[1].matchAll(/"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g));
  for (const [, key, value] of entries) {
    params[key] = unescapeJsString(value);
  }
  return params;
}

function extractPartialViewState(html: string): string | undefined {
  // JSF partial responses carry the next view state inside a CDATA update element:
  //   <update id="javax.faces.ViewState"><![CDATA[123:456]]></update>
  // This must be read from the RAW response, because unwrapping the CDATA blocks
  // destroys the <update> element that holds it.
  const match = html.match(/<update\s+id="javax\.faces\.ViewState"[^>]*>([\s\S]*?)<\/update>/i);
  if (!match) return undefined;

  const inner = match[1]
    .replace(/^\s*<!\[CDATA\[\s*/, '')
    .replace(/\s*\]\]>\s*$/, '')
    .trim();
  return inner ? decodeEntities(inner) : undefined;
}

export function extractViewState(html: string): string {
  const partialViewState = extractPartialViewState(html);
  if (partialViewState) return partialViewState;

  const $ = cheerio.load(unwrapPartialResponse(html));
  return (
    $('input[name="javax.faces.ViewState"]').attr('value') ??
    $('update[id="javax.faces.ViewState"]').text().trim() ??
    ''
  );
}

export function parseDocumentsFromHtml(html: string): DocumentRecord[] {
  const $ = cheerio.load(unwrapPartialResponse(html));
  const docs: DocumentRecord[] = [];
  const seen = new Set<string>();

  $('table[id$="gridParticipante"] tbody tr').each((index, tr) => {
    const row = $(tr);
    const cells = row.find('td');
    const downloadInput = row.find('input[type="image"][onclick*="mojarra.jsfcljs"]').first();
    const downloadSubmit = row.find('input[type="submit"][onclick*="mojarra.jsfcljs"]').first();
    const detailLink = row.find('a[onclick*="RichFaces.ajax"]').first();
    if (downloadInput.length === 0 && downloadSubmit.length === 0 && detailLink.length === 0) {
      return;
    }

    const downloadParams = parseDownloadParams(downloadInput.attr('onclick') ?? '');
    const detailParams = parseDetailParams(detailLink.attr('onclick') ?? '');
    const panel = row.closest('.rf-p');
    const titleBlock = panel.find('span[style*="text-decoration: underline"]').first();
    const especialidad = clean(
      panel
        .find('span[style*="color:#3b5998"]')
        .filter((_, el) => {
          const text = $(el).text().trim();
          return text.length > 0 && !/^especialidad\s*:?$/i.test(text);
        })
        .first()
        .text()
    );
    const uniqueKey = downloadParams.ruta_doc || detailParams.uuid || clean(cells.eq(0).text()) || `document-${index + 1}`;
    if (seen.has(uniqueKey)) return;
    seen.add(uniqueKey);

    docs.push({
      index,
      title: clean(titleBlock.text()) ?? clean(cells.eq(0).text()) ?? `document-${index + 1}`,
      number: clean(cells.eq(0).clone().find('input').remove().end().text()),
      room: clean(cells.eq(1).text()),
      date: clean(cells.eq(2).text()),
      summary: clean(panel.find('p').first().text()),
      especialidad,
      uuid: detailParams.uuid || downloadParams.uuid,
      rutaDoc: downloadParams.ruta_doc,
      downloadButtonName: downloadInput.attr('name') ?? downloadSubmit.attr('name') ?? undefined,
      detailParams,
    });
  });

  if (docs.length === 0) {
    const raw = unwrapPartialResponse(html);
    const matches = Array.from(raw.matchAll(/<tr[^>]*id="[^"]*gridParticipante:[^"]*"[\s\S]*?<\/tr>/gi));
    for (const [index, match] of matches.entries()) {
      const rowHtml = match[0];
      const $row = cheerio.load(rowHtml);
      const cells = $row('td');
      const downloadInput = $row('input[type="image"][onclick*="mojarra.jsfcljs"]').first();
      const downloadSubmit = $row('input[type="submit"][onclick*="mojarra.jsfcljs"]').first();
      const detailLink = $row('a[onclick*="RichFaces.ajax"]').first();
      if (downloadInput.length === 0 && downloadSubmit.length === 0 && detailLink.length === 0) {
        continue;
      }
      const downloadParams = parseDownloadParams(downloadInput.attr('onclick') ?? '');
      const detailParams = parseDetailParams(detailLink.attr('onclick') ?? '');
      const titleBlock = $row('span[style*="text-decoration: underline"]').first();
      const uniqueKey = downloadParams.ruta_doc || detailParams.uuid || clean(cells.eq(0).text()) || `document-${index + 1}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);

      docs.push({
        index,
        title: clean(titleBlock.text()) ?? clean(cells.eq(0).text()) ?? `document-${index + 1}`,
        number: clean(cells.eq(0).clone().find('input').remove().end().text()),
        room: clean(cells.eq(1).text()),
        date: clean(cells.eq(2).text()),
        summary: clean($row('p').first().text()),
        uuid: detailParams.uuid || downloadParams.uuid,
        rutaDoc: downloadParams.ruta_doc,
        downloadButtonName: downloadInput.attr('name') ?? downloadSubmit.attr('name') ?? undefined,
        detailParams,
      });
    }
  }

  return docs;
}

export function extractNextPagePayload(html: string): { nextPage?: string } {
  const $ = cheerio.load(unwrapPartialResponse(html));
  const nextButtonExists = $('a.rf-ds-btn.rf-ds-btn-next').length > 0;
  return { nextPage: nextButtonExists ? 'next' : undefined };
}
