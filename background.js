/**
 * Author.today NeuroDetector — Browser Extension
 * Background Service Worker
 *
 * Architecture:
 * 1. Parses book TOC from /work/{bookId} page
 * 2. Navigates the active tab through each chapter sequentially
 * 3. After DOM load + JS render wait, extracts text via executeScript
 * 4. Sends collected text to Yandex NeuroDetector API with retry
 * 5. Results stored in chrome.storage.local keyed by bookId
 */

const NEURODETECTOR_URL = 'https://yandex.ru/lab/neurodetector/api/analyze/text';
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 3000;

const DEFAULT_SETTINGS = {
  maxChapters: 20,
  renderWaitMs: 4000,
  delayBetweenChaptersMs: 800,
  chapterTimeoutMs: 20000,
};

let checkState = null;
let chapterTimeout = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'check_book') {
    checkBook(message.tabId, message.url);
    sendResponse({});
  } else if (message.action === 'get_history') {
    chrome.storage.local.get('checkHistory', (data) => {
      sendResponse({ history: data.checkHistory || {} });
    });
    return true;
  } else if (message.action === 'get_settings') {
    chrome.storage.local.get('settings', (data) => {
      sendResponse({ settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } });
    });
    return true;
  } else if (message.action === 'save_settings') {
    chrome.storage.local.set({ settings: message.settings }, () => {
      sendResponse({ ok: true });
    });
    return true;
  } else if (message.action === 'retry_neurodetector') {
    retryNeuroDetector();
    sendResponse({});
  }
});

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => {
      resolve({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
    });
  });
}

async function checkBook(tabId, url) {
  const workMatch = url.match(/author\.today\/work\/(\d+)/);
  if (!workMatch) {
    sendError('Не удалось определить ID книги. Перейдите на /work/NNN');
    return;
  }

  const bookId = workMatch[1];
  const settings = await loadSettings();

  try {
    sendProgress(5, 'Парсинг оглавления...');

    const tocData = await parseTableOfContents(tabId, bookId);
    if (!tocData || tocData.chapters.length === 0) {
      sendError('Не удалось найти оглавление или главы отсутствуют');
      return;
    }

    const chapters = tocData.chapters.slice(0, settings.maxChapters);
    sendProgress(10, `Найдено ${chapters.length} глав. Начинаю обход...`);

    checkState = {
      originalTabId: tabId,
      bookId,
      bookTitle: tocData.title,
      chapters,
      currentIndex: 0,
      allTexts: [],
      paidDetected: false,
      settings,
    };

    goToChapter(0);
  } catch (e) {
    sendError(`Ошибка: ${e.message}`);
    checkState = null;
  }
}

/**
 * Navigates tab to chapter, waits for DOM load via tabs.onUpdated,
 * then waits for JS render and extracts text directly.
 */
function goToChapter(index) {
  if (!checkState) return;

  const { chapters, paidDetected, originalTabId, settings } = checkState;

  if (index >= chapters.length || paidDetected) {
    finalizeCheck();
    return;
  }

  checkState.currentIndex = index;
  const chapter = chapters[index];
  const percent = 10 + Math.round((index / chapters.length) * 70);
  sendProgress(percent, `Глава ${index + 1}/${chapters.length}: ${chapter.title}`);

  const readerUrl = `https://author.today/reader/${checkState.bookId}/${chapter.id}`;

  clearTimeout(chapterTimeout);
  chapterTimeout = setTimeout(() => {
    console.log(`[Ch${index}] Timeout`);
    goToChapter(index + 1);
  }, settings.chapterTimeoutMs);

  // Navigate tab
  chrome.tabs.update(originalTabId, { url: readerUrl });

  // Wait for DOM load via onUpdated
  const onUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId !== originalTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);

    console.log(`[Ch${index}] DOM loaded, waiting ${settings.renderWaitMs}ms for JS...`);

    // Wait for Knockout.js render
    setTimeout(() => {
      extractTextDirect(originalTabId, chapter.title, index);
    }, settings.renderWaitMs);
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
}

/**
 * Extracts text directly via executeScript — no content script dependency.
 */
function extractTextDirect(tabId, chapterTitle, chapterIndex) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const bodyText = document.body ? (document.body.textContent || '') : '';
      const bodyLower = bodyText.toLowerCase();

      // Paid chapter detection
      const paidPatterns = [
        'платный доступ', 'для продолжения чтения', 'закрытый контент',
        'buy chapter', 'купить главу', 'приобретите доступ', 'paid access',
      ];
      for (const p of paidPatterns) {
        if (bodyLower.includes(p)) return { paid: true, text: '', bodyLen: bodyText.length };
      }

      const locks = document.querySelectorAll(
        '.content-lock, .authorize, .purchase, [class*="lock"], [class*="buy"]'
      );
      if (locks.length > 2) return { paid: true, text: '', bodyLen: bodyText.length };

      // Extract from #text-container
      const container = document.querySelector('#text-container');
      if (container) {
        const paragraphs = container.querySelectorAll('p');
        if (paragraphs.length > 0) {
          const text = Array.from(paragraphs)
            .map(p => p.textContent.trim())
            .filter(t => t.length > 0)
            .join('\n\n');
          if (text.length > 20) return { text, paid: false, source: 'container-p' };
        }
        const text = container.textContent.trim();
        if (text.length > 20) return { text, paid: false, source: 'container' };
      }

      // Fallback: body text
      if (bodyText.length > 100) {
        return { text: bodyText.substring(0, 15000), paid: false, source: 'body' };
      }

      return { text: '', paid: false, source: 'empty', bodyLen: bodyText.length };
    },
  }).then((results) => {
    if (!checkState) return;

    clearTimeout(chapterTimeout);

    const data = results?.[0]?.result;
    console.log(`[Ch${chapterIndex}] Extracted: source=${data?.source}, textLen=${data?.text?.length || 0}, paid=${data?.paid}`);

    if (!data) {
      console.log(`[Ch${chapterIndex}] No result from executeScript`);
      goToChapter(chapterIndex + 1);
      return;
    }

    if (data.paid) {
      checkState.paidDetected = true;
      sendProgress(75, `Платная глава "${chapterTitle}". Стоп.`);
      finalizeCheck();
      return;
    }

    if (data.text && data.text.length > 20) {
      checkState.allTexts.push(`=== ${chapterTitle} ===\n${data.text}`);
    } else {
      console.log(`[Ch${chapterIndex}] Empty text, bodyLen=${data.bodyLen || 0}`);
    }

    const { settings } = checkState;
    setTimeout(() => goToChapter(chapterIndex + 1), settings.delayBetweenChaptersMs);
  }).catch((e) => {
    clearTimeout(chapterTimeout);
    console.error(`[Ch${chapterIndex}] executeScript error:`, e);
    goToChapter(chapterIndex + 1);
  });
}

function saveResult(resultData) {
  chrome.storage.local.get('checkHistory', (data) => {
    const history = data.checkHistory || {};
    history[resultData.bookId] = resultData;
    chrome.storage.local.set({ checkHistory: history });
  });
}

async function sendToNeuroDetectorWithRetry(text) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      sendProgress(85 + Math.round((attempt / MAX_RETRY_ATTEMPTS) * 10),
        `Отправка в NeuroDetector (попытка ${attempt}/${MAX_RETRY_ATTEMPTS})...`);

      const result = await sendToNeuroDetector(text);
      return result;
    } catch (e) {
      lastError = e;

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        sendProgress(85, `Ошибка: ${e.message}. Повтор через ${Math.round(delay / 1000)}с...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Не удалось отправить после ${MAX_RETRY_ATTEMPTS} попыток: ${lastError?.message || 'неизвестная ошибка'}`);
}

async function finalizeCheck() {
  if (!checkState) return;

  clearTimeout(chapterTimeout);

  const { bookTitle, allTexts, paidDetected, bookId, originalTabId } = checkState;

  if (originalTabId) {
    chrome.tabs.update(originalTabId, { url: `https://author.today/work/${bookId}` });
  }

  const resultData = { bookId, timestamp: Date.now(), bookTitle, chaptersCount: allTexts.length, paidDetected };

  if (allTexts.length === 0) {
    resultData.error = 'Не удалось извлечь текст из глав';
    saveResult(resultData);
    sendError(resultData.error);
    checkState = null;
    return;
  }

  const combinedText = allTexts.join('\n\n');
  sendProgress(85, `Собрано ${allTexts.length} глав (${combinedText.length} зн.). Отправляю...`);

  try {
    const result = await sendToNeuroDetectorWithRetry(combinedText);
    sendProgress(100, 'Готово!');

    resultData.aiPercent = result.aiPercent;
    resultData.humanPercent = result.humanPercent;
    resultData.verdict = result.verdict;
    resultData.segmentsCount = result.segmentsCount;

    saveResult(resultData);
    chrome.runtime.sendMessage({ action: 'result', data: resultData });
  } catch (e) {
    resultData.error = `NeuroDetector: ${e.message}`;
    saveResult(resultData);
    sendError(resultData.error);
  }

  checkState = null;
}

async function retryNeuroDetector() {
  if (!checkState || checkState.allTexts.length === 0) {
    sendError('Нет данных для повторной отправки');
    return;
  }

  const { bookTitle, allTexts, paidDetected, bookId } = checkState;
  const combinedText = allTexts.join('\n\n');

  sendProgress(85, `Повторная отправка (${combinedText.length} зн.)...`);

  try {
    const result = await sendToNeuroDetectorWithRetry(combinedText);
    sendProgress(100, 'Готово!');

    const resultData = {
      bookId, timestamp: Date.now(), bookTitle,
      chaptersCount: allTexts.length, paidDetected,
      aiPercent: result.aiPercent, humanPercent: result.humanPercent,
      verdict: result.verdict, segmentsCount: result.segmentsCount,
    };

    saveResult(resultData);
    chrome.runtime.sendMessage({ action: 'result', data: resultData });
  } catch (e) {
    sendError(`NeuroDetector: ${e.message}`);
  }

  checkState = null;
}

async function parseTableOfContents(tabId) {
  await chrome.tabs.reload(tabId);
  await new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  await sleep(2000);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    func: () => {
      const h1 = document.querySelector('h1');
      const title = h1 ? h1.textContent.trim() : 'Без названия';

      const chapters = [];
      const links = document.querySelectorAll('ul.table-of-content a[href*="/reader/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/reader\/\d+\/(\d+)/);
        if (m) chapters.push({ id: m[1], title: link.textContent.trim() });
      }
      return { title, chapters };
    },
  });

  return results?.find(r => r.result?.title)?.result || null;
}

async function sendToNeuroDetector(text) {
  const res = await fetch(NEURODETECTOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (res.status === 429) {
    throw new Error('Слишком много запросов (429). Яндекс ограничивает частоту.');
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.ok || !data.results) throw new Error('Некорректный ответ API');

  const stats = data.results.stats || {};
  const ai = (stats.AI_count || 0) + (stats.LIKELY_AI_count || 0);
  const human = (stats.HUMAN_count || 0) + (stats.LIKELY_HUMAN_count || 0);
  const total = ai + human;

  const aiPercent = total > 0 ? (ai / total) * 100 : 0;
  let verdict = 'Текст скорее всего написан человеком';
  if (aiPercent >= 50) verdict = 'Большая часть текста вероятно сгенерирована ИИ';
  else if (aiPercent >= 5) verdict = 'Часть текста вероятно сгенерирована ИИ';

  return { aiPercent, humanPercent: total > 0 ? (human / total) * 100 : 0, verdict, segmentsCount: stats.segments_count || 0 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sendProgress(p, t) { chrome.runtime.sendMessage({ action: 'progress', percent: p, text: t }); }
function sendError(t) { chrome.runtime.sendMessage({ action: 'error', text: t }); }
