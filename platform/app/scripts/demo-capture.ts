/** Playwright runs inside the existing isolated browser_clean service, never a launched browser. */
export function demoCaptureCode(origin: string, directory: string) {
  return `async (page) => {
    const origin = ${JSON.stringify(origin)};
    const directory = ${JSON.stringify(directory)};
    const outbound = [], errors = [], images = [];
    await page.unroute('**/*');
    await page.route('**/*', route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/')) {
        outbound.push(request.url()); return route.abort();
      }
      if (!['GET', 'HEAD'].includes(request.method())) return route.fulfill({json:{}});
      return route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width:1440,height:900});
    await page.goto(origin + '/#openings');
    await page.getByRole('heading', {name:'Openings',exact:true}).waitFor();
    await page.getByRole('combobox',{name:'Autofill support'}).selectOption({label:'All openings'});
    const pullSummary = page.locator('summary').filter({hasText:'Pull · Greenhouse'});
    if (await pullSummary.locator('..').getAttribute('open') !== null) await pullSummary.click();
    await page.getByRole('button',{name:'Soft',exact:true}).click();
    async function shot(name, top = false) {
      if (top) await page.evaluate(() => window.scrollTo(0,0));
      await page.mouse.move(0,0);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({path:directory + '/' + name + '.png',scale:'css',animations:'disabled'});
      images.push(name + '.png');
    }
    await shot('openings-list-desktop-soft');
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await shot('openings-list-desktop-dark');
    await page.getByRole('button',{name:'Soft',exact:true}).click();
    await page.goto(origin + '/#openings/demo-opening-1');
    await page.locator('.opening-research-details > summary').click({position:{x:30,y:10}});
    await shot('opening-detail-desktop-soft');
    await page.goto(origin + '/#applications');
    await page.getByRole('heading',{name:'Applications',exact:true}).waitFor();
    await shot('applications-desktop-soft',true);
    await page.goto(origin + '/#applications/demo-application-5');
    await page.getByText('Follow-up email',{exact:true}).first().waitFor();
    await page.getByRole('textbox',{name:'Subject',exact:true}).waitFor();
    await shot('application-follow-up-desktop-soft');
    await page.goto(origin + '/#openings');
    await page.getByRole('heading',{name:'Openings',exact:true}).waitFor();
    const summary = page.locator('summary').filter({hasText:'Pull · Greenhouse'});
    if (await summary.locator('..').getAttribute('open') === null) await summary.click();
    await shot('greenhouse-pull-desktop-soft',true);
    await page.goto(origin + '/#settings');
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await page.getByRole('button',{name:'Open theme editor',exact:true}).click();
    await page.getByRole('button',{name:'Save as new',exact:true}).waitFor();
    await shot('appearance-editor-desktop-dark');
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Soft',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await page.goto(origin + '/#openings');
    const phoneSummary = page.locator('summary').filter({hasText:'Pull · Greenhouse'});
    if (await phoneSummary.locator('..').getAttribute('open') !== null) await phoneSummary.click();
    await page.getByRole('combobox',{name:'Autofill support'}).selectOption({label:'All openings'});
    await shot('openings-list-phone-soft',true);
    await page.goto(origin + '/#openings/demo-opening-1');
    const research = page.locator('.opening-research-details');
    if (await research.getAttribute('open') === null) await research.locator('summary').click({position:{x:30,y:10}});
    await shot('opening-detail-phone-soft');
    if (errors.length || outbound.length) throw new Error(JSON.stringify({errors,outbound}));
    return {images,outbound,errors};
  }`;
}
