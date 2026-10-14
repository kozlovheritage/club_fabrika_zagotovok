import crypto from 'node:crypto';

export const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
export class HistoryInputError extends Error {
  constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new HistoryInputError(code);};
const text=(value,max=200)=>String(value||'').trim().replace(/[\u0000-\u001f]/g,' ').slice(0,max);
export const tariffFor=value=>/расширенн/i.test(value)?'premium':/базов/i.test(value)?'basic':'unknown';
export function money(value){
  const raw=String(value).replace(/[\s\u00a0]/g,'');
  if(!/^\d{1,10}[.,]\d{2}$/.test(raw))fail('INVALID_AMOUNT');
  const [whole,fraction]=raw.split(/[.,]/);
  const result=Number(whole)*100+Number(fraction);
  if(!Number.isSafeInteger(result))fail('INVALID_AMOUNT');
  return result;
}
export function moscowDate(value){
  const raw=String(value);
  if(!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw))fail('INVALID_DATE');
  const time=Date.parse(raw.replace(' ','T')+'+03:00');
  if(!Number.isFinite(time)||new Date(time+10800000).toISOString().slice(0,19).replace('T',' ')!==raw)
    fail('INVALID_DATE');
  return new Date(time).toISOString();
}
// Semicolon CSV, BOM, quoted semicolons/newlines and escaped quotes.
// No third-party parser or customer data in diagnostics.
export function parseCsv(input){
  if(Buffer.byteLength(input)>10*1024*1024)fail('FILE_TOO_LARGE');
  const raw=String(input).replace(/^\uFEFF/,'');
  const result=[];let row=[],field='',quoted=false,closed=false;
  const endField=()=>{row.push(field);field='';closed=false;};
  const endRow=()=>{endField();if(row.some(Boolean))result.push(row);row=[];};
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(quoted){
      if(c==='"'&&raw[i+1]==='"'){field+='"';i++;}
      else if(c==='"'){quoted=false;closed=true;}
      else field+=c;
    }else if(c==='"'){
      if(field||closed)fail('INVALID_CSV_QUOTES');
      quoted=true;
    }else if(c===';')endField();
    else if(c==='\n'||c==='\r'){endRow();if(c==='\r'&&raw[i+1]==='\n')i++;}
    else {if(closed)fail('INVALID_CSV_QUOTES');field+=c;}
    if(result.length>20000)fail('TOO_MANY_ROWS');
  }
  if(quoted)fail('UNCLOSED_CSV_QUOTE');
  if(field||row.length||closed)endRow();
  const headers=result.shift();
  if(!headers||new Set(headers).size!==headers.length)fail('INVALID_HEADERS');
  // Prodamus omits trailing optional custom fields in older export rows.
  // Extra columns are invalid; missing tail cells are explicitly empty.
  if(result.some(r=>r.length>headers.length))fail('INVALID_ROW_WIDTH');
  return {headers,rows:result.map(r=>[...r,...Array(headers.length-r.length).fill('')])};
}
const paymentStatuses={
  'Выплачен':'settled','Получен':'received','Частично возвращен':'partially_refunded','Возвращен':'refunded'
};
const leadActions=new Set(['Выбран метод оплаты','Отказ в рассрочке','Заявка на рассрочку отменена','Рассрочка одобрена']);
export function normalizeExport(input,kind){
  const {headers,rows}=parseCsv(input);
  const required=['ID заказа','Номер заказа','Дата','E-mail','Метод оплаты','Сумма','Список товаров',
    kind==='payments'?'Статус':'Действие'];
  if(!['payments','leads'].includes(kind)||required.some(k=>!headers.includes(k)))fail('MISSING_REQUIRED_HEADERS');
  // paid_content, phones, extra data, signing URLs, signatures and credentials
  // deliberately never leave this parser's raw input.
  const index=Object.fromEntries(required.map(k=>[k,headers.indexOf(k)]));
  const get=(r,k)=>r[index[k]];
  const result=new Map();const counts={};
  let minDate=null,maxDate=null;
  for(const row of rows){
    const providerId=text(get(row,'ID заказа'),100);
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(providerId))fail('INVALID_PROVIDER_ID');
    const orderId=text(get(row,'Номер заказа'),200)||null;
    const occurredAt=moscowDate(get(row,'Дата'));
    minDate=!minDate||occurredAt<minDate?occurredAt:minDate;
    maxDate=!maxDate||occurredAt>maxDate?occurredAt:maxDate;
    const sourceStatus=text(get(row,kind==='payments'?'Статус':'Действие'));
    if(kind==='payments'?!paymentStatuses[sourceStatus]:!leadActions.has(sourceStatus))fail('UNKNOWN_SOURCE_STATUS');
    counts[sourceStatus]=(counts[sourceStatus]||0)+1;
    const record={
      kind:kind==='payments'?'payment':'lead',provider:'prodamus',provider_id:providerId,
      order_id:orderId,buyer_email:text(get(row,'E-mail'),254).toLowerCase()||null,
      amount_cents:money(get(row,'Сумма')),currency:'RUB',
      tariff:tariffFor(get(row,'Список товаров')),source_status:sourceStatus,
      status:kind==='payments'?paymentStatuses[sourceStatus]:'lead',
      occurred_at:occurredAt,source:'csv',payment_method:text(get(row,'Метод оплаты'),120),occurrences:1
    };
    if(kind==='payments'&&headers.includes('currency')&&row[headers.indexOf('currency')].toLowerCase()!=='rub')
      fail('UNSUPPORTED_CURRENCY');
    record.id=digest(kind==='payments'?'prodamus:'+providerId:JSON.stringify(record));
    record.record_key=kind==='payments'?'csv-payment:'+providerId+':'+record.status: 'csv-lead:'+record.id;
    if(result.has(record.id)){
      if(kind==='payments')fail('DUPLICATE_PAYMENT_ID');
      result.get(record.id).occurrences++;
    }else result.set(record.id,record);
  }
  return {records:[...result.values()],rows:rows.length,unique:result.size,duplicates:rows.length-result.size,
    statuses:counts,minDate,maxDate};
}
