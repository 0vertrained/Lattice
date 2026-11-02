const { chromium } = require('../../apps/control-center/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.LATTICE_VISITOR_URL || 'http://localhost:5173/';
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined, args:['--no-sandbox','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1080}, reducedMotion:'reduce'});
    const errors = [], calls = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {if(m.type()==='error' && /Encountered|Error:/.test(m.text()))errors.push(m.text());});
    page.on('request', r => {if(/\/api\//.test(r.url())) calls.push(r.url());});
    await page.goto(base);
    await page.getByRole('heading',{name:'Briefing',exact:true}).waitFor();
    const run = await (await page.request.get(new URL('demo/walkthrough.json',base).href)).json();
    assert.equal(run.outcome,'completed'); assert.equal(run.evidence.length,2); assert.equal(run.anomaly_count,1);
    assert(run.poses.length>200 && run.distance_m>10);
    for(const evidence of run.evidence){
      const response=await page.request.get(new URL('demo/'+evidence.image,base).href);
      assert(response.ok());
      assert.equal(require('node:crypto').createHash('sha256').update(await response.body()).digest('hex'),evidence.image_sha256);
    }
    const chapters=['Briefing','Recorded mission','Camera evidence','Restart recovery','Architecture'];
    for(const chapter of chapters){
      await page.getByRole('navigation',{name:'Walkthrough chapters'}).getByRole('button',{name:new RegExp(chapter)}).click();
      await page.getByRole('heading',{name:chapter,exact:true}).waitFor();
      await page.waitForFunction(()=>document.activeElement?.tagName==='H2');
      if(chapter==='Recorded mission'){
        await page.getByRole('slider',{name:'Recorded mission time'}).fill('42.2');
        await page.getByRole('button',{name:'Play replay',exact:true}).click();
        await page.getByRole('button',{name:'Pause replay',exact:true}).click();
        await page.getByRole('button',{name:'3D replay',exact:true}).click();
        await page.locator('canvas').waitFor();
        await page.getByRole('slider',{name:'Recorded mission time'}).fill('70');
        await page.getByRole('button',{name:'Map view',exact:true}).click();
      }
      if(process.env.LATTICE_CAPTURE) await page.screenshot({path:`/tmp/lattice-visitor-${chapter.replaceAll(' ','-')}.png`,fullPage:true});
    }
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:1000});
      for(const chapter of chapters){
        await page.getByRole('navigation',{name:'Walkthrough chapters'}).getByRole('button',{name:new RegExp(chapter)}).click();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`Overflow ${width} ${chapter}`);
      }
    }
    assert.deepEqual(errors,[]); assert.deepEqual(calls,[]);
    console.log('PASS: all walkthrough chapters, replay controls, focus, camera hashes, recorded outcomes, four viewport widths, no robot API requests');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
