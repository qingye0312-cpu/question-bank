import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPermission,hasWordExportPermission} from '../desktop/shared/export-permission.ts';

test('permission helper rejects malformed lists and matches exact values',()=>{
 assert.equal(hasPermission(undefined,'export'),false);
 assert.equal(hasPermission(['export'],'export'),true);
 assert.equal(hasPermission(['export'],'upload'),false);
 assert.equal(hasPermission('export','export'),false);
});

test('Word export requires explicit approval and known authentication state',()=>{
 assert.equal(hasWordExportPermission(undefined),false);
 assert.equal(hasWordExportPermission({auth_type:'password',account_status:'pending',permissions:['export']}),false);
 assert.equal(hasWordExportPermission({auth_type:'password',account_status:'approved',permissions:['upload']}),false);
 assert.equal(hasWordExportPermission({auth_type:'password',account_status:'approved',permissions:['export']}),true);
 assert.equal(hasWordExportPermission({auth_type:'key',capabilities:['maintainer:manage']}),true);
 assert.equal(hasWordExportPermission({auth_type:'key',permissions:['export']}),false);
 assert.equal(hasWordExportPermission({auth_type:'password',account_status:'approved',capabilities:['maintainer:manage']}),false);
});
