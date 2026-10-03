import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {describeRejectedLogin,emailDiagnosticKey,rejectedLoginHint} from './login-diagnostics.mjs';

const password = 'Fz-TestGeneratedValue9';
const tag = crypto.createHash('sha256').update('club-order-password:'+password).digest('hex');
const describe = value => describeRejectedLogin({
  email:'fixture@example.test',password:value,activePasswordTags:[tag]
});
test('plain wrong password does not claim a formatting match',()=>{
  assert.equal(describe('Fz-AnotherWrongValue99').normalizationMatch,null);
});
test('edge whitespace is diagnosed only if the cleaned password matches the account tag',()=>{
  assert.equal(describe(' \u00a0'+password+'\n').normalizationMatch,'edge_whitespace');
  assert.equal(describe(' wrong ').normalizationMatch,null);
});
test('invisible characters and typographic dashes have distinct proven diagnoses',()=>{
  assert.equal(describe(password+'\u200B').normalizationMatch,'invisible_formatting');
  assert.equal(describe(password.replace('-','\u2011')).normalizationMatch,'typographic_dash');
});
test('combined paste formatting is diagnosed without modifying the input',()=>{
  const input = ' '+password.replace('-','\u2014')+'\u200B ';
  assert.equal(describe(input).normalizationMatch,'paste_formatting');
  assert.equal(input,' '+password.replace('-','\u2014')+'\u200B ');
});
test('output contains no email, password or stored authentication tag',()=>{
  const output = JSON.stringify(describe(password+'\u200B'));
  for (const sensitive of [password,tag,'fixture@example.test']) assert.ok(!output.includes(sensitive));
});
test('email diagnostic keys are private, deterministic and domain separated',()=>{
  const key = 'test-only-key';
  const a = emailDiagnosticKey('fixture@example.test',key);
  assert.equal(a,emailDiagnosticKey('fixture@example.test',key));
  assert.notEqual(a,emailDiagnosticKey('other@example.test',key));
  assert.notEqual(a,emailDiagnosticKey('fixture@example.test','other-key'));
  assert.match(a,/^[0-9a-f]{16}$/);
});
test('email shape hints never expose whether an account exists',()=>{
  const info = describeRejectedLogin({email:'f\u200Bixture@example.test',password:'wrong'});
  assert.equal(info.emailHasInvisibleFormatting,true);
  assert.ok(rejectedLoginHint(info).includes('email'));
  assert.equal(Object.hasOwn(info,'email'),false);
});