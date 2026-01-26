// ChatGPT Message Queue - Popup Script

const contentEl = document.getElementById('content');

// Truncate text helper
function truncate(text, maxLength) {
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

// Create element helper
function createElement(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent) el.textContent = textContent;
  return el;
}

// Clear element children
function clearElement(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// Render the popup UI
function render(data) {
  clearElement(contentEl);

  if (!data) {
    const notOnChatGPT = createElement('div', 'not-on-chatgpt');
    const p = createElement('p');
    p.textContent = 'Open ';
    const link = createElement('a');
    link.href = 'https://chatgpt.com';
    link.target = '_blank';
    link.textContent = 'chatgpt.com';
    p.appendChild(link);
    p.appendChild(document.createTextNode(' to use this extension'));
    notOnChatGPT.appendChild(p);
    contentEl.appendChild(notOnChatGPT);
    return;
  }

  const { queue, conversationId, isGenerating } = data;

  // Header
  const header = createElement('div', 'header');
  const h1 = createElement('h1', null, 'Message Queue');
  const status = createElement('span', `status ${isGenerating ? 'generating' : 'idle'}`);
  status.textContent = isGenerating ? 'Generating...' : 'Idle';
  header.appendChild(h1);
  header.appendChild(status);
  contentEl.appendChild(header);

  // Conversation ID
  const convIdEl = createElement('div', 'conversation-id');
  convIdEl.textContent = `Conversation: ${conversationId === 'new' ? 'New chat' : conversationId.substring(0, 8) + '...'}`;
  contentEl.appendChild(convIdEl);

  // Queue list or empty state
  if (queue.length === 0) {
    const emptyState = createElement('div', 'empty-state');
    const emptyP = createElement('p', null, 'No messages queued');
    const emptySmall = createElement('small', null, 'Send a message while ChatGPT is generating to queue it');
    emptyState.appendChild(emptyP);
    emptyState.appendChild(emptySmall);
    contentEl.appendChild(emptyState);
  } else {
    const queueList = createElement('div', 'queue-list');

    queue.forEach((msg, index) => {
      const item = createElement('div', 'queue-item');
      item.dataset.index = index;

      const number = createElement('span', 'queue-item-number', `${index + 1}.`);

      const content = createElement('div', 'queue-item-content');
      const text = createElement('div', 'queue-item-text', truncate(msg, 150));
      content.appendChild(text);

      const actions = createElement('div', 'queue-item-actions');

      const editBtn = createElement('button', 'edit-btn', '✏️');
      editBtn.dataset.index = index;
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', async () => {
        const currentText = queue[index];
        const newText = prompt('Edit queued message:', currentText);
        if (newText !== null && newText.trim()) {
          await sendToContentScript({ type: 'editQueueItem', index, text: newText.trim() });
          loadQueue();
        }
      });

      const deleteBtn = createElement('button', 'delete-btn', '🗑️');
      deleteBtn.dataset.index = index;
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        await sendToContentScript({ type: 'removeFromQueue', index });
        loadQueue();
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(number);
      item.appendChild(content);
      item.appendChild(actions);
      queueList.appendChild(item);
    });

    contentEl.appendChild(queueList);
  }

  // Actions
  const actionsDiv = createElement('div', 'actions');
  const clearBtn = createElement('button', 'clear-btn', 'Clear Queue');
  if (queue.length === 0) {
    clearBtn.disabled = true;
  }
  clearBtn.addEventListener('click', async () => {
    if (confirm('Clear all queued messages?')) {
      await sendToContentScript({ type: 'clearQueue' });
      loadQueue();
    }
  });
  actionsDiv.appendChild(clearBtn);
  contentEl.appendChild(actionsDiv);
}

// Send message to content script
async function sendToContentScript(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('chatgpt.com')) {
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    console.error('Failed to send message:', e);
    return null;
  }
}

// Load queue from content script
async function loadQueue() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url?.includes('chatgpt.com')) {
    render(null);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'getQueue' });
    render(response);
  } catch (e) {
    console.error('Failed to get queue:', e);
    render(null);
  }
}

// Initialize
loadQueue();
