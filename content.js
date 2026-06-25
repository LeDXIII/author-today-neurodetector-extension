/**
 * Content script for author.today reader pages.
 * Adds a manual "Check chapter" button for single-chapter NeuroDetector check.
 * Auto-collection is handled by background.js via executeScript.
 */
(function () {
  'use strict';

  if (!window.location.pathname.match(/\/reader\/\d+\/\d+/)) return;

  setTimeout(() => {
    const container = document.querySelector('#text-container');
    if (!container || document.getElementById('neurodetector-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'neurodetector-btn';
    btn.textContent = '🤖 Проверить главу';
    btn.style.cssText = `
      display:block; margin:20px auto; padding:12px 24px;
      font-size:14px; font-weight:600; color:#fff;
      background:linear-gradient(135deg,#667eea,#764ba2);
      border:none; border-radius:8px; cursor:pointer;
    `;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = ' Отправляю...';
      try {
        const text = container.querySelectorAll('p').length > 0
          ? Array.from(container.querySelectorAll('p')).map(p => p.textContent.trim()).filter(t => t.length > 0).join('\n\n')
          : container.textContent.trim();

        const res = await fetch('https://yandex.ru/lab/neurodetector/api/analyze/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });

        showPanel(await res.json());
        btn.textContent = '✅ Готово!';
      } catch (e) {
        btn.textContent = `❌ ${e.message}`;
      }
      setTimeout(() => { btn.disabled = false; btn.textContent = '🤖 Проверить главу'; }, 3000);
    });

    container.parentNode.insertBefore(btn, container);
  }, 1000);

  function showPanel(data) {
    const old = document.getElementById('neurodetector-result');
    if (old) old.remove();
    if (!data.ok || !data.results) return;

    const s = data.results.stats || {};
    const ai = (s.AI_count || 0) + (s.LIKELY_AI_count || 0);
    const human = (s.HUMAN_count || 0) + (s.LIKELY_HUMAN_count || 0);
    const total = ai + human;
    const aiPct = total > 0 ? (ai / total) * 100 : 0;

    const color = aiPct >= 50 ? '#f44336' : aiPct >= 5 ? '#ff9800' : '#4caf50';
    let verdict = 'Текст скорее всего написан человеком';
    if (aiPct >= 50) verdict = 'Большая часть текста вероятно сгенерирована ИИ';
    else if (aiPct >= 5) verdict = 'Часть текста вероятно сгенерирована ИИ';

    const panel = document.createElement('div');
    panel.id = 'neurodetector-result';
    panel.style.cssText = `
      position:fixed; top:20px; right:20px; width:300px;
      background:#1a1a2e; color:#e0e0e0; border-radius:12px; padding:16px;
      font-family:sans-serif; box-shadow:0 8px 32px rgba(0,0,0,0.5); z-index:10000;
    `;
    panel.innerHTML = `
      <div style="font-weight:600;color:#00d4ff;margin-bottom:10px;">Результат</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="flex:1;text-align:center;padding:8px;background:#0f3460;border-radius:6px;border-bottom:3px solid ${color};">
          <div style="font-size:24px;font-weight:700;color:${color};">${aiPct.toFixed(1)}%</div>
          <div style="font-size:11px;color:#888;">ИИ</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px;background:#0f3460;border-radius:6px;border-bottom:3px solid #4caf50;">
          <div style="font-size:24px;font-weight:700;color:#4caf50;">${(total > 0 ? (human/total)*100 : 0).toFixed(1)}%</div>
          <div style="font-size:11px;color:#888;">Человек</div>
        </div>
      </div>
      <div style="font-size:12px;padding:8px;border-radius:6px;text-align:center;color:${color};">${verdict}</div>
      <button onclick="this.parentElement.remove()" style="margin-top:10px;width:100%;padding:6px;background:#333;color:#aaa;border:none;border-radius:4px;cursor:pointer;">Закрыть</button>
    `;
    document.body.appendChild(panel);
    setTimeout(() => { if (panel.parentElement) panel.remove(); }, 30000);
  }
})();
