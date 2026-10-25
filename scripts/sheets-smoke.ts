import dotenv from 'dotenv';
dotenv.config();
import { getSheets } from '../src/google.js';

const spreadsheetId = process.env.GOOGLE_LEAGUE_DB_ID;
if (!spreadsheetId) throw new Error('GOOGLE_LEAGUE_DB_ID is not set');

const sheets = getSheets();

await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: "'Bot state'!A2:B2",
  valueInputOption: 'RAW',
  requestBody: { values: [['smoke_test', new Date().toISOString()]] },
});

const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: "'Bot state'!A1:B",
});

console.log(res.data.values);