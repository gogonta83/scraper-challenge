import { readFile, writeFile } from 'node:fs/promises';
import { decodeText, ensureDirPath, requestWithRetry, sanitizeFileName, sleep } from './lib/http.js';
import { extractNextPagePayload, extractViewState, parseDocumentsFromHtml, type DocumentRecord } from './lib/parser.js';

const START_URL =
  process.env.START_URL ?? 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/analisis-jurisprudencial.xhtml';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? 'scraped';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? '0');
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? '4000');
const MAX_DOWNLOAD_ATTEMPTS = Number(process.env.MAX_DOWNLOAD_ATTEMPTS ?? '1');
const SESSION_ATTEMPTS = Number(process.env.SESSION_ATTEMPTS ?? '5');

type Session = {
  html: string;
  viewState: string;
  cookieJar: { value: string };
};

type ExtractedRecord = DocumentRecord & {
  pdfFile?: string;
};

type FailedRecord = {
  title: string;
  number?: string;
  uuid?: string;
  rutaDoc?: string;
  downloadButtonName?: string;
  error: string;
  attemptedAt: string;
};

async function main(): Promise<void> {
  await ensureDirPath(OUTPUT_DIR);
  await ensureDirPath(`${OUTPUT_DIR}/pdfs`);

  if ((process.env.RETRY_FAILED ?? '0') === '1') {
    await retryFailedDownloads();
    return;
  }

  let attemptedDownloads = 0;
  let successfulDownloads = 0;
  const documents: ExtractedRecord[] = [];
  const failedDownloads: FailedRecord[] = [];
  let session = await establishSession();
  let pageCount = 1;

  while (true) {
    const pageDocuments = parseDocumentsFromHtml(session.html);
    console.log(`Página ${pageCount}: ${pageDocuments.length} documentos`);
    const pageRecords: ExtractedRecord[] = pageDocuments.map((document) => ({ ...document }));
    documents.push(...pageRecords);

    for (let i = 0; i < pageDocuments.length; i += 1) {
      const document = pageDocuments[i];
      const record = pageRecords[i];
      if (MAX_DOWNLOAD_ATTEMPTS > 0 && attemptedDownloads >= MAX_DOWNLOAD_ATTEMPTS) {
        console.log(`Se alcanzó MAX_DOWNLOAD_ATTEMPTS=${MAX_DOWNLOAD_ATTEMPTS}`);
        await persistOutputs(documents, failedDownloads);
        return;
      }

      attemptedDownloads += 1;
      try {
        const savedFile = await downloadDocument(document, session.viewState, session.cookieJar);
        record.pdfFile = savedFile;
        successfulDownloads += 1;
        console.log(`Descargado: ${document.title} -> ${savedFile}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Fallo "${document.title}": ${reason}`);
        let recovered = false;
        if (isSessionError(reason)) {
          try {
            console.log('Reintentando con una sesión nueva...');
            session = await establishSession();
            const savedFile = await downloadDocument(document, session.viewState, session.cookieJar);
            record.pdfFile = savedFile;
            successfulDownloads += 1;
            recovered = true;
            console.log(`Descargado (reintento): ${document.title} -> ${savedFile}`);
          } catch (retryError) {
            const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
            console.error(`Fallo en el reintento "${document.title}": ${retryReason}`);
          }
        }
        if (!recovered) {
          failedDownloads.push(toFailedRecord(document, reason));
        }
      }

      await sleep(REQUEST_DELAY_MS);
    }

    await persistOutputs(documents, failedDownloads);

    if (MAX_PAGES > 0 && pageCount >= MAX_PAGES) break;

    const nextPayload = extractNextPagePayload(session.html);
    if (!nextPayload.nextPage) break;

    try {
      session.html = await fetchNextPage(session.viewState, session.cookieJar);
      session.viewState = extractViewState(session.html) || session.viewState;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`No se pudo avanzar a la página ${pageCount + 1}: ${reason}`);
      break;
    }
    pageCount += 1;
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `\nResumen: ${documents.length} documentos encontrados, ${successfulDownloads} PDFs descargados, ${failedDownloads.length} fallidos.`
  );
  console.log(`Datos extraídos: ${OUTPUT_DIR}/documents.json`);
  console.log(`Descargas fallidas: ${OUTPUT_DIR}/failed.json`);
}

async function retryFailedDownloads(): Promise<void> {
  const failedPath = `${OUTPUT_DIR}/failed.json`;
  let failed: FailedRecord[] = [];
  try {
    failed = JSON.parse(await readFile(failedPath, 'utf8')) as FailedRecord[];
  } catch {
    console.log(`No existe ${failedPath}; no hay descargas fallidas que reintentar.`);
    return;
  }

  const pending = failed.filter((entry) => entry.downloadButtonName && entry.uuid);
  if (pending.length === 0) {
    console.log('No hay descargas fallidas pendientes.');
    return;
  }

  console.log(`Reintentando ${pending.length} descargas fallidas...`);
  const session = await establishSession();
  const remaining: FailedRecord[] = [];
  let ok = 0;

  for (const entry of pending) {
    const document: DocumentRecord = {
      index: -1,
      title: entry.title,
      number: entry.number,
      uuid: entry.uuid,
      rutaDoc: entry.rutaDoc,
      downloadButtonName: entry.downloadButtonName,
      detailParams: {},
    };
    try {
      const savedFile = await downloadDocument(document, session.viewState, session.cookieJar);
      ok += 1;
      console.log(`Reintento OK: ${entry.title} -> ${savedFile}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Reintento fallido "${entry.title}": ${reason}`);
      remaining.push({ ...entry, error: reason, attemptedAt: new Date().toISOString() });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await writeJson(failedPath, remaining);
  console.log(`Reintentos: ${ok} OK, ${remaining.length} siguen fallando.`);
}

async function persistOutputs(documents: ExtractedRecord[], failedDownloads: FailedRecord[]): Promise<void> {
  await writeJson(`${OUTPUT_DIR}/documents.json`, documents);
  await writeJson(`${OUTPUT_DIR}/failed.json`, failedDownloads);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function establishSession(): Promise<Session> {
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt += 1) {
    const cookieJar = { value: '' };
    try {
      const initialPage = await fetchPage(START_URL, cookieJar);
      let viewState = extractViewState(initialPage.html);
      const html = await fetchInitialResults(viewState, cookieJar);
      viewState = extractViewState(html) || viewState;
      if (!viewState) {
        throw new Error('No se pudo extraer el ViewState de la sesión');
      }
      console.log(`Listo. ViewState: ${viewState ? 'sí' : 'no'}`);
      return { html, viewState, cookieJar };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`No se pudo establecer la sesión (intento ${attempt}/${SESSION_ATTEMPTS}): ${reason}`);
      if (attempt === SESSION_ATTEMPTS) throw error;
      await sleep(2000);
    }
  }
  throw new Error('No se pudo establecer la sesión');
}

async function fetchPage(url: string, cookieJar: { value: string }): Promise<{ html: string }> {
  console.log(`GET ${url}`);
  const response = await requestWithRetry(url, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    cookieJar,
    retry: { retries: 5, baseDelayMs: 1500, maxDelayMs: 30000 },
  });

  return {
    html: decodeText(response.data),
  };
}

async function fetchInitialResults(viewState: string, cookieJar: { value: string }): Promise<string> {
  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('javax.faces.ViewState', viewState ?? '');
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

  const response = await requestWithRetry(START_URL, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/xml, text/xml, */*; q=0.01',
      'faces-request': 'partial/ajax',
      origin: 'https://jurisprudencia.pj.gob.pe',
      referer: START_URL,
    },
    data: payload.toString(),
    cookieJar,
    retry: { retries: 5, baseDelayMs: 1500, maxDelayMs: 30000 },
  });

  const html = decodeText(response.data);
  ensureNotErrorResponse(html);
  return html;
}

async function fetchNextPage(viewState: string, cookieJar: { value: string }): Promise<string> {
  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('formBoletin:txtTitulo', '');
  payload.set('formBoletin:buTipPublicacion', '7');
  payload.set('formBoletin:buEspecialidad', '0');
  payload.set('javax.faces.ViewState', viewState ?? '');
  payload.set('javax.faces.source', 'formBoletin:data2');
  payload.set('javax.faces.partial.event', 'rich:datascroller:onscroll');
  payload.set('javax.faces.partial.execute', 'formBoletin:data2 @component');
  payload.set('javax.faces.partial.render', '@component');
  payload.set('formBoletin:data2:page', 'next');
  payload.set('org.richfaces.ajax.component', 'formBoletin:data2');
  payload.set('formBoletin:data2', 'formBoletin:data2');
  payload.set('AJAX:EVENTS_COUNT', '1');
  payload.set('javax.faces.partial.ajax', 'true');

  const response = await requestWithRetry(START_URL, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/xml, text/xml, */*; q=0.01',
      'faces-request': 'partial/ajax',
    },
    data: payload.toString(),
    cookieJar,
    retry: { retries: 5, baseDelayMs: 1500, maxDelayMs: 30000 },
  });

  const html = decodeText(response.data);
  ensureNotErrorResponse(html);
  return html;
}

async function downloadDocument(
  document: DocumentRecord,
  viewState: string,
  cookieJar: { value: string }
): Promise<string> {
  if (!viewState) {
    throw new Error('No hay ViewState para descargar (sesión inválida)');
  }

  const payload = new URLSearchParams();
  payload.set('formBoletin', 'formBoletin');
  payload.set('formBoletin:txtTitulo', '');
  payload.set('formBoletin:buTipPublicacion', '7');
  payload.set('formBoletin:buEspecialidad', '0');
  payload.set('javax.faces.ViewState', viewState);
  if (document.downloadButtonName) {
    payload.set(document.downloadButtonName, document.downloadButtonName);
  }
  if (document.uuid) {
    payload.set('uuid', document.uuid);
  }

  const response = await requestWithRetry(START_URL, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ScraperChallenge/1.0)',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      origin: 'https://jurisprudencia.pj.gob.pe',
      referer: START_URL,
    },
    data: payload.toString(),
    responseType: 'arraybuffer',
    cookieJar,
    retry: { retries: 5, baseDelayMs: 2000, maxDelayMs: 60000 },
  });

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }

  const filename = getFilenameFromHeaders(response.headers) ?? `${sanitizeFileName(document.title)}.pdf`;
  const body = Buffer.from(response.data);
  if (body.length < 5 || body.toString('latin1', 0, 5) !== '%PDF-') {
    throw new Error('La respuesta no es un PDF (sesión/ViewState expirado o error del servidor)');
  }
  await writeFile(`${OUTPUT_DIR}/pdfs/${filename}`, body);
  return filename;
}

function toFailedRecord(document: DocumentRecord, error: string): FailedRecord {
  return {
    title: document.title,
    number: document.number,
    uuid: document.uuid,
    rutaDoc: document.rutaDoc,
    downloadButtonName: document.downloadButtonName,
    error,
    attemptedAt: new Date().toISOString(),
  };
}

function getFilenameFromHeaders(headers: Record<string, string | string[]>): string | undefined {
  const raw = headers['content-disposition'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/filename="?([^"]+)"?/i);
  return match?.[1];
}

function ensureNotErrorResponse(html: string): void {
  const errorName = html.match(/<partial-response>\s*<error>[\s\S]*?<error-name>([^<]*)</i)?.[1];
  if (errorName) {
    throw new Error(`Respuesta parcial con error del servidor: ${errorName.trim()}`);
  }
}

function isSessionError(reason: string): boolean {
  return (
    reason.includes('ViewState') ||
    reason.includes('ViewExpired') ||
    reason.includes('no es un PDF') ||
    reason.includes('Respuesta parcial')
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
