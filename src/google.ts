import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// A call that gets no answer in this time fails, so one hung call can't hold a lock forever.
const CALL_TIMEOUT_MS = 30_000;

// The parts of a failed Google API call the retry rule reads.
interface FailedCall {
  config: { url?: unknown; retryConfig?: { currentRetryAttempt?: number; retry?: number } };
  response?: { status: number };
}

// Retries with backoff (about 0.1, 1.5, 3.5, 7.5 and 15.5 seconds), so a busy
// minute's rate limit (60 reads per minute) is waited out. A rate-limited call
// was refused, so it's always safe to retry. Other failures are retried except
// on appends: an append that timed out may have landed, and a retry could
// write its row twice.
const RETRY = {
  retry: 5,
  httpMethodsToRetry: ['GET', 'PUT', 'POST'],
  shouldRetry: (err: FailedCall) => {
    const config = err.config.retryConfig!;
    if ((config.currentRetryAttempt ?? 0) >= config.retry!) return false;
    const status = err.response?.status;
    if (status === 429) return true;
    if (String(err.config.url).includes(':append')) return false;
    return status === undefined || status === 408 || status >= 500;
  },
};

let clients: { sheets: sheets_v4.Sheets } | undefined;

function getClients() {
  if (clients) return clients;

  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_B64 is not set');
  const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  const options = { auth, timeout: CALL_TIMEOUT_MS, retryConfig: RETRY };
  clients = {
    sheets: google.sheets({ version: 'v4', ...options }),
  };
  return clients;
}

export const getSheets = () => getClients().sheets;
