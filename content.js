// ChatGPT Message Queue - Content Script
// Handles detection, interception, queue management, and auto-dispatch

(function() {
  'use strict';

  // State
  let messageQueue = [];
  let isGenerating = false;
  let conversationId = null;
  let observer = null;
  let queueUI = null;
  let queueButton = null;
  let inputObserver = null;
  let dispatchDelay = 500; // ms delay before sending next message

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
  }

  // Save queue to localStorage
  function saveQueue() {
    localStorage.setItem(`chatgpt-queue-${conversationId}`, JSON.stringify(messageQueue));
    updateBadge();
  }

  // Update extension badge with queue count
  function updateBadge() {
    chrome.runtime.sendMessage({
      type: 'updateBadge',
      count: messageQueue.length
    });
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
    if (!queueUI) return;

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
  }

  // Remove message from queue
  function removeFromQueue(index) {
    if (index >= 0 && index < messageQueue.length) {
      messageQueue.splice(index, 1);
      saveQueue();
      updateQueueUI();
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
    }
  }

  // Move message in queue
  function moveInQueue(fromIndex, toIndex) {
    if (toIndex >= 0 && toIndex < messageQueue.length) {
      const [item] = messageQueue.splice(fromIndex, 1);
      messageQueue.splice(toIndex, 0, item);
      saveQueue();
      updateQueueUI();
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

  // Intercept message submission
  function interceptSubmission() {
    const form = document.querySelector(SELECTORS.inputForm);
    const inputEl = document.querySelector(SELECTORS.textarea);
    const sendButton = document.querySelector(SELECTORS.sendButton);

    if (!form || !inputEl) {
      console.log('[ChatGPT Queue] Form or input not found, retrying...');
      setTimeout(interceptSubmission, 1000);
      return;
    }

    console.log('[ChatGPT Queue] Input element type:', inputEl.tagName, 'contenteditable:', inputEl.getAttribute('contenteditable'));

    // Intercept form submission
    form.addEventListener('submit', (e) => {
      const inputValue = getInputValue(inputEl);
      console.log('[ChatGPT Queue] Form submit intercepted, isGenerating:', isGenerating, 'value:', inputValue.substring(0, 50));
      if (isGenerating && inputValue.trim()) {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(inputValue);
        clearInput(inputEl);
        return false;
      }
    }, true);

    // Intercept Enter key on the input element
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const inputValue = getInputValue(inputEl);
        console.log('[ChatGPT Queue] Enter key pressed, isGenerating:', isGenerating, 'value:', inputValue.substring(0, 50));
        if (isGenerating && inputValue.trim()) {
          e.preventDefault();
          e.stopPropagation();
          addToQueue(inputValue);
          clearInput(inputEl);
          return false;
        }
      }
    }, true);

    // Intercept send button click
    if (sendButton) {
      sendButton.addEventListener('click', (e) => {
        const inputValue = getInputValue(inputEl);
        console.log('[ChatGPT Queue] Send button clicked, isGenerating:', isGenerating, 'value:', inputValue.substring(0, 50));
        if (isGenerating && inputValue.trim()) {
          e.preventDefault();
          e.stopPropagation();
          addToQueue(inputValue);
          clearInput(inputEl);
          return false;
        }
      }, true);
    }

    console.log('[ChatGPT Queue] Submission interception set up');
  }

  // Send the next queued message
  function dispatchNextMessage() {
    if (messageQueue.length === 0 || isGenerating) return;

    const message = messageQueue.shift();
    saveQueue();
    updateQueueUI();

    const inputEl = document.querySelector(SELECTORS.textarea);

    if (!inputEl) {
      console.error('[ChatGPT Queue] Input element not found for dispatch');
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
      console.log('[ChatGPT Queue] Saving user draft:', userDraftText.substring(0, 50));
    }

    console.log('[ChatGPT Queue] Dispatching message:', message.substring(0, 50));

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
              console.log('[ChatGPT Queue] Restoring user draft');
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
      console.log('[ChatGPT Queue] Input value after setting:', currentValue.substring(0, 50));

      const currentSendButton = document.querySelector(SELECTORS.sendButton);
      console.log('[ChatGPT Queue] Send button found:', !!currentSendButton, 'disabled:', currentSendButton?.disabled);

      if (currentSendButton && !currentSendButton.disabled) {
        currentSendButton.click();
        console.log('[ChatGPT Queue] Clicked send button');
        showNotification(`Sent queued message (${messageQueue.length} remaining)`);
        restoreUserDraft();
      } else {
        // Wait a bit more and try again
        setTimeout(() => {
          const retryButton = document.querySelector(SELECTORS.sendButton);
          if (retryButton && !retryButton.disabled) {
            retryButton.click();
            console.log('[ChatGPT Queue] Clicked send button (retry)');
            showNotification(`Sent queued message (${messageQueue.length} remaining)`);
            restoreUserDraft();
          } else {
            // Try pressing Enter as last resort
            console.log('[ChatGPT Queue] Trying Enter key as fallback');
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
      console.log('[ChatGPT Queue] Chat container not found, retrying...');
      setTimeout(setupObserver, 1000);
      return;
    }

    observer = new MutationObserver((mutations) => {
      const wasGenerating = isGenerating;
      isGenerating = checkGeneratingState();

      // State changed from generating to idle
      if (wasGenerating && !isGenerating) {
        console.log('[ChatGPT Queue] Response complete, checking queue...');
        // Delay before dispatching to ensure UI is ready
        setTimeout(() => {
          if (!checkGeneratingState() && messageQueue.length > 0) {
            dispatchNextMessage();
          }
        }, dispatchDelay);
      }

      // Update UI to show current state
      if (queueUI) {
        queueUI.classList.toggle('generating', isGenerating);
      }

      // Update queue button visibility
      updateQueueButton();
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-label', 'class']
    });

    console.log('[ChatGPT Queue] Observer set up');
  }

  // Handle URL changes (conversation switches)
  function handleUrlChange() {
    const newConversationId = getConversationId();
    if (newConversationId !== conversationId) {
      conversationId = newConversationId;
      loadQueue();
      console.log(`[ChatGPT Queue] Switched to conversation: ${conversationId}`);
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
    console.log('[ChatGPT Queue] Initializing...');

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

    console.log('[ChatGPT Queue] Initialized for conversation:', conversationId);
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure ChatGPT's JS has loaded
    setTimeout(init, 1000);
  }
})();
