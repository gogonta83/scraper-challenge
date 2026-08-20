import axios from 'axios';

export type Cabeceras = Record<string, string | string[]>;

type OpcionesReintento = {
  reintentos: number;
  esperaBaseMs: number;
  esperaMaximaMs: number;
};

type OpcionesSolicitud = {
  metodo?: 'GET' | 'POST';
  cabeceras?: Record<string, string>;
  datos?: string;
  cookies?: { valor: string };
  reintento: OpcionesReintento;
};

// Espera la cantidad de milisegundos indicada.
export async function pausa(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizarCabeceras(cabeceras: unknown): Cabeceras {
  const resultado: Cabeceras = {};
  if (!cabeceras || typeof cabeceras !== 'object') return resultado;

  for (const [clave, valor] of Object.entries(cabeceras as Record<string, unknown>)) {
    if (typeof valor === 'string' || Array.isArray(valor)) {
      resultado[clave] = valor;
    } else if (valor != null) {
      resultado[clave] = String(valor);
    }
  }

  return resultado;
}

// Envía una solicitud HTTP con reintentos (429 y 5xx) y backoff exponencial.
export async function solicitudConReintentos(
  url: string,
  opciones: OpcionesSolicitud
): Promise<{ codigo: number; cabeceras: Cabeceras; datos: Buffer }> {
  let ultimoError: unknown;

  for (let intento = 0; intento <= opciones.reintento.reintentos; intento += 1) {
    try {
      const valorCookie = opciones.cookies?.valor;
      const respuesta = await axios.request({
        url,
        method: opciones.metodo ?? 'GET',
        headers: {
          ...opciones.cabeceras,
          ...(valorCookie ? { cookie: valorCookie } : {}),
        },
        data: opciones.datos,
        // Se piden siempre los bytes crudos: axios decodificaría con el charset
        // declarado y convertiría títulos Latin-1 como "Análisis" en "An�lisis".
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });

      // Se reintenta solo 429 (límite de peticiones) y errores 5xx transitorios.
      if (respuesta.status !== 429 && respuesta.status < 500) {
        fusionarCookies(respuesta.headers, opciones.cookies);
        return {
          codigo: respuesta.status,
          cabeceras: normalizarCabeceras(respuesta.headers),
          datos: respuesta.data,
        };
      }

      if (intento === opciones.reintento.reintentos) {
        fusionarCookies(respuesta.headers, opciones.cookies);
        return {
          codigo: respuesta.status,
          cabeceras: normalizarCabeceras(respuesta.headers),
          datos: respuesta.data,
        };
      }

      const reintentoTras = Number(respuesta.headers['retry-after'] ?? NaN);
      const esperaMs = Math.min(
        opciones.reintento.esperaMaximaMs,
        opciones.reintento.esperaBaseMs * 2 ** intento
      );
      await pausa(Math.max(Number.isFinite(reintentoTras) ? reintentoTras * 1000 : 0, esperaMs));
    } catch (error) {
      ultimoError = error;
      if (intento === opciones.reintento.reintentos) throw error;
      const esperaMs = Math.min(
        opciones.reintento.esperaMaximaMs,
        opciones.reintento.esperaBaseMs * 2 ** intento
      );
      await pausa(esperaMs);
    }
  }

  throw ultimoError instanceof Error ? ultimoError : new Error('La solicitud falló');
}

// Decodifica el cuerpo de una respuesta: primero UTF-8 estricto y, si falla,
// Windows-1252 (el portal declara ISO-8859-1 pero envía texto Latin-1 de un byte).
export function decodificarTexto(datos: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(datos);
  } catch {
    return new TextDecoder('windows-1252').decode(datos);
  }
}

function fusionarCookies(cabeceras: Record<string, unknown>, contenedor?: { valor: string }): void {
  if (!contenedor) return;
  const cruda = cabeceras['set-cookie'];
  const valores = Array.isArray(cruda)
    ? cruda
    : cruda
      ? [cruda]
      : [];
  if (valores.length === 0) return;

  const entradas = new Map<string, string>();
  for (const parte of `${contenedor.valor}; ${valores.map((v) => String(v).split(';')[0]).join('; ')}`.split(';')) {
    const recortada = parte.trim();
    if (!recortada) continue;
    const igual = recortada.indexOf('=');
    if (igual > 0) entradas.set(recortada.slice(0, igual).trim(), recortada);
  }
  contenedor.valor = [...entradas.values()].join('; ');
}

// Crea el directorio indicado (y sus padres) si no existe.
export async function asegurarDirectorio(ruta: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(ruta, { recursive: true });
}

// Convierte un texto en un nombre de archivo seguro para el sistema operativo.
export function sanitizarNombreArchivo(nombre: string): string {
  return (
    nombre
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'documento'
  );
}
