import pg from 'pg';
import {provisionOwner} from './admin-store.mjs';

// Run ONLY in the explicitly approved target environment after schema migration.
// Values belong in the private operator environment, never CLI args or Git.
if(process.env.CLUB_ADMIN_PROVISION_CONFIRMED!=='true')throw new Error('Target database confirmation required');
if(!process.env.DATABASE_URL||!process.env.PUBLIC_URL||
  process.env.CLUB_ADMIN_PROVISION_TARGET_URL!==process.env.PUBLIC_URL)
  throw new Error('Explicit target URL confirmation required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false}});
try{
  await provisionOwner(pool,{
    email:process.env.CLUB_ADMIN_TARGET_EMAIL,
    expectedName:process.env.CLUB_ADMIN_EXPECTED_NAME,
    displayName:process.env.CLUB_ADMIN_DISPLAY_NAME
  });
  console.log('OWNER_PROFILE_AND_ROLE_UPDATED');
}catch{
  console.error('OWNER_PROVISION_FAILED_NO_CHANGES');process.exitCode=1;
}finally{await pool.end();}
