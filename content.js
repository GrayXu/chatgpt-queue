// ChatGPT Message Queue - Content Script
// Handles detection, interception, queue management, and auto-dispatch

(function() {
  'use strict';

  // State
  let messageQueue = [];
  let isGenerating = false;
  let conversationId = null;
  let observer = null;
  let observedContainer = null;
  let queueUI = null;
  let queueButton = null;
  let inputObserver = null;
  let dispatchDelay = 500; // ms delay before sending next message
  let dispatchTimeoutId = null;
  let fallbackPollerId = null;
  let dispatchInProgress = false;
  let dispatchInProgressTimeoutId = null;

  const LOG_LEVEL = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  function getLogLevel() {
    const raw = localStorage.getItem('chatgpt-queue-log-level');
    if (raw === null || raw === undefined || raw === '') return LOG_LEVEL.info;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return LOG_LEVEL.info;
    return Math.max(LOG_LEVEL.error, Math.min(LOG_LEVEL.debug, parsed));
  }

  function logAt(level, ...args) {
    if (getLogLevel() < level) return;
    const prefix = '[ChatGPT Queue]';
    if (level <= LOG_LEVEL.error) console.error(prefix, ...args);
    else if (level <= LOG_LEVEL.warn) console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }

  function logInfo(...args) { logAt(LOG_LEVEL.info, ...args); }
  function logWarn(...args) { logAt(LOG_LEVEL.warn, ...args); }
  function logError(...args) { logAt(LOG_LEVEL.error, ...args); }
  function logDebug(...args) { logAt(LOG_LEVEL.debug, ...args); }

  // Selectors for ChatGPT DOM elements (may need updating if ChatGPT changes)
  const SELECTORS = {
    // Stop button appears during generation
    stopButton: 'button[aria-label="Stop generating"], button[data-testid="stop-button"], button[aria-label="Stop streaming"]',
    // The main textarea for input
    textarea: '#prompt-textarea, textarea[data-id="root"]',
    // Send button
    sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
    // Chat container for observing changes
    chatContainer: 'main',
    // Form containing the input
    inputForm: 'form',
  };

  function markDispatchInProgress() {
    dispatchInProgress = true;
    if (dispatchInProgressTimeoutId) {
      clearTimeout(dispatchInProgressTimeoutId);
    }
    // Safety valve: if ChatGPT doesn't enter generating state, allow retry later.
    dispatchInProgressTimeoutId = setTimeout(() => {
      if (!dispatchInProgress) {
        dispatchInProgressTimeoutId = null;
        return;
      }

      const stillGenerating = checkGeneratingState();
      dispatchInProgress = false;
      dispatchInProgressTimeoutId = null;

      // If we already entered generating, this timeout is just a stale cleanup (don't warn).
      if (!stillGenerating) {
        logWarn('Dispatch attempt did not trigger generating; unlocking for retry');
      } else {
        logDebug('Dispatch lock cleanup while generating (no-op)');
      }
    }, 3000);
  }

  function clearDispatchInProgress(reason) {
    if (!dispatchInProgress && !dispatchInProgressTimeoutId) return;
    dispatchInProgress = false;
    if (dispatchInProgressTimeoutId) {
      clearTimeout(dispatchInProgressTimeoutId);
      dispatchInProgressTimeoutId = null;
    }
    if (reason) logDebug('Cleared dispatchInProgress', { reason });
  }

  function scheduleDispatch(reason) {
    if (dispatchTimeoutId) return;
    if (dispatchInProgress) return;
    if (messageQueue.length === 0) return;
    if (checkGeneratingState()) return;
    if (!document.querySelector(SELECTORS.textarea)) {
      logWarn('scheduleDispatch skipped: textarea not found', { reason, queueLength: messageQueue.length });
      return;
    }

    dispatchTimeoutId = setTimeout(() => {
      dispatchTimeoutId = null;
      if (dispatchInProgress) return;
      if (!checkGeneratingState() && messageQueue.length > 0) {
        logInfo('Dispatching from scheduler', { reason, queueLength: messageQueue.length });
        dispatchNextMessage();
      }
    }, dispatchDelay);
  }

  function refreshGeneratingStateAndMaybeDispatch(source) {
    const wasGenerating = isGenerating;
    const nowGenerating = checkGeneratingState();

    isGenerating = nowGenerating;

    if (queueUI) {
      queueUI.classList.toggle('generating', isGenerating);
    }
    updateQueueButton();

    if (wasGenerating !== nowGenerating) {
      logInfo('Generating state changed', {
        from: wasGenerating,
        to: nowGenerating,
        source,
        queueLength: messageQueue.length,
        conversationId,
        url: location.href
      });
    }

    // If a queued message was just dispatched, entering generating means the click/Enter "took".
    if (!wasGenerating && nowGenerating) {
      clearDispatchInProgress('entered_generating');
    }

    // If we miss the "generating -> idle" mutation (ChatGPT DOM changes / container replacement),
    // ensure we still drain the queue once idle.
    if (!isGenerating && messageQueue.length > 0) {
      scheduleDispatch(`idle(${source})`);
    }
  }

  // Extract conversation ID from URL
  function getConversationId() {
    const match = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : 'new';
  }

  // Load queue from localStorage
  function loadQueue() {
    const stored = localStorage.getItem(`chatgpt-queue-${conversationId}`);
    if (stored) {
      try {
        messageQueue = JSON.parse(stored);
      } catch (e) {
        messageQueue = [];
      }
    } else {
      messageQueue = [];
    }
    updateQueueUI();
    updateBadge();
    logInfo('Queue loaded', { conversationId, queueLength: messageQueue.length });
  }

  // Save queue to localStorage
  function saveQueue() {
    localStorage.setItem(`chatgpt-queue-${conversationId}`, JSON.stringify(messageQueue));
    updateBadge();
  }

  // Update extension badge with queue count
  function updateBadge() {
    try {
      chrome.runtime.sendMessage({
        type: 'updateBadge',
        count: messageQueue.length
      });
    } catch (e) {
      logWarn('Failed to update badge', e);
    }
  }

  // Check if ChatGPT is currently generating a response
  function checkGeneratingState() {
    const stopButton = document.querySelector(SELECTORS.stopButton);
    const textarea = document.querySelector(SELECTORS.textarea);

    // Check for stop button presence
    if (stopButton && stopButton.offsetParent !== null) {
      return true;
    }

    // Check for disabled textarea (sometimes used during generation)
    if (textarea && textarea.disabled) {
      return true;
    }

    // Check for streaming indicators in the DOM
    const streamingElements = document.querySelectorAll('[class*="streaming"], [class*="typing"], .result-streaming');
    if (streamingElements.length > 0) {
      return true;
    }

    return false;
  }

  // Create a DOM element safely
  function createElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent) el.textContent = textContent;
    return el;
  }

  // Create the queue button that appears next to the stop button during generation
  function createQueueButton() {
    if (queueButton) return;

    queueButton = createElement('button', 'chatgpt-queue-button', 'Queue');
    queueButton.id = 'chatgpt-queue-button';
    queueButton.title = 'Add to queue (will send after current response)';
    queueButton.style.display = 'none';

    queueButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const inputEl = document.querySelector(SELECTORS.textarea);
      if (inputEl) {
        const inputValue = getInputValue(inputEl);
        if (inputValue.trim()) {
          addToQueue(inputValue);
          clearInput(inputEl);
        }
      }
    });

    // Insert into the DOM - we'll position it with CSS
    document.body.appendChild(queueButton);
  }

  // Update queue button visibility and position
  function updateQueueButton() {
    if (!queueButton) return;

    const inputEl = document.querySelector(SELECTORS.textarea);
    const stopButton = document.querySelector(SELECTORS.stopButton);
    const inputValue = inputEl ? getInputValue(inputEl) : '';

    // Show button only when generating AND there's text in the input
    if (isGenerating && inputValue.trim() && stopButton) {
      // Position the button next to the stop button
      const stopRect = stopButton.getBoundingClientRect();
      queueButton.style.display = 'flex';
      queueButton.style.position = 'fixed';
      queueButton.style.top = `${stopRect.top + (stopRect.height / 2) - 16}px`;
      queueButton.style.left = `${stopRect.left - 80}px`;
      queueButton.style.zIndex = '10000';
    } else {
      queueButton.style.display = 'none';
    }
  }

  // Set up observer for input changes to show/hide queue button
  function setupInputObserver() {
    const inputEl = document.querySelector(SELECTORS.textarea);
    if (!inputEl) {
      setTimeout(setupInputObserver, 1000);
      return;
    }

    // Watch for input changes
    inputEl.addEventListener('input', updateQueueButton);
    inputEl.addEventListener('keyup', updateQueueButton);

    // Also use MutationObserver for contenteditable
    if (inputEl.getAttribute('contenteditable') === 'true') {
      inputObserver = new MutationObserver(updateQueueButton);
      inputObserver.observe(inputEl, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  }

  // Create and inject the queue UI into the page
  function createQueueUI() {
    if (queueUI) return;

    queueUI = document.createElement('div');
    queueUI.id = 'chatgpt-queue-container';

    // Build header
    const header = createElement('div', 'queue-header');
    const title = createElement('span', 'queue-title', 'Queued Messages');
    const count = createElement('span', 'queue-count', '0');
    const toggleBtn = createElement('button', 'queue-toggle', '▼');
    toggleBtn.title = 'Toggle queue';

    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(toggleBtn);

    // Build list container
    const list = createElement('div', 'queue-list');

    queueUI.appendChild(header);
    queueUI.appendChild(list);

    // Insert after the input form
    const insertQueue = () => {
      const form = document.querySelector(SELECTORS.inputForm);
      if (form && form.parentElement) {
        form.parentElement.insertBefore(queueUI, form.nextSibling);
        return true;
      }
      return false;
    };

    if (!insertQueue()) {
      // Retry insertion if form not found yet
      const retryInterval = setInterval(() => {
        if (insertQueue()) {
          clearInterval(retryInterval);
        }
      }, 500);
      setTimeout(() => clearInterval(retryInterval), 10000);
    }

    // Toggle queue visibility
    toggleBtn.addEventListener('click', () => {
      queueUI.classList.toggle('collapsed');
      toggleBtn.textContent = queueUI.classList.contains('collapsed') ? '▲' : '▼';
    });

    updateQueueUI();
  }

  // Helper to truncate text
  function truncate(text, maxLength) {
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  // Update the queue UI display
  function updateQueueUI() {
    if (!queueUI) {
      createQueueUI();
      return;
    }

    // Re-insert if removed from DOM
    if (!document.body.contains(queueUI)) {
      const form = document.querySelector(SELECTORS.inputForm);
      if (form && form.parentElement) {
        form.parentElement.insertBefore(queueUI, form.nextSibling);
      } else {
        document.body.appendChild(queueUI);
      }
    }

    const list = queueUI.querySelector('.queue-list');
    const count = queueUI.querySelector('.queue-count');

    count.textContent = messageQueue.length;

    // Clear existing items
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }

    // Hide the entire queue UI when empty
    if (messageQueue.length === 0) {
      queueUI.style.display = 'none';
      return;
    }

    // Show the queue UI when there are messages
    queueUI.style.display = 'block';

    messageQueue.forEach((msg, index) => {
      const item = createElement('div', 'queue-item');
      item.dataset.index = index;

      // Content section
      const content = createElement('div', 'queue-item-content');
      const number = createElement('span', 'queue-item-number', `${index + 1}.`);
      const text = createElement('span', 'queue-item-text', truncate(msg, 100));
      content.appendChild(number);
      content.appendChild(text);

      // Actions section
      const actions = createElement('div', 'queue-item-actions');

      const editBtn = createElement('button', 'queue-edit', '✏️');
      editBtn.title = 'Edit';
      editBtn.dataset.index = index;
      editBtn.addEventListener('click', () => editQueueItem(index));

      const deleteBtn = createElement('button', 'queue-delete', '🗑️');
      deleteBtn.title = 'Delete';
      deleteBtn.dataset.index = index;
      deleteBtn.addEventListener('click', () => removeFromQueue(index));

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      if (index > 0) {
        const moveUpBtn = createElement('button', 'queue-move-up', '↑');
        moveUpBtn.title = 'Move up';
        moveUpBtn.dataset.index = index;
        moveUpBtn.addEventListener('click', () => moveInQueue(index, index - 1));
        actions.appendChild(moveUpBtn);
      }

      if (index < messageQueue.length - 1) {
        const moveDownBtn = createElement('button', 'queue-move-down', '↓');
        moveDownBtn.title = 'Move down';
        moveDownBtn.dataset.index = index;
        moveDownBtn.addEventListener('click', () => moveInQueue(index, index + 1));
        actions.appendChild(moveDownBtn);
      }

      item.appendChild(content);
      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  // Add message to queue
  function addToQueue(message) {
    if (!message.trim()) return;
    messageQueue.push(message.trim());
    saveQueue();
    updateQueueUI();
    showNotification(`Message queued (${messageQueue.length} in queue)`);
    logInfo('Message queued', { conversationId, queueLength: messageQueue.length, preview: message.trim().slice(0, 80) });
  }

  // Remove message from queue
  function removeFromQueue(index) {
    if (index >= 0 && index < messageQueue.length) {
      const removed = messageQueue[index];
      messageQueue.splice(index, 1);
      saveQueue();
      updateQueueUI();
      logInfo('Removed queued message', { conversationId, index, queueLength: messageQueue.length, preview: (removed || '').slice(0, 80) });
    }
  }

  // Edit a queued message
  function editQueueItem(index) {
    const currentText = messageQueue[index];
    const newText = prompt('Edit queued message:', currentText);
    if (newText !== null && newText.trim()) {
      messageQueue[index] = newText.trim();
      saveQueue();
      updateQueueUI();
      logInfo('Edited queued message', { conversationId, index, queueLength: messageQueue.length });
    }
  }

  // Move message in queue
  function moveInQueue(fromIndex, toIndex) {
    if (toIndex >= 0 && toIndex < messageQueue.length) {
      const [item] = messageQueue.splice(fromIndex, 1);
      messageQueue.splice(toIndex, 0, item);
      saveQueue();
      updateQueueUI();
      logInfo('Moved queued message', { conversationId, fromIndex, toIndex, queueLength: messageQueue.length });
    }
  }

  // Show a brief notification
  function showNotification(message) {
    const notification = createElement('div', 'queue-notification', message);
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 2000);
  }

  // Helper to get input value (works with both textarea and contenteditable)
  function getInputValue(el) {
    if (!el) return '';
    // Check if it's a contenteditable element
    if (el.getAttribute('contenteditable') === 'true') {
      return el.textContent || el.innerText || '';
    }
    // Regular textarea/input
    return el.value || '';
  }

  // Helper to set input value (works with both textarea and contenteditable)
  function setInputValue(el, value) {
    if (!el) return false;

    // Focus the element first
    el.focus();

    // Check if it's a contenteditable element
    if (el.getAttribute('contenteditable') === 'true') {
      // For contenteditable, we need to use execCommand or simulate proper input
      // First clear the existing content
      el.innerHTML = '';

      // Try using execCommand (works in most browsers)
      try {
        document.execCommand('insertText', false, value);
      } catch (e) {
        // Fallback: set innerHTML with a paragraph wrapper like ChatGPT uses
        const p = document.createElement('p');
        p.textContent = value;
        el.appendChild(p);
      }

      // Dispatch multiple events to ensure React picks up the change
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // Regular textarea/input - use native setter to trigger React
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return true;
  }

  // Helper to clear input (works with both textarea and contenteditable)
  function clearInput(el) {
    if (!el) return;
    if (el.getAttribute('contenteditable') === 'true') {
      el.textContent = '';
      // For contenteditable, we may need to also clear innerHTML for proper reset
      el.innerHTML = '';
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Intercept message submission using event delegation
  function interceptSubmission() {
    // Use event delegation on document to handle dynamically recreated elements

    // Intercept form submission
    document.addEventListener('submit', (e) => {
      const form = e.target.closest(SELECTORS.inputForm);
      if (!form) return;

      const inputEl = document.querySelector(SELECTORS.textarea);
      if (!inputEl) return;

      const inputValue = getInputValue(inputEl);
      logDebug('Form submit intercepted', { isGenerating, preview: inputValue.substring(0, 50) });
      if (isGenerating && inputValue.trim()) {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(inputValue);
        clearInput(inputEl);
        return false;
      }
    }, true);

    // Intercept Enter key using document-level delegation
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;

      const inputEl = document.querySelector(SELECTORS.textarea);
      if (!inputEl) return;

      // Check if the event target is within the textarea
      if (!inputEl.contains(e.target) && e.target !== inputEl) return;

      const inputValue = getInputValue(inputEl);
      logDebug('Enter key pressed', { isGenerating, preview: inputValue.substring(0, 50) });
      if (isGenerating && inputValue.trim()) {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(inputValue);
        clearInput(inputEl);
        return false;
      }
    }, true);

    // Intercept send button click using delegation
    document.addEventListener('click', (e) => {
      const sendButton = e.target.closest(SELECTORS.sendButton);
      if (!sendButton) return;

      const inputEl = document.querySelector(SELECTORS.textarea);
      if (!inputEl) return;

      const inputValue = getInputValue(inputEl);
      logDebug('Send button clicked', { isGenerating, preview: inputValue.substring(0, 50) });
      if (isGenerating && inputValue.trim()) {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(inputValue);
        clearInput(inputEl);
        return false;
      }
    }, true);

    logInfo('Submission interception set up (event delegation)');
  }

  // Send the next queued message
  function dispatchNextMessage() {
    if (messageQueue.length === 0 || isGenerating || dispatchInProgress) return;

    const queueLengthBefore = messageQueue.length;
    const message = messageQueue.shift();
    saveQueue();
    updateQueueUI();

    const inputEl = document.querySelector(SELECTORS.textarea);

    if (!inputEl) {
      logError('Input element not found for dispatch', { conversationId, queueLength: messageQueue.length });
      // Put message back at front of queue
      messageQueue.unshift(message);
      saveQueue();
      updateQueueUI();
      showNotification('Failed to send - input not found');
      return;
    }

    // Save any text the user is currently typing
    const userDraftText = getInputValue(inputEl);
    if (userDraftText.trim()) {
      logDebug('Saving user draft', { preview: userDraftText.substring(0, 50) });
    }

    logInfo('Dispatching queued message', {
      conversationId,
      queueLengthBefore,
      queueLengthAfter: messageQueue.length,
      preview: message.substring(0, 80)
    });

    // Set the input value
    setInputValue(inputEl, message);

    // Function to restore user's draft after message is sent
    const restoreUserDraft = () => {
      if (userDraftText.trim()) {
        // Wait a moment for ChatGPT to start generating, then restore
        setTimeout(() => {
          const currentInput = document.querySelector(SELECTORS.textarea);
          if (currentInput) {
            // Only restore if the input is now empty (message was sent)
            const currentValue = getInputValue(currentInput);
            if (!currentValue.trim()) {
              logDebug('Restoring user draft');
              setInputValue(currentInput, userDraftText);
            }
          }
        }, 500);
      }
    };

    // Wait for React to process the input, then try to send
    setTimeout(() => {
      // Check if the input has the text
      const currentValue = getInputValue(inputEl);
      logDebug('Input value after setting', { preview: currentValue.substring(0, 50), length: currentValue.length });

      const currentSendButton = document.querySelector(SELECTORS.sendButton);
      logDebug('Send button state', { found: !!currentSendButton, disabled: !!currentSendButton?.disabled });

      if (currentSendButton && !currentSendButton.disabled) {
        markDispatchInProgress();
        currentSendButton.click();
        logInfo('Clicked send button for queued message');
        showNotification(`Sent queued message (${messageQueue.length} remaining)`);
        restoreUserDraft();
      } else {
        // Wait a bit more and try again
        setTimeout(() => {
          const retryButton = document.querySelector(SELECTORS.sendButton);
          if (retryButton && !retryButton.disabled) {
            markDispatchInProgress();
            retryButton.click();
            logInfo('Clicked send button for queued message (retry)');
            showNotification(`Sent queued message (${messageQueue.length} remaining)`);
            restoreUserDraft();
          } else {
            // Try pressing Enter as last resort
            logWarn('Send button unavailable; trying Enter key fallback');
            markDispatchInProgress();
            inputEl.focus();
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true
            }));
            showNotification(`Sent queued message (${messageQueue.length} remaining)`);
            restoreUserDraft();
          }
        }, 300);
      }
    }, 200);
  }

  // Set up MutationObserver to detect state changes
  function setupObserver() {
    const container = document.querySelector(SELECTORS.chatContainer);
    if (!container) {
      logWarn('Chat container not found, retrying...');
      setTimeout(setupObserver, 1000);
      return;
    }

    if (observer && observedContainer === container) {
      return;
    }

    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        // ignore
      }
      observer = null;
      observedContainer = null;
    }

    observer = new MutationObserver((mutations) => {
      refreshGeneratingStateAndMaybeDispatch('mutation');
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-label', 'class']
    });

    observedContainer = container;
    logInfo('Observer set up', { chatContainerSelector: SELECTORS.chatContainer });
  }

  // Handle URL changes (conversation switches)
  function handleUrlChange() {
    const newConversationId = getConversationId();
    if (newConversationId !== conversationId) {
      const oldConversationId = conversationId;
      conversationId = newConversationId;
      loadQueue();
      refreshGeneratingStateAndMaybeDispatch('url');
      logInfo('Switched conversation', { from: oldConversationId, to: conversationId, url: location.href });
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getQueue') {
      sendResponse({
        queue: messageQueue,
        conversationId: conversationId,
        isGenerating: isGenerating
      });
    } else if (message.type === 'clearQueue') {
      messageQueue = [];
      saveQueue();
      updateQueueUI();
      sendResponse({ success: true });
    } else if (message.type === 'removeFromQueue') {
      removeFromQueue(message.index);
      sendResponse({ success: true });
    } else if (message.type === 'editQueueItem') {
      if (message.index >= 0 && message.index < messageQueue.length) {
        messageQueue[message.index] = message.text;
        saveQueue();
        updateQueueUI();
        sendResponse({ success: true });
      }
    }
    return true;
  });

  // Initialize
  function init() {
    logInfo('Initializing...', { url: location.href });

    conversationId = getConversationId();
    loadQueue();

    // Initial state check
    isGenerating = checkGeneratingState();

    // Set up components
    createQueueUI();
    createQueueButton();
    interceptSubmission();
    setupObserver();
    setupInputObserver();

    // Fallback: poll state to avoid missing DOM transitions (SPA container replacement, etc.)
    if (!fallbackPollerId) {
      fallbackPollerId = setInterval(() => {
        const currentContainer = document.querySelector(SELECTORS.chatContainer);
        if (currentContainer && currentContainer !== observedContainer) {
          logWarn('Chat container changed; re-attaching observer');
          setupObserver();
        }
        refreshGeneratingStateAndMaybeDispatch('poll');
      }, 1000);
    }

    // If we're already idle (e.g. page refreshed), still drain the queue.
    refreshGeneratingStateAndMaybeDispatch('init');

    // Watch for URL changes (SPA navigation)
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        handleUrlChange();
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Also listen for popstate (back/forward)
    window.addEventListener('popstate', handleUrlChange);

    logInfo('Initialized', { conversationId, isGenerating, queueLength: messageQueue.length });
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure ChatGPT's JS has loaded
    setTimeout(init, 1000);
  }
})();
