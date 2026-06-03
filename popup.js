const checkBtn = document.getElementById('check-btn');
const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const resultsEl = document.getElementById('results');
const bookTitleEl = document.getElementById('book-title');
const aiPctEl = document.getElementById('ai-pct');
const humanPctEl = document.getElementById('human-pct');
const verdictEl = document.getElementById('verdict');
const chaptersInfoEl = document.getElementById('chapters-info');
const lastCheckInfoEl = document.getElementById('last-check-info');
const historySection = document.getElementById('history');
const historyList = document.getElementById('history-list');

let isChecking = false;
let currentBookId = null;

// Определяем текущую книгу при открытии popup
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs.length === 0) return;
  const url = tabs[0].url || '';
  const workMatch = url.match(/author\.today\/work\/(\d+)/);

  if (workMatch) {
    currentBookId = workMatch[1];
    statusEl.textContent = `Готов: книга #${currentBookId}`;
    statusEl.className = 'status success';
    checkBtn.disabled = false;
  } else if (url.includes('author.today')) {
    statusEl.textContent = 'Перейдите на страницу книги (/work/NNN)';
    statusEl.className = 'status error';
  } else {
    statusEl.textContent = 'Откройте страницу книги на author.today';
    statusEl.className = 'status info';
  }

  loadHistory();
});

function loadHistory() {
  chrome.runtime.sendMessage({ action: 'get_history' }, (response) => {
    if (!response?.history) return;
    const history = response.history;

    // Показываем результат текущей книги
    const current = history[currentBookId];
    if (current?.timestamp) {
      if (current.error) {
        setStatus(current.error, 'error');
        lastCheckInfoEl.textContent = `Попытка: ${fmtDate(current.timestamp)} (ошибка)`;
        lastCheckInfoEl.style.display = 'block';
      } else {
        showResult(current);
      }
    }

    // Показываем историю других книг
    showHistoryList(history);
  });
}

function showHistoryList(history) {
  const entries = Object.entries(history)
    .filter(([id]) => id !== currentBookId)
    .sort((a, b) => b[1].timestamp - a[1].timestamp);

  if (entries.length === 0) {
    historySection.style.display = 'none';
    return;
  }

  historySection.style.display = 'block';
  historyList.innerHTML = '';

  entries.forEach(([bookId, data]) => {
    const div = document.createElement('div');
    div.className = 'history-item';

    const aiColor = data.error ? '#f44336' :
                    data.aiPercent >= 50 ? '#f44336' :
                    data.aiPercent >= 5 ? '#ff9800' : '#4caf50';
    const info = data.error ? 'Ошибка' : `${data.aiPercent.toFixed(1)}% ИИ`;

    div.innerHTML = `
      <span class="history-item-title">${data.bookTitle || 'Книга #' + bookId}</span>
      <span class="history-item-ai" style="color:${aiColor}">${info}</span>
      <span class="history-item-date">${fmtDateShort(data.timestamp)}</span>
    `;

    div.addEventListener('click', () => {
      if (data.error) setStatus(data.error, 'error');
      else showResult(data);
    });

    historyList.appendChild(div);
  });
}

checkBtn.addEventListener('click', () => {
  isChecking = true;
  checkBtn.disabled = true;
  resultsEl.classList.remove('active');
  historySection.style.display = 'none';
  lastCheckInfoEl.style.display = 'none';

  progressBar.classList.add('active');
  progressText.classList.add('active');
  progressFill.style.width = '0%';

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ action: 'check_book', tabId: tab.id, url: tab.url }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Ошибка: ${chrome.runtime.lastError.message}`, 'error');
        resetUI();
      }
    });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'progress') {
    progressFill.style.width = `${message.percent}%`;
    progressText.textContent = message.text;
    statusEl.textContent = message.text;
    statusEl.className = 'status loading';
  } else if (message.action === 'result') {
    showResult(message.data);
    loadHistory();
    resetUI();
  } else if (message.action === 'error') {
    setStatus(message.text, 'error');
    loadHistory();
    resetUI();
  }
});

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
}

function resetUI() {
  isChecking = false;
  progressBar.classList.remove('active');
  progressText.classList.remove('active');
  checkBtn.disabled = false;
  checkBtn.textContent = 'Проверить заново';
}

function showResult(data) {
  bookTitleEl.textContent = data.bookTitle || 'Книга';
  aiPctEl.textContent = `${data.aiPercent?.toFixed(1) ?? '?'}%`;
  humanPctEl.textContent = `${data.humanPercent?.toFixed(1) ?? '?'}%`;

  verdictEl.textContent = data.verdict || '';
  verdictEl.className = 'verdict';
  if (data.aiPercent >= 50) verdictEl.classList.add('high-ai');
  else if (data.aiPercent >= 5) verdictEl.classList.add('mid-ai');
  else verdictEl.classList.add('low-ai');

  chaptersInfoEl.textContent = `Проверено глав: ${data.chaptersCount}, сегментов: ${data.segmentsCount ?? '?'}`;
  lastCheckInfoEl.textContent = `Проверка: ${fmtDate(data.timestamp)}`;
  lastCheckInfoEl.style.display = 'block';

  resultsEl.classList.add('active');
  setStatus('Проверка завершена!', 'success');
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('ru-RU');
}

function fmtDateShort(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
