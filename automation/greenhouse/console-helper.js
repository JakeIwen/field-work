(async function fillGreenhouse(plan) {
  'use strict';
  // BEGIN GENERATED HELPER CONTRACT
  const helperContract = (() => {
    // platform/app/scripts/helper-contract.ts
    var maxAttachmentBytes = 8 * 1024 * 1024;
    function normalizeGreenhouseLabel(s) {
      return s.replace(/\*/g, "").replace(/\s+/g, " ").trim();
    }
    async function digest(bytes) {
      return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    function decodeBase64(value) {
      return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    }
    var hasPdfMagic = (bytes) => bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;
    var isSha256Hex = (value) => /^[a-f0-9]{64}$/.test(value);
    var isPdfMime = (value) => value === "application/pdf";
    var isPdfName = (value) => /\.pdf$/i.test(value);
    var withinAttachmentBytes = (size) => !(size > maxAttachmentBytes);
    function validGreenhouseAttachment(file) {
      return isPdfMime(file.mime) && isPdfName(file.name) && isSha256Hex(file.hash) && withinAttachmentBytes(file.size);
    }
    return { decodeBase64, digest, hasPdfMagic, normalize: normalizeGreenhouseLabel, validAttachment: validGreenhouseAttachment };
  })();
  // END GENERATED HELPER CONTRACT
  const url = new URL(plan.url);
  if (location.origin !== url.origin || location.pathname.replace(/\/$/, '') !== url.pathname) {
    throw new Error('Open the exact application URL before running this script: ' + plan.url);
  }
  if (url.pathname === '/embed/job_app') {
    const current = new URL(location.href);
    for (const key of ['for', 'token']) {
      if (url.searchParams.getAll(key).length !== 1 || current.searchParams.getAll(key).length !== 1 ||
          current.searchParams.get(key) !== url.searchParams.get(key)) {
        throw new Error('This is a different Greenhouse application. Open the exact form: ' + plan.url);
      }
    }
  }
  // Allow initial client hydration to settle when pasted just after navigation.
  await new Promise(resolve => setTimeout(resolve, 1000));
  const form = document.getElementById('application-form');
  if (!form) throw new Error('Application form is not loaded.');
  if (window.__fieldworkGreenhouseRunning) throw new Error('Autofill is already running.');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = helperContract.normalize;
  const label = e => normalize([...e.labels || []].map(l => l.textContent).join(' '));
  const selected = e => {
    if (e instanceof HTMLSelectElement) return e.value ? [...e.selectedOptions].map(o => normalize(o.textContent)) : [];
    const container = e.closest('.select__value-container');
    if (e.id === 'country' && container?.querySelector('.iti__us')) return 'United States +1';
    return container ? [...container.querySelectorAll('.select__single-value, .select__multi-value__label')].map(n => normalize(n.textContent)) : [];
  };
  const isSelect = e => e instanceof HTMLSelectElement || e.getAttribute('role') === 'combobox';
  const values = e => isSelect(e) ? [].concat(selected(e)).filter(Boolean)
    : ['checkbox', 'radio'].includes(e.type) ? (e.checked ? [e.value] : []) : [e.value.trim()].filter(Boolean);
  const matches = (e, value) => !!e && (['checkbox', 'radio'].includes(e.type) ? e.checked && label(e) === value : values(e).some(current => e.id === 'phone'
    ? current.replace(/\D/g, '') === value.replace(/\D/g, '')
    : current === value));
  const setText = (e, value) => {
    const prototype = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', {bubbles: true}));
    e.dispatchEvent(new Event('change', {bubbles: true}));
  };
  const uploadGroup = id => document.getElementById('upload-label-' + id)?.closest('.file-upload');
  const uploadLabel = group => normalize(group?.querySelector('.upload-label')?.textContent || '');
  const digest = helperContract.digest;
  for (const file of plan.attachments || []) {
    const group = uploadGroup(file.id), input = document.getElementById(file.id);
    if (!(['resume', 'cover_letter'].includes(file.id) || /^question_\d+$/.test(file.id)) || !group || !form.contains(group) || uploadLabel(group) !== file.label ||
        (input && input.type !== 'file') || !helperContract.validAttachment(file)) {
      throw new Error('Attachment field or document changed; inspect before continuing: ' + file.label);
    }
  }
  // Validate every mapping before changing anything. Never match questions fuzzily.
  for (const field of plan.fields) {
    const e = document.getElementById(field.id);
    if (!e && field.conditional) continue;
    if (!e || !form.contains(e) || label(e) !== field.label ||
        isSelect(e) !== (field.kind === 'select') ||
        (e instanceof HTMLTextAreaElement) !== (field.kind === 'textarea') ||
        (['checkbox', 'radio'].includes(field.kind) && (e.type !== field.kind || e.name !== field.groupName))) {
      throw new Error('Form changed; inspect this field before continuing: ' + field.label);
    }
  }
  window.__fieldworkGreenhouseRunning = true;
  const report = [];
  try {
    for (const field of plan.fields) {
      const displayLabel = field.questionLabel || field.label;
      let e = document.getElementById(field.id);
      if (!e && field.conditional) {
        for (let attempt = 0; attempt < 10 && !e; attempt++) {
          await pause(100);
          e = document.getElementById(field.id);
        }
      }
      if (!e || !form.contains(e) || label(e) !== field.label || isSelect(e) !== (field.kind === 'select')) {
        report.push({field: displayLabel, status: 'Field unavailable or changed; review manually'});
        continue;
      }
      if (field.groupName && [...form.querySelectorAll('input')].some(input => input.name === field.groupName && input.checked)) {
        report.push({field: displayLabel, status: matches(e, field.value) ? 'already filled' : 'existing answer preserved; review'});
        continue;
      }
      const current = values(e);
      if (current.length) {
        report.push({field: displayLabel, status: current.length === 1 && matches(e, field.value) ? 'already filled' : 'existing answer preserved; review'});
        continue;
      }
      try {
        if (e.disabled || e.readOnly) throw new Error('Field is disabled or read-only; review manually');
        if (['checkbox', 'radio'].includes(field.kind)) {
          e.click();
        } else if (field.kind === 'select' && e instanceof HTMLSelectElement) {
          const options = [...e.options].filter(o => normalize(o.textContent) === field.value && !o.disabled);
          if (options.length !== 1) throw new Error('Exact option not available; select manually');
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, options[0].value);
          e.dispatchEvent(new Event('input', {bubbles: true}));
          e.dispatchEvent(new Event('change', {bubbles: true}));
        } else if (field.kind === 'select') {
          // React Select requires a settled focus/open transition before input.
          e.blur();
          await pause(80);
          if (e.getAttribute('aria-expanded') !== 'true') {
            e.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
            e.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, button: 0}));
            e.click();
          }
          await pause(120);
          if (field.search) setText(e, field.search);
          let option;
          const deadline = Date.now() + 6000;
          do {
            const box = document.getElementById(e.getAttribute('aria-controls'));
            const matches = [...box?.querySelectorAll('[role="option"]') || []]
              .filter(n => normalize(n.textContent) === field.value && n.getAttribute('aria-disabled') !== 'true');
            if (matches.length === 1) { option = matches[0]; break; }
            await pause(100);
          } while (Date.now() < deadline);
          if (!option) throw new Error('Exact option not available; select manually');
          option.click();
        } else {
          setText(e, field.value);
        }
        await pause(120);
        e.blur();
        await pause(80);
        if (!matches(e, field.value)) throw new Error('Selection did not persist; review manually');
        report.push({field: displayLabel, status: 'filled'});
      } catch (error) {
        e.blur();
        report.push({field: displayLabel, status: error.message});
      }
    }
    await pause(200);
    // Recheck after all React updates, not just immediately after setting values.
    for (let i = 0; i < plan.fields.length; i++) {
      const field = plan.fields[i];
      const e = document.getElementById(field.id);
      // Late hydration can replace/reset the first text input. Retry once on the
      // current element only if it is still empty and its label/type still match.
      // Never overwrite a nonempty answer or retry a dropdown selection blindly.
      if (e && ['text', 'textarea'].includes(field.kind) && !isSelect(e) &&
          (e instanceof HTMLTextAreaElement) === (field.kind === 'textarea') &&
          !e.disabled && !e.readOnly && label(e) === field.label && !values(e).length &&
          ['filled', 'Selection did not persist; review manually'].includes(report[i].status)) {
        setText(e, field.value);
        await pause(120);
        e.blur();
        await pause(120);
        if (matches(document.getElementById(field.id), field.value)) report[i].status = 'filled';
      }
      if (['filled', 'already filled'].includes(report[i].status) &&
          !matches(document.getElementById(field.id), field.value)) {
        report[i].status = 'value changed after filling; review';
      }
    }
    const attachmentReport = [];
    const attached = window.__fieldworkAttachedDocuments ||= {};
    for (const file of plan.attachments || []) {
      const group = uploadGroup(file.id);
      let input = document.getElementById(file.id);
      const visibleName = () => (group?.innerText || '').split('\n').map(s => s.trim()).find(s => /\.(pdf|docx?|txt|rtf)$/i.test(s));
      const manual = document.getElementById(file.id + '_text');
      try {
        const existingError = group?.querySelector('[role="alert"], .error-message, .file-upload__error');
        if (existingError?.textContent?.trim()) throw new Error(existingError.textContent.trim());
        if (input?.files?.length || visibleName() || manual?.value?.trim()) {
          let same = attached[file.id]?.hash === file.hash && (group.innerText || '').includes(file.name);
          if (input?.files?.length === 1 && input.files[0].name === file.name && (group.innerText || '').includes(file.name)) same = await digest(await input.files[0].arrayBuffer()) === file.hash;
          attachmentReport.push({id: file.id, field: file.label, name: file.name, status: same ? 'already attached' : 'existing attachment preserved; review'});
          continue;
        }
        if (!input || input.disabled) throw new Error('Upload control unavailable; attach manually');
        console.log('Attaching ' + file.label + ': ' + file.name);
        const bytes = helperContract.decodeBase64(file.base64);
        if (bytes.length !== file.size || await digest(bytes) !== file.hash || !helperContract.hasPdfMagic(bytes)) throw new Error('Document integrity check failed');
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], file.name, {type: file.mime}));
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        const deadline = Date.now() + 20000;
        let acceptedSince = 0;
        while (Date.now() < deadline) {
          const currentGroup = uploadGroup(file.id);
          const error = currentGroup?.querySelector('[role="alert"], .error-message, .file-upload__error');
          if (error?.textContent?.trim()) throw new Error(error.textContent.trim());
          const accepted = (currentGroup?.innerText || '').includes(file.name) && !currentGroup?.querySelector('[aria-busy="true"], [role="progressbar"]');
          if (accepted) {
            acceptedSince ||= Date.now();
            if (Date.now() - acceptedSince >= 1000) break;
          } else acceptedSince = 0;
          await pause(150);
        }
        if (!acceptedSince || Date.now() - acceptedSince < 1000) throw new Error('The form did not confirm the filename; inspect the upload field');
        attached[file.id] = {hash: file.hash, name: file.name};
        attachmentReport.push({id: file.id, field: file.label, name: file.name, status: 'attached to form'});
      } catch (error) {
        attachmentReport.push({id: file.id, field: file.label, name: file.name, status: error.message});
      }
    }
    const attachmentSatisfied = id => attachmentReport.some(a => a.id === id && ['attached to form', 'already attached', 'existing attachment preserved; review'].includes(a.status));
    const groupedIds = new Set((plan.controlGroups || []).flatMap(g => g.ids));
    const missingRequired = [...form.querySelectorAll('input[id], textarea[id], select[id]')]
      .filter(e => !groupedIds.has(e.id))
      .filter(e => e.getAttribute('aria-required') === 'true' || e.required)
      .filter(e => e.type === 'file' ? !e.files.length && !attachmentSatisfied(e.id) : e.type === 'radio'
        ? ![...form.querySelectorAll('input[type="radio"]')].some(r => r.name === e.name && r.checked)
        : !values(e).length)
      .map(e => label(e) || e.id);
    for (const group of plan.controlGroups || []) {
      if (group.required && !group.ids.some(id => document.getElementById(id)?.checked)) missingRequired.push(group.label);
    }
    for (const field of plan.requiredFields || []) {
      const e = document.getElementById(field.id);
      if (!e || !values(e).length) missingRequired.push(field.label);
    }
    // Greenhouse does not mark its resume file input required in the DOM.
    const resume = document.getElementById('resume');
    if (resume && !resume.files.length && !attachmentSatisfied('resume') && (!plan.requiredFields || plan.review.some(r => r.label === 'Resume/CV' && r.required))) missingRequired.push('Resume/CV: attach or verify manually entered resume');
    for (const a of attachmentReport) if (!['attached to form', 'already attached', 'existing attachment preserved; review'].includes(a.status)) missingRequired.push(a.field + ': attachment needs attention');
    console.table(report);
    if (attachmentReport.length) console.table(attachmentReport);
    console.log('Review remaining required fields:', [...new Set(missingRequired)]);
    console.log('Optional fields left for your review:', plan.review);
    console.log('Autofill finished. Review all answers and attachments, then submit the form yourself. Nothing was submitted by this script.');
    return {report, attachments: attachmentReport, missingRequired: [...new Set(missingRequired)], review: plan.review, submitted: false};
  } finally {
    delete window.__fieldworkGreenhouseRunning;
  }
})
