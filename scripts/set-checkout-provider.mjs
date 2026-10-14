import pg from 'pg';
import {createAdminStore} from '../admin-store.mjs';
import {readCloudConfig,receiptInstructions} from '../cloudpayments.mjs';

// Operator-only command. No HTTP switching endpoint and no health-check switching.
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const target=arg('--to'),expected=arg('--expected');
if(!process.argv.includes('--confirm-manual-switch')||
  !['prodamus','cloudpayments'].includes(target)||!['prodamus','cloudpayments'].includes(expected)){
  console.error('Usage: node scripts/set-checkout-provider.mjs --to PROVIDER --expected CURRENT --confirm-manual-switch');
  process.exit(2);
}
if(target==='cloudpayments'){
  const config=readCloudConfig();
  if(!config.enabled||config.test||!config.publicId||!config.secret||!config.terminalConfirmed||!config.receiptApproved||!config.receiptProvider||
    process.env.AUTH_EMAIL_PROVIDER!=='notisend'||!process.env.NOTISEND_API_KEY||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(process.env.AUTH_FROM_EMAIL||'')||
    (process.env.AUTH_CREDENTIAL_KEY||'').length<32){
    console.error('CloudPayments readiness settings are incomplete. Nothing changed.');
    process.exit(2);
  }
  receiptInstructions({customer_email:'readiness@example.invalid',products:[{price:'1.00',name:'Readiness check'}]},config);
}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:true}});
try{
  const result=await createAdminStore(pool).setCheckoutProvider(target,expected);
  console.log(JSON.stringify(result));
}catch{
  console.error('Switch rejected. Check readiness, current provider and database access. Nothing was automatically retried.');
  process.exitCode=1;
}finally{await pool.end();}
