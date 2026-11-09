/** Read-only acceptance of the live catalog/activity APIs; destructive dialogs are cancelled. */
export const recordsActivityBrowserChecks = String.raw`
    {
      stage = 'Records and activity';
      await page.setViewportSize({width:1440,height:1100});
      await page.goto(origin + '/#settings');
      const section = page.locator('#settings-records');
      const toggle = section.locator('[data-settings-toggle]');
      await toggle.waitFor();
      assert(await toggle.getAttribute('aria-expanded')==='false','Records and activity should start collapsed');
      assert(await section.getByLabel('Find saved records').count()===0,'Collapsed record browser should not be mounted');
      await page.getByRole('navigation',{name:'Settings sections'}).getByRole('button',{name:'Records & activity',exact:true}).click();
      await wait('catalog loaded',()=>document.querySelector('#settings-records .saved-records') && !document.querySelector('#settings-records [role=status]'));
      assert(await section.locator('[role=alert]').count()===0,'Catalog request failed');
      assert(await toggle.getAttribute('aria-expanded')==='true','Settings index did not expand records');
      const rows = section.locator('.saved-record');
      if (await rows.count()) {
        const first = rows.first();
        await first.getByRole('button',{name:/^Details for /}).click();
        await first.locator('.record-data').waitFor();
        const json = first.getByText('Stored JSON',{exact:true}).locator('..');
        assert(!await json.evaluate(element=>element.open),'Stored JSON should start collapsed');
        await json.locator('summary').click();
        await page.setViewportSize({width:390,height:844});
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Record details overflow at phone width');
      }
      await section.getByLabel('Find saved records').fill('fieldwork-browser-check-no-match-384971');
      await section.getByText('No saved records match these filters.',{exact:true}).waitFor();
      await section.getByLabel('Record type').selectOption('application');
      await section.getByLabel('Sort records').selectOption('oldest');
      await section.getByRole('button',{name:'Activity',exact:true}).click();
      await wait('activity loaded',()=>document.querySelector('#settings-records .activity-selection') && !document.querySelector('#settings-records [role=status]'));
      assert(await section.locator('[role=alert]').count()===0,'Activity request failed');
      const entries = section.locator('.activity-entry');
      if (await entries.count()) {
        await entries.first().locator('summary').click();
        await section.getByRole('button',{name:'Select shown',exact:true}).click();
        await section.getByRole('button',{name:/^Delete selected /}).click();
        const dialog = page.getByRole('dialog',{name:'Delete selected activity'});
        await dialog.waitFor();
        await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
        assert(await page.getByRole('dialog',{name:'Delete selected activity'}).count()===0,'Activity cleanup did not cancel');
      }
      await page.setViewportSize({width:390,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Activity details overflow at phone width');
      await section.getByLabel('Activity level').selectOption('warning');
      await section.getByLabel('Find activity').fill('fieldwork-browser-check-no-match-384971');
      await section.getByText('No activity matches these filters.',{exact:true}).waitFor();
      await toggle.click();
      assert(await section.getByLabel('Find activity').count()===0,'Collapsed activity should be unmounted');
      report.checks.push({name:'Records and activity are lazy, searchable, filterable, expandable and narrow-screen safe; bulk cleanup cancels without a write',status:'passed'});
      await page.setViewportSize({width:1440,height:1100});
    }
`;
