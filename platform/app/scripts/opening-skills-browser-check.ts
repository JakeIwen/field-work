/** Deterministic layout checks without writing personal data or opening a posting. */
export const openingSkillsBrowserChecks = String.raw`
    {
      const viewport = page.viewportSize();
      const original = await page.evaluate(() => ({sort:localStorage.getItem('fieldwork.openings.sort.v2'),theme:localStorage.getItem('fieldwork.theme')}));
      const requirements = 'C, C++, Clojure, CSS, Dart, Django, Docker, Elixir, Erlang, Flask, Go, GraphQL, Haskell, HTML, Java, JavaScript, Julia, Kotlin, Kubernetes, Lua, MongoDB, MySQL, Next.js, Node.js, OCaml, Perl, PHP, PostgreSQL, Python, R, React, Redis, Ruby, Rust, Scala, SQL, SQLite, Svelte, Swift, Tailwind, Terraform, TypeScript, Vue, WebAssembly, Zig';
      const openings = [['dense',requirements],['full','React'],['half','React, JS, Java, Docker'],['none','Collaborating on product decisions']].map(([id,requirements]) => ({
        ...state.openings[0], id:'skills-'+id, company:'Skills fixture '+id, title:'Engineer', requirements,
        url:'https://job-boards.greenhouse.io/fixture/jobs/'+id, postingStatus:'open', validation:undefined, skills:undefined, skillsSourceHash:undefined, technical_fit:'Uncertain', wlb_outlook:'Uncertain',
      }));
      openings.push({...openings[0], id:'skills-classified', company:'Skills fixture classified', hash:'skills-classified-hash', skillsSourceHash:'skills-classified-hash',
        requirements:'React, Java, Go, JS, Python, Rust, AWS, Docker, TS', skills:{required:['React','Java'],anyOf:[['Go','JS'],['Python','Rust']],preferred:['AWS','Docker','TS']}});
      const fixture = {...state, openings, knownSkills:['AWS','JS','React'], applications:[], personal:{}, openingGenerationCounts:{}, openingAutofillFinishCounts:{}, preparations:[], savedFilters:[]};
      const fixtureRoute = route => route.fulfill({json:fixture});
      await page.route('**/api/state', fixtureRoute);
      try {
        await page.goto(origin + '/#openings');
        await page.reload();
        await page.getByLabel('Autofill support',{exact:true}).selectOption('all');
        const rows = page.locator('tr[data-opening-id]');
        await page.getByLabel('Sort opportunities').selectOption('company');
        const dense = page.locator('tr[data-opening-id="skills-dense"] .opening-skill-chips');
        await dense.waitFor();
        const known = await dense.locator(':scope > .skill-known').allTextContents();
        assert(JSON.stringify(known)===JSON.stringify(['AWS','JS','React']),'Known skills must come first alphabetically');
        assert(await dense.getAttribute('title')==='3 of 46 skills on your resume','Resume match summary');
        const classified = page.locator('tr[data-opening-id="skills-classified"] .opening-skill-chips');
        const classifiedChips = classified.locator(':scope > .skill-chip');
        assert(JSON.stringify(await classifiedChips.allTextContents())===JSON.stringify(['Go / JS','React','Java','Python / Rust','AWS','Docker','TS']),'Required singles and groups must mix alphabetically, known first, before nice-to-have chips');
        assert(JSON.stringify(await classified.locator(':scope > .skill-preferred').allTextContents())===JSON.stringify(['AWS','Docker','TS']),'Preferred chips need the dimmed class');
        assert(await classified.getAttribute('title')==='2 of 4 required skills on your resume · 3 nice to have' && await classified.getAttribute('aria-label')===await classified.getAttribute('title'),'Groups count once in the required-skill summary');
        const groups = classified.locator(':scope > .skill-group');
        assert(JSON.stringify(await groups.allTextContents())===JSON.stringify(['Go / JS','Python / Rust']),'Each any-of group renders as one chip');
        assert(await groups.nth(0).getAttribute('title')==='Any one of these · on your resume' && await groups.nth(0).evaluate(e=>e.classList.contains('skill-known')&&!e.classList.contains('skill-preferred')),'Any known group member satisfies and outlines the group');
        assert(await groups.nth(1).getAttribute('title')==='Any one of these' && await groups.nth(1).evaluate(e=>!e.classList.contains('skill-known')&&!e.classList.contains('skill-preferred')),'An unknown group remains required but unmatched');
        assert(JSON.stringify(await classified.locator('.skill-chip-measure > .skill-group').allTextContents())===JSON.stringify(await groups.allTextContents()),'Measuring row retains group labels');
        assert(await classifiedChips.nth(4).getAttribute('title')==='Nice to have · on your resume' && await classifiedChips.nth(4).evaluate(e=>e.classList.contains('skill-known')),'Known preferred chip keeps its border and tooltip');
        assert(await classifiedChips.nth(5).getAttribute('title')==='Nice to have','Preferred chip tooltip');
        const order = () => rows.evaluateAll(elements=>elements.map(e=>e.dataset.openingId));
        assert(await page.getByRole('button',{name:/^Skills\./}).getAttribute('title')==='Cycle sorting: % of required posting skills on your resume → number matched. Each any-of group counts once and is met by any member. Nice-to-have skills are dimmed and not counted. Openings with no recognized required skills stay last.','Skills sort help explains any-of satisfaction');
        await page.getByRole('button',{name:/^Skills\./}).click();
        assert(JSON.stringify(await order())===JSON.stringify(['skills-full','skills-classified','skills-half','skills-dense','skills-none']),'Skills percent sort counts each satisfied group once and ignores nice-to-have matches');
        await page.getByRole('button',{name:/^Skills\./}).click();
        assert(JSON.stringify(await order())===JSON.stringify(['skills-dense','skills-classified','skills-half','skills-full','skills-none']),'Skills count sort counts each satisfied group once and ignores nice-to-have matches');
        for (const theme of ['Soft','Dark']) {
          await page.setViewportSize({width:1440,height:1000});
          await classifiedChips.nth(4).waitFor();
          await page.getByRole('button',{name:theme,exact:true}).click();
          const preferredStyle = await classifiedChips.nth(4).evaluate(element => ({color:getComputedStyle(element).color,muted:getComputedStyle(document.querySelector('.muted')).color,border:getComputedStyle(element).borderColor,knownBorder:getComputedStyle(element.parentElement.querySelector(':scope > .skill-known:not(.skill-preferred)')).borderColor}));
          const separatorStyle = await groups.nth(0).locator('.skill-or').evaluate(element => ({color:getComputedStyle(element).color,muted:getComputedStyle(document.querySelector('.muted')).color}));
          assert(separatorStyle.color===separatorStyle.muted,'Any-of separator uses the dim text token in '+theme);
          assert(preferredStyle.color===preferredStyle.muted,'Nice-to-have text uses the dim text token in '+theme);
          assert(preferredStyle.border===preferredStyle.knownBorder,'Nice-to-have resume matches keep the known-skill border in '+theme);
          for (const target of [850,1100,1500,830]) {
            await page.setViewportSize({width:target+288,height:1000});
            for(let i=0;i<2;i++) {
              const width=await page.locator('.openings-table').evaluate(e=>e.getBoundingClientRect().width);
              if(Math.abs(width-target)<1)break;
              await page.setViewportSize({width:Math.round(page.viewportSize().width+target-width),height:1000});
            }
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
            const dimensions = await dense.evaluate(element => {
              const chips=[...element.querySelectorAll(':scope > .skill-chip, :scope > .skill-overflow-line > .skill-chip')];
              const overflow=element.querySelector('.skill-overflow');
              const fit=element.closest('tr').querySelector('.opening-fit-cell');
              const header=document.querySelector('th.opening-skills-col');
              return {rows:new Set(chips.map(e=>e.getBoundingClientRect().top)).size, hidden:getComputedStyle(header).display==='none',fitWidth:fit.getBoundingClientRect().width, wrapped:[...fit.querySelectorAll('.fit-mini')].some(e=>e.getBoundingClientRect().height>parseFloat(getComputedStyle(e).lineHeight)+1),overflow:overflow?.getAttribute('title'),last:chips.at(-1)?.textContent,disclosure:overflow?.getAttribute('aria-label')};
            });
            assert(Math.abs(dimensions.fitWidth-144)<1,'Fit column changed width at '+target);
            assert(!dimensions.wrapped,'Uncertain assessment wraps at '+target);
            assert(dimensions.hidden===(target<845),'Skills visibility threshold at '+target);
            if(!dimensions.hidden) {
              assert(dimensions.rows<=7,'More than seven skill rows');
              if(target===850)assert(dimensions.rows===7 && dimensions.last==='…' && dimensions.overflow===dimensions.disclosure && dimensions.overflow.includes('Windows'),'Overflow chip must end row seven and name hidden skills: '+JSON.stringify(dimensions));
            }
          }
        }
        report.checks.push({name:'Required singles and any-of groups, dimmed nice-to-have skills, group-aware percent/count sorting, seven-row overflow and responsive fixed columns in both themes',status:'passed'});
      } finally {
        await page.unroute('**/api/state', fixtureRoute);
        await page.evaluate(original=>{for(const [key,value] of [['fieldwork.openings.sort.v2',original.sort],['fieldwork.theme',original.theme]]){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}},original);
        await page.setViewportSize(viewport);
        await page.goto(origin + '/#openings');
        await page.reload();
      }
    }
`;
