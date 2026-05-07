import { describe, expect, it, vi } from 'vitest';
import { createGoogleSheetsService } from './google-sheets.mjs';

describe('google sheets service writes', () => {
  it('appends rows with USER_ENTERED values to the requested tab', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/spreadsheets/1sheet001aaaaaaaaaaaaaa/values/');
      expect(String(input)).toContain(':append');
      expect(String(input)).toContain('valueInputOption=USER_ENTERED');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        majorDimension: 'ROWS',
        values: [
          ['case_id', 'payee_name'],
          ['PAY-202605-0001', '김민수'],
        ],
      });

      return new Response(JSON.stringify({
        spreadsheetId: '1sheet001aaaaaaaaaaaaaa',
        tableRange: 'payments!A1:B1',
        updates: { updatedRows: 2, updatedCells: 4 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const service = createGoogleSheetsService({
      fetchImpl,
      authHeadersFactory: async () => ({ authorization: 'Bearer test-token' }),
      config: { enabled: true },
    });

    const result = await service.appendRows({
      spreadsheetId: '1sheet001aaaaaaaaaaaaaa',
      sheetName: 'payments',
      rows: [
        ['case_id', 'payee_name'],
        ['PAY-202605-0001', '김민수'],
      ],
    });

    expect(result.updatedRows).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
