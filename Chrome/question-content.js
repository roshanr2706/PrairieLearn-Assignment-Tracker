(function () {
  'use strict';

  if (!location.pathname.match(/\/pl\/course_instance\/\d+\/instance_question\/\d+/)) return;

  function injectScreenshotButton() {
    const panel = document.querySelector('.question-block')
      || document.querySelector('.question-body')?.closest('.card')
      || document.querySelector('.card');
    if (!panel) return;

    const header = panel.querySelector('.card-header');
    if (!header) return;

    // Guard against double-inject (home-content.js also runs on all PL pages)
    if (header.querySelector('.pl-screenshot-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-light ms-2 pl-screenshot-btn';
    btn.style.flexShrink = '0';
    btn.textContent = 'Screenshot';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.appendChild(btn);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Capturing...';

      try {
        const canvas = await html2canvas(panel, {
          useCORS: true,
          allowTaint: true,
          scale: window.devicePixelRatio || 1,
          scrollX: 0,
          scrollY: -window.scrollY,
          windowWidth: document.documentElement.scrollWidth,
          windowHeight: document.documentElement.scrollHeight,
        });

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Failed';
      }

      btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Screenshot'; }, 2500);
    });
  }

  injectScreenshotButton();
})();
