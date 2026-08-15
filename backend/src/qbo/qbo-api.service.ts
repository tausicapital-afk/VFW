import { BadGatewayException, Injectable } from '@nestjs/common';
import { QboConnectionService } from './qbo-connection.service';
import { apiBase, qboAccountingError } from './qbo.types';

// Pinned rather than "latest": an Intuit minor-version bump can change response
// shape, and this integration should not silently start seeing a different one.
const MINOR_VERSION = '69';

/**
 * Thin authenticated transport to the QuickBooks Online Accounting API —
 * token attachment and error shape only. What gets queried or created is
 * QboMappingService's and QboExportService's job.
 */
@Injectable()
export class QboApiService {
  constructor(private readonly connection: QboConnectionService) {}

  /** Escape a string for QBO's SQL-like query language (single quotes double up). */
  static escape(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const { accessToken, realmId, environment } = await this.connection.ensureFreshToken();
    const url = `${apiBase(environment)}/v3/company/${realmId}${path}${path.includes('?') ? '&' : '?'}minorversion=${MINOR_VERSION}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new BadGatewayException(await qboAccountingError(res));
    return (await res.json()) as T;
  }

  /** `SELECT * FROM <entity> WHERE <where>` — `where` is the raw clause, already escaped by the caller. */
  async query<T>(entity: string, where?: string): Promise<T[]> {
    const sql = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} MAXRESULTS 1000`;
    const body = await this.request<{ QueryResponse?: Record<string, T[]> }>(
      `/query?query=${encodeURIComponent(sql)}`,
      { method: 'GET' },
    );
    return body.QueryResponse?.[entity] ?? [];
  }

  async create<T>(entity: string, payload: Record<string, unknown>): Promise<T> {
    const body = await this.request<Record<string, T>>(`/${entity.toLowerCase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = body[entity];
    if (!result) throw new BadGatewayException(`QuickBooks did not return the created ${entity}`);
    return result;
  }
}
