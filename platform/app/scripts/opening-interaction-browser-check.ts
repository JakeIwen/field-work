import { FIELDWORK_TIMEZONE } from "../shared/timezone.js";

/** Fixture-backed list checks in browser_clean; all workflow data stays read-only. */
export const openingInteractionBrowserChecks = String.raw`
    {
      // Age filters count Fieldwork's calendar days, not the machine's: count back from today in that zone.
      const [year, month, day] = new Intl.DateTimeFormat('en-CA',{timeZone:${JSON.stringify(FIELDWORK_TIMEZONE)}}).format(new Date()).split('-').map(Number);
      const date = days => new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
      const openings = ['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot'].map((company,i) => ({
        ...state.openings[0], id: 'interaction-' + i, company, title: 'Engineer',
        url: i === 5 ? 'https://example.test/job' : 'https://job-boards.greenhouse.io/fixture/jobs/' + (100+i),
        postingStatus: 'open', validation: undefined,
        createdAt: date(i * 3), first_published: i === 4 ? null : date(i * 3 + 1),
      }));
      const fixture = {...state, openings, applications: [], personal: {}, openingGenerationCounts: {}, savedFilters: [
        {id:'legacy-all',name:'Legacy all',filters:{autofillEligible:false}},
        {id:'legacy-supported',name:'Legacy supported',filters:{autofillEligible:true}},
      ]};
      const fixtureRoute = route => route.fulfill({json:fixture});
      await page.route('**/api/state', fixtureRoute);
      try {
        await page.goto(origin + '/#openings');
        await page.reload();
        const rows = page.locator('tr[data-opening-id]');
        await wait('fixture openings',()=>document.querySelectorAll('tr[data-opening-id]').length===5);
        const support = page.getByRole('combobox',{name:'Autofill support',exact:true});
        await support.selectOption('unsupported');
        assert(await rows.count()===1 && (await rows.first().innerText()).includes('Foxtrot'),'Non-Greenhouse filter');
        await support.selectOption('all');
        assert(await rows.count()===6,'All openings filter');
        await page.getByLabel('Load saved filter').selectOption('legacy-supported');
        assert(await rows.count()===5,'Legacy supported saved filter');
        await page.getByLabel('Load saved filter').selectOption('legacy-all');
        assert(await rows.count()===6,'Legacy all saved filter');
        await page.getByLabel('Sort opportunities').selectOption('company');
        const boxes = rows.locator('input[type=checkbox]');
        await boxes.nth(1).click();
        await boxes.nth(4).click({modifiers:['Shift']});
        assert(await rows.locator('input:checked').count()===4,'Forward Shift-click range');
        await boxes.nth(4).click();
        await boxes.nth(1).click({modifiers:['Shift']});
        assert(await rows.locator('input:checked').count()===0,'Backward Shift-click deselection');
        await page.getByLabel('Sort opportunities').selectOption('company-desc');
        await boxes.nth(0).click();
        await boxes.nth(2).click({modifiers:['Shift']});
        assert(await rows.locator('input:checked').count()===3,'Range follows visible sort');
        await boxes.nth(0).focus();
        await page.keyboard.press('ArrowDown');
        assert(await boxes.nth(1).evaluate(el=>el===document.activeElement),'Arrow moves checkbox focus');
        await page.keyboard.press('ArrowUp');
        assert(await boxes.nth(0).evaluate(el=>el===document.activeElement),'Arrow moves back');
        await rows.first().locator('a.table-role').focus();
        await page.keyboard.press('ArrowDown');
        assert(await rows.nth(1).locator('a.table-role').evaluate(el=>el===document.activeElement),'Arrow moves link focus');
        await page.keyboard.press('Enter');
        assert(page.url().endsWith('/interaction-4'),'Enter opens focused row');
        await page.keyboard.press('Escape');
        const search=page.getByPlaceholder('Search company, role, or technology…');
        await search.fill('Alpha');
        await page.keyboard.press('ArrowDown');
        assert(await search.evaluate(el=>el===document.activeElement),'Arrows preserve search input');
        await boxes.nth(0).click({modifiers:['Shift']});
        assert(await rows.locator('input:checked').count()===1,'Filtered-out anchor falls back to one checkbox');
        await search.fill('');
        await page.locator('.opening-filters > summary').click();
        await page.getByLabel('Age date',{exact:true}).selectOption('added');
        await page.getByRole('combobox',{name:'Opening age',exact:true}).selectOption('older');
        await page.getByLabel('Age in days').fill('6');
        assert(await rows.count()===3,'Older Added date excludes exact boundary');
        await page.getByRole('combobox',{name:'Opening age',exact:true}).selectOption('newer');
        assert(await rows.count()===2,'Newer Added date excludes exact boundary');
        await page.getByLabel('Age date',{exact:true}).selectOption('published');
        await page.getByRole('combobox',{name:'Opening age',exact:true}).selectOption('older');
        assert(await rows.count()===3,'Published age excludes unknown publication');
        report.checks.push({name:'Opening support and age filters, saved-filter compatibility, Shift-click ranges, arrow focus and Enter navigation',status:'passed'});
      } finally {
        await page.unroute('**/api/state', fixtureRoute);
        await page.goto(origin + '/#openings');
        await page.reload();
      }
    }
`;
