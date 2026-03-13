(function () {
  'use strict';

  const courseInstanceId = location.pathname.match(/\/course_instance\/(\d+)\//)?.[1];
  if (!courseInstanceId) return;
  if (!location.pathname.includes('/gradebook')) return;

  const STORAGE_KEY = `pl.calculator.${courseInstanceId}`;
  const COURSE_KEY = `pl.course.${courseInstanceId}`;

  // Inject CSS for gradebook integration
  const style = document.createElement('style');
  style.textContent = `
    .plgc-excluded { opacity: 0.35; }
    .plgc-excluded td { text-decoration: line-through; }
    .plgc-badge-toggle { cursor: pointer; user-select: none; }
    .plgc-badge-toggle:hover { filter: brightness(0.85); }
    .plgc-missing-row td { font-style: italic; color: #6c757d; }
    .plgc-section-controls { display: inline-flex; align-items: center; gap: 0.5rem; margin-left: 0.5rem; font-size: 0.75rem; font-weight: normal; }
    .plgc-section-controls input[type="number"] { width: 60px; }
    .plgc-section-controls label { margin-bottom: 0; font-weight: normal; white-space: nowrap; }
  `;
  document.head.appendChild(style);

  //     DOM Parsing

  function parseGradebook() {
    const table = document.querySelector('table[aria-label="Gradebook"]');
    if (!table) return [];

    const sections = [];
    let currentSection = null;

    for (const row of table.querySelectorAll('tbody tr')) {
      const header = row.querySelector('th[colspan]');
      if (header) {
        currentSection = { name: header.textContent.trim(), assignments: [] };
        sections.push(currentSection);
        continue;
      }

      if (!currentSection) continue;

      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;

      const badge = cells[0].querySelector('span.badge')?.textContent.trim() ?? '';

      // Title: get text nodes only (strip icon elements)
      const titleCell = cells[1];
      let title = '';
      for (const node of titleCell.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) title += node.textContent;
      }
      title = title.trim();
      if (!title) title = titleCell.textContent.trim();

      // Score: parse width from the progress bar's style
      const bar = cells[2].querySelector('.progress-bar');
      let score = 0;
      if (bar) {
        const match = bar.style.width.match(/([\d.]+)%/);
        score = match ? parseFloat(match[1]) : 0;
      }

      const unfinished = score === 0;

      currentSection.assignments.push({ badge, title, score, unfinished });
    }

    return sections;
  }

  // Compute missing assignments (in course storage but not in gradebook)
  function computeMissing(courseSnapshot, sections) {
    if (!courseSnapshot || !Array.isArray(courseSnapshot.assessments)) return {};

    const existingKeys = new Set();
    sections.forEach(s => {
      s.assignments.forEach(a => {
        existingKeys.add(`${a.badge.toLowerCase()}|${a.title.toLowerCase()}`);
      });
    });

    const missingBySection = {};
    const seen = new Set();
    courseSnapshot.assessments.forEach(a => {
      const normKey = `${(a.badge || '').toLowerCase()}|${(a.title || '').toLowerCase()}`;
      if (existingKeys.has(normKey) || seen.has(normKey)) return;
      seen.add(normKey);

      const group = a.group || 'Other';
      if (!missingBySection[group]) missingBySection[group] = [];
      missingBySection[group].push({
        badge: a.badge || '',
        title: a.title || '',
        score: 0,
        unfinished: true,
        isMissing: true,
      });
    });

    return missingBySection;
  }

  // Build combined sections (gradebook + missing + custom) for calculation
  function buildAllSections(sections, missingBySection, customSections) {
    const allSections = sections.map(s => ({
      name: s.name,
      assignments: [...s.assignments],
    }));

    Object.entries(missingBySection).forEach(([sectionName, missing]) => {
      const existing = allSections.find(s => s.name === sectionName);
      if (existing) {
        existing.assignments.push(...missing);
      } else {
        allSections.push({ name: sectionName, assignments: [...missing] });
      }
    });

    // Append custom sections as single-assignment sections
    if (Array.isArray(customSections)) {
      customSections.forEach(cs => {
        if (!cs.name) return;
        allSections.push({
          name: cs.name,
          isCustom: true,
          assignments: [{
            badge: '★',
            title: cs.name,
            score: parseFloat(cs.score) || 0,
            unfinished: false,
            isMissing: false,
          }],
        });
      });
    }

    return allSections;
  }

  //     Settings

  function defaultSettings(sections) {
    const equalWeight = sections.length > 0
      ? Math.round(100 / sections.length)
      : 0;
    const sectionDefaults = {};
    sections.forEach((s, i) => {
      // Last section gets the remainder to ensure sum = 100
      const weight = i === sections.length - 1
        ? 100 - equalWeight * (sections.length - 1)
        : equalWeight;
      sectionDefaults[s.name] = { weight, dropLowest: false };
    });
    return {
      mode: 'section',
      unfinished: 'ignore',
      showMissing: true,
      sections: sectionDefaults,
      ignored: {},
      predictions: {},
      customSections: [],
    };
  }

  function mergeSettings(saved, sections) {
    const defaults = defaultSettings(sections);
    const merged = Object.assign({}, defaults, saved);
    // Ensure every section has an entry
    sections.forEach(s => {
      if (!merged.sections[s.name]) {
        merged.sections[s.name] = defaults.sections[s.name] ?? { weight: 0, dropLowest: false };
      }
    });
    // Ensure custom sections have weight entries
    merged.customSections = Array.isArray(merged.customSections) ? merged.customSections : [];
    merged.customSections.forEach(cs => {
      if (cs.name && !merged.sections[cs.name]) {
        merged.sections[cs.name] = { weight: parseFloat(cs.weight) || 0, dropLowest: false };
      }
    });
    merged.ignored = merged.ignored ?? {};
    merged.predictions = merged.predictions ?? {};
    return merged;
  }

  //     Calculation

  function assignmentKey(a) {
    return `${a.badge}|${a.title}`;
  }

  function resolveScore(a, settings) {
    const key = assignmentKey(a);
    if (settings.ignored[key]) return null; // excluded

    // Missing assignments always use the user-entered prediction
    if (a.isMissing) {
      const pred = parseFloat(settings.predictions[key]);
      return isNaN(pred) ? null : Math.min(100, Math.max(0, pred));
    }

    if (a.unfinished) {
      if (settings.unfinished === 'ignore') return null;
      if (settings.unfinished === '100') return 100;
      if (settings.unfinished === 'predict') {
        const pred = parseFloat(settings.predictions[key]);
        return isNaN(pred) ? null : Math.min(100, Math.max(0, pred));
      }
    }
    return a.score;
  }

  function calcSection(section, settings) {
    let scores = section.assignments
      .map(a => ({ score: resolveScore(a, settings), a }))
      .filter(({ score }) => score !== null)
      .map(({ score }) => score);

    if (scores.length === 0) return null;

    const secSettings = settings.sections[section.name] ?? {};
    if (secSettings.dropLowest && scores.length > 1) {
      const min = Math.min(...scores);
      const idx = scores.indexOf(min);
      scores = scores.filter((_, i) => i !== idx);
    }

    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  function calcGrade(sections, settings) {
    if (settings.mode === 'section') {
      let weightedSum = 0;
      let totalWeight = 0;
      const breakdown = [];

      // Compute weight sum for normalization
      let rawWeightSum = 0;
      sections.forEach(s => {
        rawWeightSum += parseFloat(settings.sections[s.name]?.weight ?? 0) || 0;
      });

      sections.forEach(s => {
        const avg = calcSection(s, settings);
        const rawWeight = parseFloat(settings.sections[s.name]?.weight ?? 0) || 0;
        const normWeight = rawWeightSum > 0 ? rawWeight / rawWeightSum * 100 : 0;

        breakdown.push({
          name: s.name,
          avg,
          weight: rawWeight,
          normWeight,
          contribution: avg !== null ? avg * normWeight / 100 : null,
        });

        if (avg !== null) {
          weightedSum += avg * normWeight;
          totalWeight += normWeight;
        }
      });

      const overall = totalWeight > 0 ? weightedSum / totalWeight : null;
      return { overall, breakdown, weightSum: rawWeightSum };
    } else {
      // Per Assignment: flat average, but still respect per-section drop-lowest
      const breakdown = [];
      let allScores = [];

      sections.forEach(s => {
        let scores = s.assignments
          .map(a => ({ score: resolveScore(a, settings), a }))
          .filter(({ score }) => score !== null)
          .map(({ score }) => score);

        const secSettings = settings.sections[s.name] ?? {};
        if (secSettings.dropLowest && scores.length > 1) {
          const min = Math.min(...scores);
          const idx = scores.indexOf(min);
          scores = scores.filter((_, i) => i !== idx);
        }

        const avg = scores.length > 0
          ? scores.reduce((sum, sc) => sum + sc, 0) / scores.length
          : null;

        breakdown.push({ name: s.name, avg, count: scores.length });
        allScores = allScores.concat(scores);
      });

      const overall = allScores.length > 0
        ? allScores.reduce((sum, s) => sum + s, 0) / allScores.length
        : null;

      return { overall, breakdown, weightSum: null };
    }
  }

  //     UI Rendering

  function gradeColor(pct) {
    if (pct === null) return 'text-secondary';
    if (pct >= 90) return 'text-success';
    if (pct >= 70) return 'text-warning';
    return 'text-danger';
  }

  function fmtPct(val) {
    if (val === null) return '—';
    return val.toFixed(1) + '%';
  }

  function renderGrade(card, sections, settings) {
    const result = calcGrade(sections, settings);
    const resultDiv = card.querySelector('#plgc-result');

    const overallColor = gradeColor(result.overall);
    let html = `<div class="d-flex align-items-baseline gap-3 mb-2">
      <span class="fw-bold">Estimated Grade:</span>
      <span class="fs-4 fw-bold ${overallColor}">${fmtPct(result.overall)}</span>
    </div>`;

    if (result.breakdown.length > 0) {
      html += `<table class="table table-sm table-borderless mb-0 small">
        <thead class="text-muted"><tr>
          <th>Section</th>
          <th class="text-end">Avg</th>
          ${settings.mode === 'section' ? '<th class="text-end">Weight</th><th class="text-end">Contribution</th>' : '<th class="text-end">Count</th>'}
        </tr></thead><tbody>`;

      result.breakdown.forEach(b => {
        const color = gradeColor(b.avg);
        if (settings.mode === 'section') {
          html += `<tr>
            <td>${b.name}</td>
            <td class="text-end ${color}">${fmtPct(b.avg)}</td>
            <td class="text-end text-muted">${b.weight} %</td>
            <td class="text-end ${b.contribution !== null ? color : 'text-secondary'}">${b.contribution !== null ? fmtPct(b.contribution) : '—'}</td>
          </tr>`;
        } else {
          html += `<tr>
            <td>${b.name}</td>
            <td class="text-end ${color}">${fmtPct(b.avg)}</td>
            <td class="text-end text-muted">${b.count} assignments</td>
          </tr>`;
        }
      });

      html += '</tbody></table>';
    }

    resultDiv.innerHTML = html;
  }

  function updateWeightWarning(card, settings, sections) {
    const warningEl = card.querySelector('#plgc-weight-warning');
    if (!warningEl) return;
    const sum = sections.reduce((acc, s) => {
      return acc + (parseFloat(settings.sections[s.name]?.weight ?? 0) || 0);
    }, 0);
    if (Math.abs(sum - 100) < 0.01) {
      warningEl.innerHTML = '<span class="text-success">&#10003; Weights sum to 100%</span>';
    } else {
      warningEl.innerHTML = `<span class="text-warning">&#9888; Weights sum to ${sum.toFixed(0)}% — grade is normalized to 100%</span>`;
    }
  }

  //     Gradebook Table Augmentation

  function augmentGradebookTable(missingBySection, settings, onChange) {
    const table = document.querySelector('table[aria-label="Gradebook"]');
    if (!table) return;

    const tbody = table.querySelector('tbody');
    let currentSectionName = null;
    const sectionLastRows = {};

    // First pass: collect badge prefix → color classes from existing badges
    // Badge text is like "P2", "LC1", "HW3" — we extract the letter prefix
    // so missing badges like "P7" match the color of existing "P2".
    const badgeColorMap = {};
    for (const row of tbody.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;
      const badgeEl = cells[0].querySelector('span.badge');
      if (!badgeEl) continue;
      const text = badgeEl.textContent.trim();
      const prefix = text.replace(/[\d#]+.*$/, '');
      if (prefix && !badgeColorMap[prefix]) {
        const colorClasses = [...badgeEl.classList].filter(c => c.startsWith('color-'));
        if (colorClasses.length > 0) badgeColorMap[prefix] = colorClasses;
      }
    }

    for (const row of tbody.querySelectorAll('tr')) {
      const header = row.querySelector('th[colspan]');
      if (header) {
        currentSectionName = header.textContent.trim();
        header.dataset.plgcSection = currentSectionName;

        // Add weight + drop-lowest controls directly into section heading
        const sec = settings.sections[currentSectionName] ?? { weight: 0, dropLowest: false };
        const controls = document.createElement('span');
        controls.className = 'plgc-section-controls';
        controls.innerHTML = `
          <label class="text-muted"> Weight: 
            <input type="number" min="0" max="100" step="1"
              class="form-control form-control-sm d-inline-block plgc-weight-input"
              data-section="${currentSectionName}" value="${sec.weight}"> %
          </label>
          <label class="text-muted">
            <input class="form-check-input plgc-drop-input" type="checkbox"
              data-section="${currentSectionName}" ${sec.dropLowest ? 'checked' : ''}>
            Drop lowest
          </label>
        `;
        header.appendChild(controls);

        // Wire up events for the controls
        const weightInput = controls.querySelector('.plgc-weight-input');
        weightInput.addEventListener('input', () => {
          const sectionName = weightInput.dataset.section;
          settings.sections[sectionName] = settings.sections[sectionName] ?? {};
          settings.sections[sectionName].weight = parseFloat(weightInput.value) || 0;
          onChange();
        });

        const dropInput = controls.querySelector('.plgc-drop-input');
        dropInput.addEventListener('change', () => {
          const sectionName = dropInput.dataset.section;
          settings.sections[sectionName] = settings.sections[sectionName] ?? {};
          settings.sections[sectionName].dropLowest = dropInput.checked;
          onChange();
        });

        continue;
      }

      const cells = row.querySelectorAll('td');
      if (cells.length < 3 || !currentSectionName) continue;

      const badgeEl = cells[0].querySelector('span.badge');
      if (!badgeEl) continue;

      const badgeText = badgeEl.textContent.trim();
      let title = '';
      for (const node of cells[1].childNodes) {
        if (node.nodeType === Node.TEXT_NODE) title += node.textContent;
      }
      title = title.trim();
      if (!title) title = cells[1].textContent.trim();

      const key = `${badgeText}|${title}`;
      row.dataset.plgcKey = key;
      sectionLastRows[currentSectionName] = row;

      // Only wire up click handler once
      if (!badgeEl.classList.contains('plgc-badge-toggle')) {
        badgeEl.classList.add('plgc-badge-toggle');
        badgeEl.title = 'Click to include/exclude from grade calculation';
        badgeEl.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          if (settings.ignored[key]) {
            delete settings.ignored[key];
          } else {
            settings.ignored[key] = true;
          }
          updateGradebookUI(settings);
          onChange();
        });
      }

      if (settings.ignored[key]) row.classList.add('plgc-excluded');
    }

    // Append missing assignment rows into their sections
    Object.entries(missingBySection).forEach(([sectionName, missing]) => {
      if (missing.length === 0) return;

      let insertAfter = sectionLastRows[sectionName];

      if (!insertAfter) {
        // Create a new section header row
        const newHeaderRow = document.createElement('tr');
        newHeaderRow.className = 'plgc-missing-section-header';
        const th = document.createElement('th');
        th.setAttribute('colspan', '10');
        th.textContent = sectionName;
        th.dataset.plgcSection = sectionName;

        const sec = settings.sections[sectionName] ?? { weight: 0, dropLowest: false };
        const controls = document.createElement('span');
        controls.className = 'plgc-section-controls';
        controls.innerHTML = `
          <label class="text-muted"> Weight: 
            <input type="number" min="0" max="100" step="1"
              class="form-control form-control-sm d-inline-block plgc-weight-input"
              data-section="${sectionName}" value="${sec.weight}"> %
          </label>
          <label class="text-muted">
            <input class="form-check-input plgc-drop-input" type="checkbox"
              data-section="${sectionName}" ${sec.dropLowest ? 'checked' : ''}>
            Drop lowest
          </label>
        `;
        th.appendChild(controls);

        controls.querySelector('.plgc-weight-input').addEventListener('input', function() {
          settings.sections[sectionName] = settings.sections[sectionName] ?? {};
          settings.sections[sectionName].weight = parseFloat(this.value) || 0;
          onChange();
        });
        controls.querySelector('.plgc-drop-input').addEventListener('change', function() {
          settings.sections[sectionName] = settings.sections[sectionName] ?? {};
          settings.sections[sectionName].dropLowest = this.checked;
          onChange();
        });

        newHeaderRow.appendChild(th);
        tbody.appendChild(newHeaderRow);
        insertAfter = newHeaderRow;
      }

      missing.forEach(a => {
        const key = assignmentKey(a);
        const prediction = settings.predictions[key] ?? '';

        const tr = document.createElement('tr');
        tr.className = 'plgc-missing-row';
        tr.dataset.plgcKey = key;

        const badgeEl = document.createElement('span');
        badgeEl.className = 'badge plgc-badge-toggle me-1';
        // Copy color classes from existing badges with the same prefix
        const badgePrefix = a.badge.replace(/[\d#]+.*$/, '');
        const colorClasses = badgeColorMap[badgePrefix];
        if (colorClasses) {
          colorClasses.forEach(c => badgeEl.classList.add(c));
        } else {
          badgeEl.classList.add('color-purple2');
        }
        badgeEl.style.fontSize = '0.7em';
        badgeEl.textContent = a.badge;
        badgeEl.title = 'Click to include/exclude from grade calculation';

        const td0 = document.createElement('td');
        td0.className = 'align-middle';
        td0.appendChild(badgeEl);

        const td1 = document.createElement('td');
        td1.className = 'align-middle';
        td1.textContent = a.title;

        const scoreInput = document.createElement('input');
        scoreInput.type = 'number';
        scoreInput.min = '0';
        scoreInput.max = '100';
        scoreInput.step = '0.1';
        scoreInput.placeholder = 'score %';
        scoreInput.className = 'form-control form-control-sm plgc-manual-input';
        scoreInput.dataset.key = key;
        scoreInput.value = prediction;
        scoreInput.style.width = '90px';

        const td2 = document.createElement('td');
        td2.className = 'align-middle';
        td2.appendChild(scoreInput);

        tr.appendChild(td0);
        tr.appendChild(td1);
        tr.appendChild(td2);

        if (insertAfter.nextSibling) {
          tbody.insertBefore(tr, insertAfter.nextSibling);
        } else {
          tbody.appendChild(tr);
        }
        insertAfter = tr;

        badgeEl.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          if (settings.ignored[key]) {
            delete settings.ignored[key];
          } else {
            settings.ignored[key] = true;
          }
          updateGradebookUI(settings);
          onChange();
        });

        scoreInput.addEventListener('input', () => {
          const val = parseFloat(scoreInput.value);
          if (!isNaN(val)) {
            settings.predictions[key] = Math.min(100, Math.max(0, val));
          } else {
            delete settings.predictions[key];
          }
          onChange();
        });

        if (settings.ignored[key]) tr.classList.add('plgc-excluded');
      });
    });
  }

  function updateGradebookUI(settings) {
    const table = document.querySelector('table[aria-label="Gradebook"]');
    if (!table) return;

    // Show/hide section controls based on mode
    table.querySelectorAll('.plgc-section-controls').forEach(ctrl => {
      ctrl.style.display = settings.mode === 'section' ? '' : 'none';
    });

    // Update excluded state for all tagged rows
    table.querySelectorAll('tr[data-plgc-key]').forEach(row => {
      row.classList.toggle('plgc-excluded', !!settings.ignored[row.dataset.plgcKey]);
    });
  }

  //     Build Card

  let saveTimer = null;
  function scheduleSave(settings) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_KEY]: settings });
    }, 300);
  }

  function buildCard(allSections, settings) {
    const card = document.createElement('div');
    card.className = 'card mb-4';
    card.id = 'pl-grade-calc';

    card.innerHTML = `
      <div class="card-header bg-primary text-white d-flex align-items-center">
        <h2 class="h5 mb-0">Grade Calculator</h2>
        <button class="btn btn-sm btn-outline-light ms-auto" id="plgc-collapse-btn">Collapse</button>
      </div>
      <div class="card-body" id="plgc-body">

        <div class="row g-3 mb-3 align-items-end">
          <div class="col-auto">
            <label class="form-label small mb-1 fw-semibold" for="plgc-mode">Mode</label>
            <select class="form-select form-select-sm" id="plgc-mode">
              <option value="section">Per Section</option>
              <option value="assignment">Per Assignment</option>
            </select>
          </div>
          <div class="col-auto d-flex align-items-center">
            <div class="form-check form-switch mb-0">
              <input class="form-check-input" type="checkbox" id="plgc-show-missing">
              <label class="form-check-label small fw-semibold" for="plgc-show-missing">Show all assessments</label>
            </div>
          </div>
        </div>

        <div class="mb-3">
          <div class="d-flex align-items-center mb-2">
            <span class="fw-semibold small">Custom Sections</span>
            <button class="btn btn-sm btn-outline-primary ms-2" id="plgc-add-custom" title="Add a custom section (e.g. Final Exam)">+ Add</button>
          </div>
          <div id="plgc-custom-list"></div>
        </div>

        <div id="plgc-weight-warning" class="small mb-3"></div>
        <div id="plgc-result" class="p-3 bg-light rounded border"></div>
      </div>
    `;

    //    Collapse toggle
    const collapseBtn = card.querySelector('#plgc-collapse-btn');
    const body = card.querySelector('#plgc-body');
    collapseBtn.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      collapseBtn.textContent = collapsed ? 'Collapse' : 'Expand';
    });

    //    Populate selectors
    card.querySelector('#plgc-mode').value = settings.mode;
    card.querySelector('#plgc-show-missing').checked = settings.showMissing;

    return card;
  }

  function wireCard(card, settings, onChange, onCustomChange) {
    const modeSelect = card.querySelector('#plgc-mode');

    modeSelect.addEventListener('change', () => {
      settings.mode = modeSelect.value;
      onChange();
    });

    // Custom Sections
    const customList = card.querySelector('#plgc-custom-list');
    const addBtn = card.querySelector('#plgc-add-custom');

    function renderCustomList() {
      customList.innerHTML = '';
      settings.customSections.forEach((cs, idx) => {
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center gap-2 mb-1';
        row.innerHTML = `
          <input type="text" class="form-control form-control-sm" placeholder="Name (e.g. Final Exam)"
            style="width:160px" value="${(cs.name || '').replace(/"/g, '&quot;')}" data-field="name">
          <label class="small text-muted mb-0">Score:</label>
          <input type="number" min="0" max="100" step="0.1" class="form-control form-control-sm"
            style="width:75px" value="${cs.score ?? ''}" placeholder="%" data-field="score">
          <label class="small text-muted mb-0">Weight:</label>
          <input type="number" min="0" max="100" step="1" class="form-control form-control-sm"
            style="width:65px" value="${cs.weight ?? 0}" placeholder="%" data-field="weight">
          <button class="btn btn-sm btn-outline-danger plgc-remove-custom" title="Remove">&times;</button>
        `;

        row.querySelector('[data-field="name"]').addEventListener('input', function () {
          const oldName = cs.name;
          cs.name = this.value.trim();
          if (oldName && oldName !== cs.name) delete settings.sections[oldName];
          if (cs.name) settings.sections[cs.name] = { weight: parseFloat(cs.weight) || 0, dropLowest: false };
          onCustomChange();
        });

        row.querySelector('[data-field="score"]').addEventListener('input', function () {
          cs.score = parseFloat(this.value) || 0;
          onCustomChange();
        });

        row.querySelector('[data-field="weight"]').addEventListener('input', function () {
          cs.weight = parseFloat(this.value) || 0;
          if (cs.name) {
            settings.sections[cs.name] = settings.sections[cs.name] ?? {};
            settings.sections[cs.name].weight = cs.weight;
          }
          onCustomChange();
        });

        row.querySelector('.plgc-remove-custom').addEventListener('click', () => {
          if (cs.name) delete settings.sections[cs.name];
          settings.customSections.splice(idx, 1);
          renderCustomList();
          onCustomChange();
        });

        customList.appendChild(row);
      });
    }

    addBtn.addEventListener('click', () => {
      settings.customSections.push({ name: '', score: 0, weight: 0 });
      renderCustomList();
    });

    renderCustomList();
  }

  //     Init

  function init() {
    const sections = parseGradebook();
    if (sections.length === 0) return;

    chrome.storage.local.get([STORAGE_KEY, COURSE_KEY], result => {
      const saved = result[STORAGE_KEY] ?? null;
      const courseSnapshot = result[COURSE_KEY] ?? null;

      const allMissing = computeMissing(courseSnapshot, sections);
      const activeMissing = (saved?.showMissing ?? true) ? allMissing : {};
      const savedCustom = Array.isArray(saved?.customSections) ? saved.customSections : [];
      let allSections = buildAllSections(sections, activeMissing, savedCustom);
      const settings = mergeSettings(saved, allSections);

      const card = buildCard(allSections, settings);

      function onChange() {
        updateGradebookUI(settings);
        updateWeightWarning(card, settings, allSections);
        renderGrade(card, allSections, settings);
        scheduleSave(settings);
      }

      wireCard(card, settings, onChange, function onCustomChange() {
        // Rebuild allSections to include updated custom sections
        const currentMissing = settings.showMissing ? allMissing : {};
        allSections = buildAllSections(sections, currentMissing, settings.customSections);
        const remerged = mergeSettings(settings, allSections);
        Object.assign(settings, remerged);
        onChange();
      });
      augmentGradebookTable(activeMissing, settings, onChange);

      // Wire up the show-missing toggle
      card.querySelector('#plgc-show-missing').addEventListener('change', function () {
        settings.showMissing = this.checked;

        // Remove all injected missing rows and missing-only section headers
        document.querySelectorAll('.plgc-missing-row').forEach(r => r.remove());
        document.querySelectorAll('.plgc-missing-section-header').forEach(r => r.remove());

        // Remove all injected section controls (they get re-created by augment)
        document.querySelectorAll('.plgc-section-controls').forEach(el => el.remove());

        // Rebuild sections with or without missing assignments
        const nowMissing = settings.showMissing ? allMissing : {};
        allSections = buildAllSections(sections, nowMissing, settings.customSections);

        // Re-merge settings so new sections get defaults
        const remerged = mergeSettings(settings, allSections);
        Object.assign(settings, remerged);

        // Re-augment the gradebook table with the new missing set
        augmentGradebookTable(nowMissing, settings, onChange);

        onChange();
      });

      // Insert after the gradebook card
      const gradebookCard = document.querySelector('.card.mb-4');
      if (gradebookCard && gradebookCard.parentNode) {
        gradebookCard.parentNode.insertBefore(card, gradebookCard.nextSibling);
      } else {
        document.querySelector('main')?.appendChild(card);
      }

      // Initial render
      updateGradebookUI(settings);
      updateWeightWarning(card, settings, allSections);
      renderGrade(card, allSections, settings);
    });
  }

  init();
})();
