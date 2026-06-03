/**
 * Author.today NeuroDetector — Browser Extension
 * Background Service Worker
 *
 * Architecture:
 * 1. Parses book TOC from /work/{bookId} page
 * 2. Navigates the active tab through each chapter sequentially
 * 3. Content script on each reader page extracts text and sends it back
 * 4. After collecting all texts, sends to Yandex NeuroDetector API
 * 5. Results are stored in chrome.storage.local keyed by bookId
 */

const NEURODETECTOR_URL = 'https://yandex.ru/lab/neurodetector/api/analyze/text';
const DELAY_BETWEEN_CHAPTERS_MS = 1000;
const MAX_CHAPTERS = 20;
const CHAPTER_TIMEOUT_MS = 25000;

let checkState = null;
let chapterTimeout = null;

/**
 * Handles messages from popup and content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'check_book') {
    checkBook(message.tabId, message.url);
    sendResponse({});
  } else if (message.action === 'chapter_ready') {
    handleChapterReady(message, sender);
    sendResponse({});
  } else if (message.action === 'get_history') {
    chrome.storage.local.get('checkHistory', (data) => {
      sendResponse({ history: data.checkHistory || {} });
    });
    return true;
  }
});

/**
 * Entry point: validates URL, parses TOC, starts chapter iteration.
 */
async function checkBook(tabId, url) {
  const workMatch = url.match(/author\.today\/work\/(\d+)/);
  if (!workMatch) {
    sendError('Не удалось определить ID книги. Перейдите на /work/NNN');
    return;
  }

  const bookId = workMatch[1];

  try {
    sendProgress(5, 'Парсинг оглавления...');

    const tocData = await parseTableOfContents(tabId, bookId);
    if (!tocData || tocData.chapters.length === 0) {
      sendError('Не удалось найти оглавление или главы отсутствуют');
      return;
    }

    const chapters = tocData.chapters.slice(0, MAX_CHAPTERS);
    sendProgress(10, `Найдено ${chapters.length} глав. Начинаю обход...`);

    checkState = {
      originalTabId: tabId,
      bookId,
      bookTitle: tocData.title,
      chapters,
      currentIndex: 0,
      allTexts: [],
      paidDetected: false,
    };

    goToChapter(0);
  } catch (e) {
    sendError(`Ошибка: ${e.message}`);
    checkState = null;
  }
}

/**
 * Navigates the tab to a chapter page and waits for content script response.
 */
function goToChapter(index) {
  if (!checkState) return;

  const { chapters, paidDetected, originalTabId } = checkState;

  if (index >= chapters.length || paidDetected) {
    finalizeCheck();
    return;
  }

  checkState.currentIndex = index;
  const chapter = chapters[index];
  const percent = 10 + Math.round((index / chapters.length) * 70);
  sendProgress(percent, `Глава ${index + 1}/${chapters.length}: ${chapter.title}`);

  const readerUrl = `https://author.today/reader/${checkState.bookId}/${chapter.id}`;

  // Timeout fallback if content script doesn't respond
  clearTimeout(chapterTimeout);
  chapterTimeout = setTimeout(() => {
    goToChapter(index + 1);
  }, CHAPTER_TIMEOUT_MS);

  // Navigate the tab, then inject content script (tabs.update may not trigger it)
  chrome.tabs.update(originalTabId, { url: readerUrl }, () => {
    setTimeout(() => injectContentScript(originalTabId), 1000);
  });
}

/**
 * Injects content.js into the tab to extract chapter text.
 */
function injectContentScript(tabId) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['content.js'],
  }).catch(() => {});
}

/**
 * Receives extracted text from content script.
 */
function handleChapterReady(message, sender) {
  if (!checkState) return;
  if (sender.tab?.id !== checkState.originalTabId) return;

  clearTimeout(chapterTimeout);

  const { currentIndex, chapters } = checkState;
  const chapter = chapters[currentIndex];

  if (message.isPaid) {
    checkState.paidDetected = true;
    sendProgress(75, `Платная глава "${chapter.title}". Стоп.`);
    finalizeCheck();
    return;
  }

  if (message.text && message.text.length > 50) {
    checkState.allTexts.push(`=== ${chapter.title} ===\n${message.text}`);
  }

  setTimeout(() => goToChapter(currentIndex + 1), DELAY_BETWEEN_CHAPTERS_MS);
}

/**
 * Saves result to chrome.storage.local, keyed by bookId.
 */
function saveResult(resultData) {
  chrome.storage.local.get('checkHistory', (data) => {
    const history = data.checkHistory || {};
    history[resultData.bookId] = resultData;
    chrome.storage.local.set({ checkHistory: history });
  });
}

/**
 * Finalizes: sends collected text to NeuroDetector API, saves and displays result.
 */
async function finalizeCheck() {
  if (!checkState) return;

  clearTimeout(chapterTimeout);

  const { bookTitle, allTexts, paidDetected, bookId, originalTabId } = checkState;

  // Return tab to book page
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
    const result = await sendToNeuroDetector(combinedText);
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

/**
 * Parses table of contents from the book page to extract chapter IDs.
 */
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

/**
 * Sends text to Yandex NeuroDetector API and parses the response.
 */
async function sendToNeuroDetector(text) {
  const res = await fetch(NEURODETECTOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (!data.ok || !data.results) throw new Error('Bad API response');

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
