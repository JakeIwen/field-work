/** Inserted into the theme acceptance pass after opening the shared editor.
 * All theme previews are synchronous and restored; no settings are saved. */
export const themeSwatchBrowserChecks = String.raw`
    const swatchWrites = settingsWrites.length;
    const swatchParity = await page.evaluate(() => {
      const editor = document.querySelector('theme-editor');
      const adapter = editor.adapter;
      if (!adapter.swatchColors) throw new Error('Fieldwork must supply app-derived swatches');
      const tokens = ['--surface', '--sidebar-bg', '--surface-selected', '--primary', '--focus'];
      const root = document.documentElement;
      const originalMode = adapter.mode.get();
      const pageColors = () => JSON.stringify([...document.querySelectorAll('body, body *')].map(node => {
        const style = getComputedStyle(node);
        return [style.color, style.backgroundColor, style.borderColor, style.outlineColor, style.boxShadow];
      }));
      const originalStyle = root.getAttribute('style');
      const originalColors = pageColors();
      const themes = [...adapter.builtins, {
        id: 'swatch-check-rosewood-slate', name: 'Rosewood Slate',
        knobs: {hueNeutral: 360, hueBrand: 240, hueAccent: 70, chroma: 1.15},
      }];
      const checks = [];
      try {
        for (const mode of ['soft', 'dark']) {
          adapter.mode.set(mode);
          for (const theme of themes) {
            adapter.store.preview(theme.knobs);
            // These inherit the real active page's tokens, not the probe's
            // selector rules, so a missing probe rule cannot pass by accident.
            const oracle = document.createElement('div');
            oracle.hidden = true;
            const chips = tokens.map(token => {
              const chip = document.createElement('span');
              chip.style.backgroundColor = 'var(' + token + ')';
              oracle.append(chip);
              return chip;
            });
            let expected;
            try {
              document.body.append(oracle);
              expected = chips.map(chip => getComputedStyle(chip).backgroundColor);
            } finally { oracle.remove(); }
            const before = pageColors(), inline = root.getAttribute('style');
            const rootWrites = new MutationObserver(() => {});
            rootWrites.observe(root, {attributes: true});
            let actual;
            try {
              actual = adapter.swatchColors(theme.knobs, mode === 'dark');
              if (rootWrites.takeRecords().length) throw new Error('Swatches touched root attributes');
            } finally { rootWrites.disconnect(); }
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(mode + ' ' + theme.name + ' swatches differ from page: ' + JSON.stringify({actual, expected}));
            if (pageColors() !== before || root.getAttribute('style') !== inline) throw new Error('Swatches changed global page colors');
            if (document.querySelector('.theme-probe')) throw new Error('Swatch probe leaked');
            const row = editor.shadowRoot.querySelector('[data-action="pick"][data-id="' + theme.id + '"]');
            if (row) {
              const shown = [...row.querySelectorAll('.swatch span')].map(chip => getComputedStyle(chip).backgroundColor);
              if (JSON.stringify(shown) !== JSON.stringify(expected)) throw new Error(mode + ' ' + theme.name + ' rendered swatch differs from page');
            }
            checks.push({id: theme.id, mode, colors: actual});
          }
        }
      } finally {
        adapter.store.preview(null);
        adapter.mode.set(originalMode);
      }
      if (root.getAttribute('style') !== originalStyle || pageColors() !== originalColors) throw new Error('Swatch acceptance did not restore page colors');
      return checks;
    });
    assert(settingsWrites.length === swatchWrites, 'Swatch parity checks must not save settings');
    report.checks.push({name: 'App-derived swatches match actual page tokens for built-ins and Rosewood Slate in both modes without global color changes or settings writes', status: 'passed', themes: swatchParity});
`;
