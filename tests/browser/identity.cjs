const {chromium}=require('../../apps/control-center/node_modules/playwright');
(async()=>{
 const password=process.env.LATTICE_TEST_PASSWORD; if(!password) throw new Error('LATTICE_TEST_PASSWORD required');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox']});
 try{
  async function login(role){
   const context=await browser.newContext({viewport:{width:1440,height:1100}});const page=await context.newPage();let bearer='';
   page.on('request',r=>{if(r.url().endsWith('/api/v1/auth/me'))bearer=r.headers()['authorization']||'';});
   await page.goto('http://localhost:5173/operator.html');await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.locator('#username').fill(role);await page.locator('#password').fill(password);await page.locator('#kc-login').click();
   await page.getByRole('button',{name:'Sign out',exact:true}).waitFor({timeout:20000});
   if(!bearer)throw new Error('Missing verified identity request');
   if(page.url().includes('code='))throw new Error('Authorization code remains in URL');
   const stored=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
   if(stored.includes('access_token')||stored.includes('id_token'))throw new Error('Tokens persisted to web storage');
   return {context,page,bearer};
  }
  const admin=await login('admin');await admin.page.getByRole('heading',{name:'Robot identities'}).waitFor();
  await admin.page.getByRole('button',{name:'Issue robot credential',exact:true}).click();
  const secret=admin.page.getByLabel('New robot credential');await secret.waitFor();const token=await secret.inputValue();
  if(!token.startsWith('lattice_device_'))throw new Error('Credential not issued');
  const deviceHeaders={authorization:`Bearer ${token}`};
  const http=admin.page.request;
  const registration=await http.post('http://localhost:5173/api/v1/bodies/register',{headers:deviceHeaders,data:{id:'gazebo-rover',display_name:'Scoped test rover',kind:'rover',capabilities:['navigate','inspect'],adapter_version:'identity-test'}});
  if(registration.status()!==201)throw new Error(`Own registration: ${registration.status()}`);
  const spoof=await http.post('http://localhost:5173/api/v1/bodies/another-rover/heartbeat',{headers:deviceHeaders,data:{status:'online',battery:100,location:'warehouse',pose:null}});
  if(spoof.status()!==403)throw new Error(`Cross-body spoof: ${spoof.status()}`);
  const approve=await http.post('http://localhost:5173/api/v1/proposals',{headers:deviceHeaders,data:{title:'Forbidden operator action',command:{type:'inspect',location:'inspection_bay'}}});
  if(approve.status()!==403)throw new Error(`Device operator action: ${approve.status()}`);
  const headerBypass=await http.get('http://localhost:5173/api/v1/missions',{headers:{'x-lattice-api-key':'a'.repeat(32)}});
  if(headerBypass.status()!==401)throw new Error('Development authentication accepted in OIDC mode');
  await admin.page.getByRole('button',{name:'Hide credential',exact:true}).click();
  await admin.page.getByRole('button',{name:'Revoke Warehouse simulator',exact:true}).first().click();
  const revoked=await http.get('http://localhost:5173/api/v1/security/verification-key',{headers:deviceHeaders});
  if(revoked.status()!==401)throw new Error(`Revoked credential: ${revoked.status()}`);
  const viewer=await login('viewer');await viewer.page.getByRole('heading',{name:'Observe the fleet'}).waitFor();
  if(await viewer.page.getByRole('button',{name:'Review inspection round',exact:true}).count())throw new Error('Viewer sees approval action');
  const denied=await viewer.page.request.post('http://localhost:5173/api/v1/proposals',{headers:{authorization:viewer.bearer},data:{title:'Viewer cannot approve',command:{type:'inspect',location:'inspection_bay'}}});
  if(denied.status()!==403)throw new Error(`Viewer mutation: ${denied.status()}`);
  const adminDenied=await viewer.page.request.get('http://localhost:5173/api/v1/devices',{headers:{authorization:viewer.bearer}});
  if(adminDenied.status()!==403)throw new Error('Viewer can list credentials');
  await viewer.page.getByRole('button',{name:'Sign out',exact:true}).click();
  await viewer.page.getByRole('button',{name:'Sign in',exact:true}).waitFor({timeout:15000});
  const operator=await login('operator');await operator.page.getByRole('button',{name:'Review inspection round',exact:true}).waitFor();
  if(await operator.page.getByRole('heading',{name:'Robot identities'}).count())throw new Error('Operator sees administrator controls');
  await operator.page.setViewportSize({width:390,height:844});
  if(await operator.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw new Error('Operator mobile overflow');
  console.log('PASS: real Keycloak PKCE login/logout, admin/viewer/operator roles, memory-only tokens, one-body credential, cross-body and privilege rejection, immediate revocation, mobile layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1)});
