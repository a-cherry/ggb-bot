import { google } from 'googleapis';
import type { sheets_v4, drive_v3 } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
];

let clients: { sheets: sheets_v4.Sheets; drive: drive_v3.Drive } | undefined;

function getClients() {
  if (clients) return clients;

  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_B64 is not set');
  const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  clients = {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
  return clients;
}

export const getSheets = () => getClients().sheets;
export const getDrive = () => getClients().drive;