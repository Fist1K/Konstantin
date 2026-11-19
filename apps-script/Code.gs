/**
 * Бэкенд бюджета: Google Apps Script, привязанный к Google-таблице.
 * Свойства скрипта (Project Settings → Script properties):
 *   TOKEN         — любой длинный секрет, его же вводите в приложении
 *   ANTHROPIC_KEY — ключ API Anthropic
 */
const SHEET_NAME = 'Транзакции';
const MODEL = 'claude-sonnet-5-5';
const EXPENSE_CATS = ['Продукты', 'Кафе и рестораны', 'Транспорт', 'Жильё и ЖКХ', 'Здоровье', 'Одежда',
  'Развлечения', 'Подписки', 'Связь и интернет', 'Путешествия', 'Образование', 'Переводы', 'Подарки', 'Прочее'];
const INCOME_CATS = ['Зарплата', 'Другие доходы'];
const HEADER = ['ID', 'Дата', 'Сумма', 'Тип', 'Категория', 'Описание', 'Добавлено'];

function doGet() {
  return json_({ ok: true, msg: 'Budget backend is running' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || req.token !== token) return json_({ ok: false, error: 'Неверный токен' });

    switch (req.action) {
      case 'list':
        return json_({ ok: true, rows: readRows_(), expense: EXPENSE_CATS, income: INCOME_CATS });
      case 'parse':
        return json_({ ok: true, rows: markDuplicates_(parseImage_(req.image, req.mediaType || 'image/jpeg')) });
      case 'add':
        return json_({ ok: true, added: addRows_(req.rows || []) });
      case 'delete':
        return json_({ ok: true, deleted: deleteRow_(req.id) });
      case 'ingest': // для Команд iOS: распознать и сразу записать
        const rows = markDuplicates_(parseImage_(req.image, req.mediaType || 'image/jpeg')).filter(r => !r.dup);
        return json_({ ok: true, added: addRows_(rows) });
      default:
        return json_({ ok: false, error: 'Неизвестное действие' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@'); // дата как текст YYYY-MM-DD
  }
  return sh;
}

function readRows_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 6).getValues().map(r => ({
    id: String(r[0]), date: dateStr_(r[1]), amount: Number(r[2]),
    type: r[3] === 'доход' ? 'income' : 'expense', category: String(r[4]), description: String(r[5]),
  })).filter(r => r.id);
}

function dateStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v);
}

function rowId_(r, n) {
  const raw = [r.date, Number(r.amount).toFixed(2), r.type, String(r.description).toLowerCase().trim(), n].join('|');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw)).slice(0, 16);
}

function markDuplicates_(rows) {
  const have = {};
  readRows_().forEach(r => have[r.id] = 1);
  return rows.map(r => Object.assign(r, { dup: !!have[r.id] }));
}

function addRows_(rows) {
  const sh = sheet_();
  const have = {};
  readRows_().forEach(r => have[r.id] = 1);
  const out = [];
  rows.forEach(r => {
    if (!r.id || have[r.id]) return;
    have[r.id] = 1;
    out.push([r.id, r.date, Number(r.amount), r.type === 'income' ? 'доход' : 'расход',
      r.category || 'Прочее', r.description || '', new Date()]);
  });
  if (out.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 2, out.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, out.length, HEADER.length).setValues(out);
  }
  return out.length;
}

function deleteRow_(id) {
  const sh = sheet_();
  const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = ids.length - 1; i >= 1; i--) {
    if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 1); return 1; }
  }
  return 0;
}

function parseImage_(b64, mediaType) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!key) throw new Error('Не задан ANTHROPIC_KEY');
  if (!b64) throw new Error('Нет изображения');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const prompt =
    'Это скриншот из банковского приложения со списком операций. Извлеки КАЖДУЮ операцию.\n' +
    'Верни ТОЛЬКО JSON-массив без пояснений и markdown. Элемент: ' +
    '{"date":"YYYY-MM-DD","amount":число>0,"type":"expense"|"income","category":строка,"description":строка}.\n' +
    'Правила:\n' +
    '- Сегодня ' + today + '. «Сегодня»/«Вчера» и даты без года приводи к полной дате (год — ближайший к сегодняшней дате, не в будущем).\n' +
    '- amount — модуль суммы, без знака и валюты. Десятичный разделитель — точка.\n' +
    '- Списания/покупки = expense, поступления/зарплата/возвраты = income. Перевод между своими счетами пропусти.\n' +
    '- Отменённые и неуспешные операции, а также баланс, кэшбэк-итоги и заголовки не включай.\n' +
    '- description — название мерчанта/получателя, коротко.\n' +
    '- category для expense строго из: ' + EXPENSE_CATS.join(', ') + '. Для income строго из: ' + INCOME_CATS.join(', ') + '.\n' +
    '- Если операций нет, верни [].';
  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: MODEL, max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: prompt }] }],
    }),
  });
  const body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) throw new Error('Anthropic: ' + (body.error && body.error.message || resp.getResponseCode()));
  const text = body.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const a = text.indexOf('['), z = text.lastIndexOf(']');
  if (a < 0 || z < a) throw new Error('ИИ вернул неожиданный ответ');
  const items = JSON.parse(text.slice(a, z + 1));
  const seen = {};
  return items.filter(r => r && r.date && Number(r.amount) > 0).map(r => {
    const type = r.type === 'income' ? 'income' : 'expense';
    const allowed = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const row = {
      date: String(r.date).slice(0, 10), amount: Math.round(Number(r.amount) * 100) / 100, type: type,
      category: allowed.indexOf(r.category) >= 0 ? r.category : (type === 'income' ? 'Другие доходы' : 'Прочее'),
      description: String(r.description || ''),
    };
    const base = rowId_(row, 0);
    const n = seen[base] = (seen[base] || 0) + 1;
    row.id = rowId_(row, n);
    return row;
  });
}
