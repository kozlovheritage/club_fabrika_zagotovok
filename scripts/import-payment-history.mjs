import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {normalizeExport} from '../history-csv.mjs';
import {HISTORY_SCHEMA,createPaymentHistory} from '../payment-history.mjs';

// Operator-only command. Default is validation/dry run without any DB access.
// Never runs on startup and never accepts or forwards access credentials.
async function main(){
  const args=process.argv.slice(2);
  const paths=args.filter(x=>!x.startsWith('--'));
  if(paths.length!==2)throw new Error('TWO_CSV_PATHS_REQUIRED');
  const [payments,leads]=await Promise.all(paths.map(async(path,i)=>
    normalizeExport(await readFile(path,'utf8'),i===0?'payments':'leads')));
  const report={paymentRows:payments.rows,leadRows:leads.rows,uniqueLeads:leads.unique,
    duplicateLeadRows:leads.duplicates,paymentStatuses:payments.statuses,
    minDate:payments.minDate,maxDate:payments.maxDate,credentialsExcluded:true};
  if(!args.includes('--apply')){console.log(JSON.stringify({dryRun:true,...report}));return;}
  // Explicit expected counts protect against selecting the wrong private files.
  if(!args.includes('--expect-payments='+payments.rows)||!args.includes('--expect-leads='+leads.rows))
    throw new Error('EXPECTED_ROW_COUNTS_REQUIRED');
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_NOT_CONFIGURED');
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
    ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false},max:2});
  try{
    for(const sql of HISTORY_SCHEMA)await pool.query(sql);
    const result=await createPaymentHistory(pool).importExports(payments,leads);
    console.log(JSON.stringify({imported:true,...report,...result}));
  }finally{await pool.end();}
}
main().catch(error=>{
  // Do not serialize raw SQL/provider errors or row values.
  const code=/^[A-Z_]+$/.test(error.code||error.message||'')?(error.code||error.message):'HISTORY_IMPORT_FAILED';
  console.error(JSON.stringify({error:code}));process.exitCode=1;
});
