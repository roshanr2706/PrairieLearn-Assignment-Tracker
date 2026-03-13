(function () {
  'use strict';

  if (!location.pathname.match(/\/pl\/course_instance\/\d+\/assessment_instance\/\d+\/?$/)) return;

  // Strip HTML to plain text, replacing <img> tags with [image]
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      img.replaceWith('[image]');
    }
    // Add spacing around block elements
    for (const el of doc.querySelectorAll('p, br, li, h1, h2, h3, h4, h5, h6')) {
      el.prepend('\n');
    }
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Fetch with concurrency limit
  async function fetchWithLimit(urls, limit, onProgress) {
    const results = new Array(urls.length);
    let index = 0;
    let done = 0;

    async function worker() {
      while (index < urls.length) {
        const i = index++;
        try {
          const res = await fetch(urls[i], { credentials: 'include' });
          results[i] = await res.text();
        } catch {
          results[i] = null;
        }
        done++;
        onProgress(done, urls.length);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, urls.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function parseQuestionPage(html) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Try the JSON blob first (active/unlocked questions)
    const dataEl = doc.querySelector('.question-data');
    if (dataEl) {
      try {
        const json = JSON.parse(decodeURIComponent(atob(dataEl.textContent.trim())));
        const params = json.variant?.params ?? {};
        const text = params.text ? htmlToText(params.text) : null;
        if (text) return { text, answers: Array.isArray(params.answers) ? params.answers : null };
      } catch {
        // fall through to DOM fallback
      }
    }

    // Fallback: scrape rendered HTML directly (locked/completed questions)
    const body = doc.querySelector('.question-body');
    if (body) {
      // Remove input elements so we don't capture form noise
      for (const el of body.querySelectorAll('input, button, .input-group')) el.remove();
      const text = htmlToText(body.innerHTML);
      return text ? { text, answers: null } : null;
    }

    return null;
  }

  function buildOutput(title, items) {
    const lines = [`=== ${title} ===`];
    let qNum = 0;

    for (const item of items) {
      if (item.type === 'group') {
        lines.push('', `[${item.name}]`);
      } else {
        qNum++;
        lines.push('');
        lines.push(`Q${qNum}. ${item.title}`);
        if (item.data?.text) {
          lines.push(item.data.text);
        } else {
          lines.push('[question content unavailable]');
        }
        if (item.data?.answers?.length) {
          lines.push('');
          for (const a of item.data.answers) {
            lines.push(`  ${a.key}) ${a.text}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  function injectButton() {
    const header = document.querySelector('.card-header.bg-primary');
    if (!header) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-light ms-auto';
    btn.textContent = 'Copy Questions';
    btn.style.flexShrink = '0';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.appendChild(btn);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Loading...';

      // Collect questions and groups from the table
      const table = document.querySelector('table[aria-label="Questions"]');
      if (!table) {
        btn.textContent = 'No questions found';
        btn.disabled = false;
        return;
      }

      const items = [];
      for (const row of table.querySelectorAll('tbody tr')) {
        const groupHeader = row.querySelector('th[colspan]');
        if (groupHeader) {
          items.push({ type: 'group', name: groupHeader.textContent.trim() });
          continue;
        }
        const link = row.querySelector('td a[href*="/instance_question/"]');
        if (!link) continue;
        const href = link.getAttribute('href');
        const url = href.startsWith('http') ? href : `${location.origin}${href}`;
        items.push({ type: 'question', title: link.textContent.trim(), url });
      }

      const questions = items.filter(i => i.type === 'question');
      const urls = questions.map(q => q.url);

      const htmlPages = await fetchWithLimit(urls, 5, (done, total) => {
        btn.textContent = `Copying... (${done}/${total})`;
      });

      questions.forEach((q, i) => {
        q.data = parseQuestionPage(htmlPages[i]);
      });

      const assessmentTitle = document.querySelector('.card-header.bg-primary h1')?.textContent.trim() ?? 'Assessment';
      const output = buildOutput(assessmentTitle, items);

      try {
        await navigator.clipboard.writeText(output);
        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Failed to copy';
      }

      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Copy Questions'; }, 2500);
    });
  }

  injectButton();
})();
